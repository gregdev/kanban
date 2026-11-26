import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isInsideTaskWorktree } from "../../scripts/guard-worktree-install.mjs";

import { createTempDir } from "./temp-dir";

const SCRIPT_PATH = fileURLToPath(new URL("../../scripts/guard-worktree-install.mjs", import.meta.url));
const isWindows = process.platform === "win32";

interface RunGuardOptions {
	cwd: string;
	initCwd?: string;
	pwd?: string;
	allowWorktreeInstall?: boolean;
	/** Override to test the published-package copy of the script. */
	scriptPath?: string;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * Run the guard as a real script. `INIT_CWD` and `PWD` are set explicitly
 * because the developer's shell (or CI) may itself be inside a worktree, and
 * because those variables are what the guard is meant to catch.
 */
function runGuard(options: RunGuardOptions): RunResult {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		INIT_CWD: options.initCwd ?? options.cwd,
		PWD: options.pwd ?? options.cwd,
	};
	delete env.KANBAN_ALLOW_WORKTREE_INSTALL;
	if (options.allowWorktreeInstall) {
		env.KANBAN_ALLOW_WORKTREE_INSTALL = "1";
	}

	const result = spawnSync(process.execPath, [options.scriptPath ?? SCRIPT_PATH], {
		cwd: options.cwd,
		env,
		encoding: "utf8",
	});
	return {
		exitCode: result.status ?? -1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

describe("isInsideTaskWorktree", () => {
	it("blocks a worktree root and directories nested inside it", () => {
		expect(isInsideTaskWorktree(["/home/me/.cline/worktrees/b7ade/kanban"])).toBe(true);
		expect(isInsideTaskWorktree(["/home/me/.cline/worktrees/b7ade/kanban/web-ui/src"])).toBe(true);
		expect(isInsideTaskWorktree(["/home/me/.cline/worktrees/b7ade"])).toBe(true);
	});

	it("blocks Windows paths regardless of which separator is used", () => {
		expect(isInsideTaskWorktree(["C:\\Users\\me\\.cline\\worktrees\\abc\\kanban"])).toBe(true);
		expect(isInsideTaskWorktree(["C:/Users/me/.cline/worktrees/abc/kanban"])).toBe(true);
		expect(isInsideTaskWorktree(["C:\\Users\\me\\.cline\\worktrees\\abc\\kanban\\web-ui"])).toBe(true);
		expect(isInsideTaskWorktree(["C:\\Users\\me/.cline\\worktrees\\abc\\kanban"])).toBe(true);
	});

	it("blocks when any candidate directory is inside a worktree", () => {
		expect(isInsideTaskWorktree(["/home/me/projects/kanban", "/home/me/.cline/worktrees/abc/kanban"])).toBe(true);
	});

	it("allows a main checkout and its node_modules paths", () => {
		expect(isInsideTaskWorktree(["/home/me/projects/kanban"])).toBe(false);
		expect(isInsideTaskWorktree(["/home/me/projects/kanban/node_modules/.bin"])).toBe(false);
		expect(isInsideTaskWorktree([])).toBe(false);
	});

	it("allows a project that happens to be named .cline", () => {
		expect(isInsideTaskWorktree(["/home/me/projects/.cline/src"])).toBe(false);
		// Near miss: `.cline/worktree` (singular) is not the marker.
		expect(isInsideTaskWorktree(["/home/me/projects/.cline/worktree/abc"])).toBe(false);
	});

	it("requires a worktree id after .cline/worktrees", () => {
		expect(isInsideTaskWorktree(["/home/me/.cline/worktrees"])).toBe(false);
	});

	it("does not match a parent directory such as my.cline", () => {
		expect(isInsideTaskWorktree(["/home/me/projects/my.cline/worktrees/abc"])).toBe(false);
	});

	it.skipIf(!isWindows)("treats Windows paths case-insensitively", () => {
		expect(isInsideTaskWorktree(["C:\\Users\\me\\.CLINE\\Worktrees\\abc\\kanban"])).toBe(true);
	});

	it.skipIf(isWindows)("keeps POSIX paths case-sensitive", () => {
		expect(isInsideTaskWorktree(["/home/me/.CLINE/worktrees/abc/kanban"])).toBe(false);
	});
});

describe("guard-worktree-install script", () => {
	it("exits 1 with an actionable explanation when invoked inside a worktree", () => {
		const { path: mainCheckout, cleanup } = createTempDir("kanban-guard-worktree-");

		try {
			const worktreeDir = join(mainCheckout, ".cline", "worktrees", "b7ade", "kanban", "web-ui");
			mkdirSync(worktreeDir, { recursive: true });

			const result = runGuard({ cwd: worktreeDir });

			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("refusing to install from inside a Kanban task worktree");
			expect(result.stderr).toContain(worktreeDir);
			expect(result.stderr).toContain("node_modules/ms");
			expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
			expect(result.stderr).toContain("Run the install in the main checkout");
			expect(result.stderr).toContain("AGENTS.md");
			expect(result.stderr).toContain("KANBAN_ALLOW_WORKTREE_INSTALL=1");
		} finally {
			cleanup();
		}
	});

	it("blocks when only PWD points into a worktree", () => {
		const { path: mainCheckout, cleanup } = createTempDir("kanban-guard-pwd-");

		try {
			const worktreeDir = join(mainCheckout, ".cline", "worktrees", "abc", "kanban");
			mkdirSync(worktreeDir, { recursive: true });

			const result = runGuard({ cwd: mainCheckout, pwd: worktreeDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("PWD:");
			expect(result.stderr).toContain(worktreeDir);
		} finally {
			cleanup();
		}
	});

	it("blocks when only INIT_CWD points into a worktree", () => {
		const { path: mainCheckout, cleanup } = createTempDir("kanban-guard-init-cwd-");

		try {
			const worktreeDir = join(mainCheckout, ".cline", "worktrees", "abc", "kanban");
			mkdirSync(worktreeDir, { recursive: true });

			const result = runGuard({ cwd: mainCheckout, initCwd: worktreeDir });

			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain("INIT_CWD:");
			expect(result.stderr).toContain(worktreeDir);
		} finally {
			cleanup();
		}
	});

	it("exits 0 quietly in the main checkout", () => {
		const { path: mainCheckout, cleanup } = createTempDir("kanban-guard-main-");

		try {
			mkdirSync(join(mainCheckout, "node_modules", ".bin"), { recursive: true });

			const result = runGuard({ cwd: mainCheckout });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		} finally {
			cleanup();
		}
	});

	it("allows the install with the escape hatch and warns to repair the links", () => {
		const { path: mainCheckout, cleanup } = createTempDir("kanban-guard-escape-");

		try {
			const worktreeDir = join(mainCheckout, ".cline", "worktrees", "abc", "kanban");
			mkdirSync(worktreeDir, { recursive: true });

			const result = runGuard({ cwd: worktreeDir, allowWorktreeInstall: true });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("KANBAN_ALLOW_WORKTREE_INSTALL");
			expect(result.stderr).toContain("allowing an install");
			expect(result.stderr).toContain("node scripts/check-symlinks.mjs --fix");
		} finally {
			cleanup();
		}
	});

	it("is a quiet no-op in a published install (no pnpm-workspace.yaml next to the script)", () => {
		const { path: publishedPackage, cleanup: cleanupPackage } = createTempDir("kanban-guard-published-");
		const { path: consumer, cleanup: cleanupConsumer } = createTempDir("kanban-guard-consumer-");

		try {
			// The tarball ships the script but not pnpm-workspace.yaml, so
			// `npx kanban` / `npm i -g kanban` must never be blocked.
			const scriptsDir = join(publishedPackage, "scripts");
			mkdirSync(scriptsDir, { recursive: true });
			const publishedScript = join(scriptsDir, "guard-worktree-install.mjs");
			copyFileSync(SCRIPT_PATH, publishedScript);

			const worktreeDir = join(consumer, ".cline", "worktrees", "abc", "kanban");
			mkdirSync(worktreeDir, { recursive: true });

			const result = runGuard({ cwd: worktreeDir, scriptPath: publishedScript });

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
		} finally {
			cleanupPackage();
			cleanupConsumer();
		}
	});
});
