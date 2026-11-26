#!/usr/bin/env node

/**
 * Install guard for Kanban task worktrees.
 *
 * `syncIgnoredPathsIntoWorktree` (src/workspace/task-worktree.ts) gives every
 * task worktree a `node_modules` directory symlink to the main checkout's
 * install. When pnpm runs *inside* that worktree it resolves packages through
 * the symlink but writes each link's relative target using the worktree as its
 * project root, so the main checkout ends up with entries like
 * `node_modules/ms -> ../.cline/worktrees/<id>/kanban/node_modules/.pnpm/...`.
 * Those links resolve while the worktree exists and break the main checkout's
 * next build (`ERR_MODULE_NOT_FOUND`, e.g. `node-pty`) once Kanban deletes it.
 *
 * This script is wired in as the workspace root's `preinstall` script. It
 * refuses such an install instead of letting the damage land silently.
 *
 * Verified against pnpm 12.21.0:
 * - `pnpm install` and `pnpm add` run the workspace-root `preinstall` whenever
 *   they actually perform an install, including when invoked from a workspace
 *   subdirectory such as `web-ui/`. pnpm sets `INIT_CWD`, `PWD` and cwd to the
 *   workspace root in that case, which is already inside the worktree.
 * - The root `preinstall` runs *before* pnpm creates or relinks
 *   `node_modules`, so a blocked install leaves the shared tree untouched (the
 *   worktree's own `pnpm-lock.yaml` may already have been written).
 * - A true no-op `pnpm install` / `pnpm add` ("Already up to date") skips
 *   lifecycle scripts; it also does no relinking, so there is nothing to guard.
 *
 * Known gaps - these do NOT fire `preinstall`, so they can still rewrite the
 * shared install if run inside a task worktree:
 * - `pnpm rebuild`, `pnpm approve` / `pnpm approve-builds`, direct `node-gyp`,
 *   and `electron-builder install-app-deps`.
 * - `--ignore-scripts` (and any other lifecycle-script bypass), for example
 *   `pnpm install --ignore-scripts`.
 * `node scripts/check-symlinks.mjs` (wired into `pnpm run check` as
 * `check:links`) stays the backstop for all of them. Note that it only reports
 * links that no longer resolve, so worktree-relative links that still resolve
 * can be found early with
 * `find <checkout>/node_modules <checkout>/web-ui/node_modules -type l -lname '*worktrees*'`.
 *
 * Escape hatch: `KANBAN_ALLOW_WORKTREE_INSTALL=1` allows the install and warns
 * that the shared links must be repaired afterwards.
 *
 * The published tarball carries this script so `preinstall` can run for
 * `npx kanban` / `npm i -g kanban`, but it does not carry
 * `pnpm-workspace.yaml`. Enforcement is therefore limited to a Kanban source
 * checkout; in a published install the guard is a quiet no-op, so consumers
 * are never blocked by their own `.cline/worktrees` paths.
 *
 * Usage:
 *   node scripts/guard-worktree-install.mjs
 *
 * Exit codes:
 *   0  allowed (including the escape hatch)
 *   1  blocked: an invocation directory is inside `.cline/worktrees/<id>`
 */

import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ALLOW_ENV_VAR = "KANBAN_ALLOW_WORKTREE_INSTALL";
/** `.cline/worktrees/<id>` - the marker is the pair, the id proves it is a worktree. */
const WORKTREE_MARKER_SEGMENTS = [".cline", "worktrees"];

/**
 * Windows filesystems are case-insensitive and accept either separator.
 * POSIX paths are case-sensitive, so `.CLINE` is a different directory there.
 *
 * @param {string} path
 * @returns {string}
 */
function forComparison(path) {
	const withForwardSlashes = path.replace(/\\/g, "/");
	return process.platform === "win32" ? withForwardSlashes.toLowerCase() : withForwardSlashes;
}

/**
 * Pure predicate: true when any candidate path is a `.cline/worktrees/<id>`
 * location or anything nested inside one.
 *
 * Exported for unit tests; it reads no environment and touches no filesystem
 * state, so tests never need to spawn a process.
 *
 * @param {string[]} paths
 * @returns {boolean}
 */
export function isInsideTaskWorktree(paths) {
	const marker = WORKTREE_MARKER_SEGMENTS.map((segment) => forComparison(segment));

	return paths.some((path) => {
		if (typeof path !== "string" || path.length === 0) {
			return false;
		}

		const segments = forComparison(path).split("/");
		for (let index = 0; index < segments.length - marker.length; index += 1) {
			const matchesMarker = marker.every((segment, offset) => segments[index + offset] === segment);
			// A bare `.cline/worktrees` is not enough: the worktree id must be there.
			if (matchesMarker && segments[index + marker.length]) {
				return true;
			}
		}

		return false;
	});
}

/**
 * pnpm versions and invocation styles disagree about which of these carries the
 * directory the user actually ran the command from, so all three are checked.
 * pnpm 12 normalises all three to the workspace root for lifecycle scripts.
 *
 * @returns {Array<{ source: string; path: string }>}
 */
function collectInvocationDirectories() {
	return [
		{ source: "INIT_CWD", path: process.env.INIT_CWD },
		{ source: "PWD", path: process.env.PWD },
		{ source: "process.cwd()", path: process.cwd() },
	].filter((candidate) => typeof candidate.path === "string" && candidate.path.length > 0);
}

/** Collapse the three sources into unique `source: path` lines for the message. */
function describeBlockedDirectories(blocked) {
	const seen = new Set();
	const lines = [];

	for (const candidate of blocked) {
		const key = forComparison(candidate.path);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		lines.push(`  ${candidate.source}: ${candidate.path}`);
	}

	return lines;
}

function buildBlockedMessage(blocked) {
	return [
		"guard-worktree-install: refusing to install from inside a Kanban task worktree.",
		"",
		"Blocked invocation directory:",
		...describeBlockedDirectories(blocked),
		"",
		"Why this is dangerous:",
		"  Task worktrees share the main checkout's node_modules through one directory",
		"  symlink. pnpm resolves through that symlink but anchors each link's relative",
		"  target at the worktree it thinks is the project root, so the main checkout",
		"  gets links such as",
		"    node_modules/ms -> ../.cline/worktrees/<id>/kanban/node_modules/.pnpm/...",
		"  They resolve only while the worktree exists. Deleting it breaks the main",
		"  checkout's next build with ERR_MODULE_NOT_FOUND (for example node-pty).",
		"",
		"What to do instead:",
		"  Run the install in the main checkout. Dependency changes belong there, and",
		"  this worktree picks up the shared node_modules automatically.",
		"",
		'Details: AGENTS.md, bullet "That dead-link family has a specific trigger".',
		`Escape hatch (then repair the links): ${ALLOW_ENV_VAR}=1 pnpm install`,
	].join("\n");
}

function buildEscapeHatchWarning(blocked) {
	return [
		`guard-worktree-install: ${ALLOW_ENV_VAR} is set; allowing an install from a Kanban task worktree.`,
		...describeBlockedDirectories(blocked),
		"This can rewrite the main checkout's shared node_modules links.",
		"After it finishes, run `node scripts/check-symlinks.mjs --fix` and rebuild to confirm the links resolve.",
	].join("\n");
}

/**
 * Only the Kanban source checkout provisions task worktrees that share a
 * `node_modules` symlink. The published tarball ships this script (so
 * `preinstall` resolves) but not `pnpm-workspace.yaml`, so consumer installs
 * stay a quiet no-op instead of blocking on unrelated `.cline` paths.
 */
function isKanbanCheckout() {
	return existsSync(join(import.meta.dirname, "..", "pnpm-workspace.yaml"));
}

function main() {
	if (!isKanbanCheckout()) {
		return 0;
	}

	const blocked = collectInvocationDirectories().filter((candidate) => isInsideTaskWorktree([candidate.path]));
	if (blocked.length === 0) {
		return 0;
	}

	if (process.env[ALLOW_ENV_VAR] === "1") {
		console.warn(buildEscapeHatchWarning(blocked));
		return 0;
	}

	console.error(buildBlockedMessage(blocked));
	return 1;
}

/** Only run when executed as a script; tests import `isInsideTaskWorktree`. */
function isDirectInvocation() {
	const entry = process.argv[1];
	if (!entry) {
		return false;
	}

	try {
		const normalize = (path) => {
			const resolved = resolve(path);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		return normalize(realpathSync(entry)) === normalize(realpathSync(fileURLToPath(import.meta.url)));
	} catch {
		return false;
	}
}

if (isDirectInvocation()) {
	process.exitCode = main();
}
