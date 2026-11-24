#!/usr/bin/env node

/**
 * Dead-symlink guard for this checkout's `node_modules` trees.
 *
 * `syncIgnoredPathsIntoWorktree` (src/workspace/task-worktree.ts) mirrors each
 * task worktree's `node_modules` into this checkout as a single directory
 * symlink, so a `pnpm install` run *inside* a worktree rewrites entries here
 * with worktree-relative link text, for example
 * `node_modules/<pkg> -> ../../../.cline/worktrees/<id>/kanban/node_modules/...`.
 * Those links resolve while the worktree exists and die with it, and the
 * breakage only surfaces on the next restart. This script is the guard.
 *
 * Design constraints:
 * - Node built-ins only and no subprocesses, so it behaves the same on Windows.
 * - Never deletes anything: `--fix` replaces one symlink at a time.
 * - Never traverses into a symlinked directory, and skips a `node_modules`
 *   tree that is itself a symlink (provisioned worktree case): that path points
 *   at another checkout's install, which is shared by every worktree.
 *
 * Usage:
 *   node scripts/check-symlinks.mjs [--fix] [--json] [--root <dir>]
 *
 * Exit codes:
 *   0  no dead links (or `--fix` repaired everything it could)
 *   1  dead links found in report-only mode
 *   2  `--fix` ran but unfixable (or unrepairable) links remain
 */

import { lstat, readdir, readlink, stat, symlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const NODE_MODULES_DIRNAME = "node_modules";
const WORKTREE_LINK_MARKER = "kanban/node_modules/";
/** Bounded fan-out: this repo has ~70k node_modules entries, stats are cheap. */
const STAT_CONCURRENCY = 32;
const SKIPPED_DIRECTORY_NAMES = new Set([".git"]);

class UsageError extends Error {}

function parseArguments(argv) {
	const options = { fix: false, json: false, root: DEFAULT_ROOT, help: false };

	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];

		if (argument === "--fix") {
			options.fix = true;
			continue;
		}
		if (argument === "--json") {
			options.json = true;
			continue;
		}
		if (argument === "--help" || argument === "-h") {
			options.help = true;
			continue;
		}
		if (argument === "--root") {
			const value = argv[index + 1];
			if (!value) {
				throw new UsageError("--root requires a directory");
			}
			options.root = resolve(value);
			index += 1;
			continue;
		}
		if (argument.startsWith("--root=")) {
			const value = argument.slice("--root=".length);
			if (!value) {
				throw new UsageError("--root requires a directory");
			}
			options.root = resolve(value);
			continue;
		}

		throw new UsageError(`unknown argument: ${argument}`);
	}

	return options;
}

/** Minimal promise-pool limiter so thousands of stats stay bounded. */
function createLimiter(concurrency) {
	let active = 0;
	let cursor = 0;
	const queue = [];

	const startNext = () => {
		while (active < concurrency && cursor < queue.length) {
			const { task, resolve: resolveTask, reject: rejectTask } = queue[cursor];
			queue[cursor] = undefined;
			cursor += 1;
			active += 1;
			task()
				.then(resolveTask, rejectTask)
				.finally(() => {
					active -= 1;
					startNext();
				});
		}
	};

	return (task) =>
		new Promise((resolveTask, rejectTask) => {
			queue.push({ task, resolve: resolveTask, reject: rejectTask });
			startNext();
		});
}

/** Stable, platform-independent paths in output. */
function toPosix(path) {
	return sep === "/" ? path : path.split(sep).join("/");
}

/** `stat`, not `lstat`: a symlink only counts when its target exists. */
function resolves(path) {
	return stat(path).then(
		() => true,
		() => false,
	);
}

function resolvesWithLimit(path, limiter) {
	return limiter(() => resolves(path));
}

/**
 * Resolve a worktree-style link target to the matching entry in this
 * checkout's `node_modules`. Returns `null` when the link cannot be repaired
 * without a fresh install.
 */
async function resolveFixTarget(target, root, limiter) {
	const normalizedTarget = target.split("\\").join("/");
	const markerIndex = normalizedTarget.indexOf(WORKTREE_LINK_MARKER);
	if (markerIndex === -1) {
		return null;
	}

	const suffix = normalizedTarget.slice(markerIndex + WORKTREE_LINK_MARKER.length).replace(/^\/+/, "");
	if (!suffix) {
		return null;
	}

	const localStore = join(root, NODE_MODULES_DIRNAME);
	const candidate = resolve(localStore, suffix);
	// Guard against traversal: a repaired link must stay inside the local store.
	if (candidate !== localStore && !candidate.startsWith(`${localStore}${sep}`)) {
		return null;
	}

	return (await resolvesWithLimit(candidate, limiter)) ? candidate : null;
}

async function inspectSymlink(linkPath, state) {
	const target = await readlink(linkPath).catch(() => null);
	if (target === null) {
		state.warnings.push(`could not read link ${toPosix(relative(state.root, linkPath))}`);
		return;
	}

	if (await resolvesWithLimit(linkPath, state.limit)) {
		return;
	}

	state.dead.push({
		path: linkPath,
		link: toPosix(relative(state.root, linkPath)),
		target,
		fixTarget: await resolveFixTarget(target, state.root, state.limit),
	});
}

async function scanEntry(entryPath, dirent, state) {
	let isSymbolicLink = dirent.isSymbolicLink();
	let isDirectory = dirent.isDirectory();

	// A directory entry is typed without following links, which is the same
	// semantics as `lstat`. Filesystems that report DT_UNKNOWN for every entry
	// return neither flag, so fall back to a real `lstat` there.
	if (!isSymbolicLink && !isDirectory && !dirent.isFile()) {
		const entryStats = await state.limit(() => lstat(entryPath)).catch(() => null);
		if (!entryStats) {
			return;
		}
		isSymbolicLink = entryStats.isSymbolicLink();
		isDirectory = entryStats.isDirectory();
	}

	state.stats.entries += 1;

	if (isSymbolicLink) {
		state.stats.links += 1;
		await inspectSymlink(entryPath, state);
		return;
	}

	// Never traverse into symlinked directories: the branch above already
	// decided whether the link itself is dead.
	if (isDirectory) {
		await scanTree(entryPath, state);
	}
}

async function scanTree(directory, state) {
	let dirents;
	try {
		dirents = await state.limit(() => readdir(directory, { withFileTypes: true }));
	} catch (error) {
		// An entry can vanish mid-scan when an install runs concurrently.
		if (error.code !== "ENOENT") {
			state.warnings.push(`could not read ${toPosix(relative(state.root, directory))}: ${error.message}`);
		}
		return;
	}

	await Promise.all(
		dirents.map(async (dirent) => {
			if (SKIPPED_DIRECTORY_NAMES.has(dirent.name)) {
				return;
			}
			await scanEntry(join(directory, dirent.name), dirent, state);
		}),
	);
}

async function listScanRoots(root, limiter) {
	const candidates = [join(root, NODE_MODULES_DIRNAME), join(root, "web-ui", NODE_MODULES_DIRNAME)];

	const packagesDirectory = join(root, "packages");
	const packageNames = await readdir(packagesDirectory).catch(() => []);
	for (const packageName of packageNames) {
		const packagePath = join(packagesDirectory, packageName);
		const packageStats = await limiter(() => lstat(packagePath).catch(() => null));
		if (packageStats?.isDirectory()) {
			candidates.push(join(packagePath, NODE_MODULES_DIRNAME));
		}
	}

	return candidates;
}

async function scanRoot(candidate, state) {
	const rootStats = await lstat(candidate).catch(() => null);
	if (!rootStats) {
		return;
	}

	const displayPath = toPosix(relative(state.root, candidate));

	// A symlinked `node_modules` belongs to another checkout (provisioned
	// worktree) and is shared by every worktree there. Report, never modify.
	if (rootStats.isSymbolicLink()) {
		const target = await readlink(candidate).catch(() => "?");
		state.skipped.push({ path: displayPath, target });
		return;
	}

	if (!rootStats.isDirectory()) {
		return;
	}

	state.scanned.push(displayPath);
	await scanTree(candidate, state);
}

async function createSymlink(linkPath, target) {
	if (process.platform !== "win32") {
		// Keep links relative like pnpm's own, so the checkout stays movable.
		await symlink(isAbsolute(target) ? relative(dirname(linkPath), target) : target, linkPath);
		return;
	}

	// Windows needs an absolute target for junctions and cannot use them for files.
	const absoluteTarget = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
	const targetStats = await stat(absoluteTarget).catch(() => null);
	await symlink(absoluteTarget, linkPath, targetStats?.isDirectory() ? "junction" : "file");
}

async function relink(linkPath, entry) {
	await unlink(linkPath);
	try {
		await createSymlink(linkPath, entry.fixTarget);
		if (!(await resolves(linkPath))) {
			throw new Error("relinked entry still does not resolve");
		}
	} catch (error) {
		// Put the original link back rather than leaving a hole in node_modules.
		await createSymlink(linkPath, entry.target).catch(() => {});
		throw error;
	}
}

async function runScan(options) {
	const limiter = createLimiter(STAT_CONCURRENCY);
	const state = {
		root: options.root,
		limit: limiter,
		scanned: [],
		skipped: [],
		warnings: [],
		dead: [],
		fixed: [],
		failures: [],
		stats: { entries: 0, links: 0 },
	};

	for (const candidate of await listScanRoots(options.root, limiter)) {
		await scanRoot(candidate, state);
	}

	if (options.fix) {
		for (const entry of state.dead) {
			if (!entry.fixTarget) {
				continue;
			}
			try {
				await relink(entry.path, entry);
				state.fixed.push({ link: entry.link, resolved: toPosix(relative(state.root, entry.fixTarget)) });
			} catch (error) {
				state.failures.push({ link: entry.link, target: entry.target, error: error.message });
			}
		}
	}

	return {
		root: state.root,
		scanned: state.scanned,
		skipped: state.skipped,
		warnings: state.warnings,
		dead: state.dead,
		fixed: state.fixed,
		failures: state.failures,
		stats: state.stats,
	};
}

function summarize(report) {
	const fixable = report.dead.filter((entry) => entry.fixTarget !== null).length;
	const unfixable = report.dead.length - fixable;
	return {
		dead: report.dead.length,
		fixable,
		unfixable,
		fixed: report.fixed.length,
		remaining: unfixable + report.failures.length,
	};
}

function exitCodeFor(report, options) {
	if (report.dead.length === 0) {
		return 0;
	}
	if (!options.fix) {
		return 1;
	}
	return summarize(report).remaining > 0 ? 2 : 0;
}

function printReport(report, options) {
	for (const entry of report.dead) {
		console.log(`${entry.link} -> ${entry.target}`);
	}
	for (const entry of report.fixed) {
		console.log(`fixed ${entry.link} -> ${entry.resolved}`);
	}
	for (const entry of report.failures) {
		console.error(`failed to relink ${entry.link}: ${entry.error}`);
	}
	for (const skip of report.skipped) {
		console.error(
			`warning: skipping ${skip.path}: it is a symlink (-> ${skip.target}); refusing to scan a shared install`,
		);
	}
	for (const warning of report.warnings) {
		console.error(`warning: ${warning}`);
	}

	const { entries, links } = report.stats;
	const summary = summarize(report);

	if (summary.dead === 0) {
		const skippedTrees = report.skipped.length > 0 ? `, ${report.skipped.length} symlinked tree(s) skipped` : "";
		console.log(
			`no dead symlinks in ${report.scanned.length} node_modules tree(s)${skippedTrees} (${entries} entries, ${links} symlinks)`,
		);
		return;
	}

	console.log(`dead links: ${summary.dead} (fixable: ${summary.fixable}, unfixable: ${summary.unfixable})`);

	if (options.fix) {
		console.log(`fixed: ${summary.fixed} (remaining: ${summary.remaining})`);
		if (summary.remaining > 0) {
			console.error("unfixable links need `pnpm install --frozen-lockfile` in this checkout.");
		}
		return;
	}

	console.log(
		"run `pnpm run check:links -- --fix` to relink entries that resolve inside this checkout's node_modules.",
	);
}

function buildJsonReport(report) {
	return {
		root: report.root,
		scanned: report.scanned,
		skipped: report.skipped,
		entries: report.stats.entries,
		symlinks: report.stats.links,
		dead: report.dead.map((entry) => ({
			link: entry.link,
			target: entry.target,
			fixable: entry.fixTarget !== null,
			resolved: entry.fixTarget ? toPosix(relative(report.root, entry.fixTarget)) : null,
		})),
		fixed: report.fixed,
		failures: report.failures,
		summary: summarize(report),
	};
}

function printUsage() {
	console.log(
		[
			"Usage: node scripts/check-symlinks.mjs [--fix] [--json] [--root <dir>]",
			"",
			"  --fix      relink fixable dead links instead of only reporting them",
			"  --json     emit a machine-readable report on stdout",
			"  --root     checkout root to scan (defaults to this repository)",
			"",
			"Exit codes: 0 clean, 1 dead links found, 2 --fix left unfixable links",
		].join("\n"),
	);
}

async function main(argv) {
	let options;
	try {
		options = parseArguments(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(`check-symlinks: ${error.message}`);
			console.error("run `node scripts/check-symlinks.mjs --help` for usage");
			return 2;
		}
		throw error;
	}

	if (options.help) {
		printUsage();
		return 0;
	}

	const rootStats = await lstat(options.root).catch(() => null);
	if (!rootStats?.isDirectory()) {
		console.error(`check-symlinks: ${options.root} is not a directory`);
		return 2;
	}

	const report = await runScan(options);

	if (options.json) {
		console.log(JSON.stringify(buildJsonReport(report), null, 2));
	} else {
		printReport(report, options);
	}

	return exitCodeFor(report, options);
}

process.exitCode = await main(process.argv.slice(2));
