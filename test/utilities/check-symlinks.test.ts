import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createTempDir } from "./temp-dir";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/check-symlinks.mjs", import.meta.url));

/**
 * Link text pnpm writes when it is run inside a task worktree: it resolves
 * through `<checkout>/node_modules`, but only while that worktree exists.
 */
const WORKTREE_LINK_TARGET =
	"../../../.cline/worktrees/6f1e0c/kanban/node_modules/.pnpm/alpha@1.0.0/node_modules/alpha";
const LOCAL_STORE_ENTRY = ["node_modules", ".pnpm", "alpha@1.0.0", "node_modules", "alpha"];

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

function runCheck(root: string, args: string[] = []): RunResult {
	const result = spawnSync(process.execPath, [SCRIPT_PATH, "--root", root, ...args], { encoding: "utf8" });
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function createLocalStoreEntry(root: string): string {
	const entryPath = join(root, ...LOCAL_STORE_ENTRY);
	mkdirSync(entryPath, { recursive: true });
	return entryPath;
}

function createDeadWorktreeLink(root: string): string {
	createLocalStoreEntry(root);
	const linkPath = join(root, "node_modules", "alpha");
	symlinkSync(WORKTREE_LINK_TARGET, linkPath);
	return linkPath;
}

describe("check-symlinks script", () => {
	it("exits 0 when every link resolves across the scanned trees", () => {
		const { path: root, cleanup } = createTempDir("kanban-check-symlinks-clean-");

		try {
			mkdirSync(join(root, "node_modules", "alpha"), { recursive: true });
			symlinkSync("alpha", join(root, "node_modules", "alpha-link"));
			mkdirSync(join(root, "web-ui", "node_modules"), { recursive: true });
			symlinkSync(join("..", "..", "node_modules", "alpha"), join(root, "web-ui", "node_modules", "alpha"));
			mkdirSync(join(root, "packages", "desktop", "node_modules"), { recursive: true });

			const result = runCheck(root);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("no dead symlinks");
			expect(result.stdout).toContain("3 node_modules tree(s)");
		} finally {
			cleanup();
		}
	});

	it("reports a dead worktree-style link and exits 1", () => {
		const { path: root, cleanup } = createTempDir("kanban-check-symlinks-dead-");

		try {
			createDeadWorktreeLink(root);

			const result = runCheck(root);

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toContain(`node_modules/alpha -> ${WORKTREE_LINK_TARGET}`);
			expect(result.stdout).toContain("dead links: 1 (fixable: 1, unfixable: 0)");
			expect(result.stdout).toContain("pnpm run check:links -- --fix");
		} finally {
			cleanup();
		}
	});

	it("reports the dead link as machine-readable JSON", () => {
		const { path: root, cleanup } = createTempDir("kanban-check-symlinks-json-");

		try {
			createDeadWorktreeLink(root);

			const result = runCheck(root, ["--json"]);

			expect(result.exitCode).toBe(1);
			const report = JSON.parse(result.stdout) as {
				scanned: string[];
				dead: Array<{ link: string; target: string; fixable: boolean; resolved: string | null }>;
				summary: { dead: number; fixable: number; unfixable: number };
			};
			expect(report.scanned).toEqual(["node_modules"]);
			expect(report.dead).toEqual([
				{
					link: "node_modules/alpha",
					target: WORKTREE_LINK_TARGET,
					fixable: true,
					resolved: "node_modules/.pnpm/alpha@1.0.0/node_modules/alpha",
				},
			]);
			expect(report.summary).toMatchObject({ dead: 1, fixable: 1, unfixable: 0 });
		} finally {
			cleanup();
		}
	});

	it("repairs a fixable link into the local store with --fix", () => {
		const { path: root, cleanup } = createTempDir("kanban-check-symlinks-fix-");

		try {
			const linkPath = createDeadWorktreeLink(root);

			const result = runCheck(root, ["--fix"]);

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(
				"fixed node_modules/alpha -> node_modules/.pnpm/alpha@1.0.0/node_modules/alpha",
			);
			expect(result.stdout).toContain("fixed: 1 (remaining: 0)");
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(realpathSync(linkPath)).toBe(realpathSync(join(root, ...LOCAL_STORE_ENTRY)));

			// The same tree is clean afterwards.
			expect(runCheck(root).exitCode).toBe(0);
		} finally {
			cleanup();
		}
	});

	it("reports an unfixable link without touching it and exits 2 with --fix", () => {
		const { path: root, cleanup } = createTempDir("kanban-check-symlinks-unfixable-");

		try {
			mkdirSync(join(root, "node_modules"), { recursive: true });
			const linkPath = join(root, "node_modules", "stray");
			symlinkSync("../../../elsewhere/stray", linkPath);

			const check = runCheck(root);

			expect(check.exitCode).toBe(1);
			expect(check.stdout).toContain("node_modules/stray -> ../../../elsewhere/stray");
			expect(check.stdout).toContain("fixable: 0, unfixable: 1");

			const fix = runCheck(root, ["--fix"]);

			expect(fix.exitCode).toBe(2);
			expect(fix.stdout).toContain("node_modules/stray -> ../../../elsewhere/stray");
			expect(fix.stdout).toContain("fixed: 0 (remaining: 1)");
			expect(fix.stderr).toContain("pnpm install --frozen-lockfile");
			expect(readlinkSync(linkPath)).toBe("../../../elsewhere/stray");
		} finally {
			cleanup();
		}
	});

	it("skips a symlinked node_modules instead of scanning or modifying the shared install", () => {
		const { path: root, cleanup: cleanupRoot } = createTempDir("kanban-check-symlinks-root-");
		const { path: shared, cleanup: cleanupShared } = createTempDir("kanban-check-symlinks-shared-");

		try {
			mkdirSync(join(shared, "node_modules"), { recursive: true });
			const brokenPath = join(shared, "node_modules", "broken");
			symlinkSync("../../../kanban/node_modules/missing", brokenPath);
			symlinkSync(join(shared, "node_modules"), join(root, "node_modules"));

			const result = runCheck(root, ["--fix"]);

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toContain("warning: skipping node_modules: it is a symlink");
			expect(result.stderr).toContain("refusing to scan a shared install");
			expect(readlinkSync(brokenPath)).toBe("../../../kanban/node_modules/missing");

			const json = JSON.parse(runCheck(root, ["--json"]).stdout) as {
				scanned: string[];
				skipped: Array<{ path: string; target: string }>;
			};
			expect(json.scanned).toEqual([]);
			expect(json.skipped).toEqual([{ path: "node_modules", target: join(shared, "node_modules") }]);
		} finally {
			cleanupRoot();
			cleanupShared();
		}
	});
});
