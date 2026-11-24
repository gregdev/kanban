import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveDependencyHandoffCommit } from "../../../src/workspace/dependency-handoff-commit";
import { ensureTaskWorktreeIfDoesntExist } from "../../../src/workspace/task-worktree";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const PREREQUISITE_ID = "abc12";

function runGit(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: createGitTestEnv(),
	});
	if (result.status !== 0) {
		throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function initRepository(path: string): void {
	mkdirSync(path, { recursive: true });
	runGit(path, ["init"]);
	runGit(path, ["checkout", "-B", "main"]);
	writeFileSync(join(path, "README.md"), "# dependency handoff test\n", "utf8");
	runGit(path, ["add", "."]);
	runGit(path, ["commit", "-qm", "init"]);
}

function commitFile(repoPath: string, name: string, message: string): string {
	writeFileSync(join(repoPath, name), `${name}\n`, "utf8");
	runGit(repoPath, ["add", name]);
	runGit(repoPath, ["commit", "-qm", message]);
	return runGit(repoPath, ["rev-parse", "HEAD"]);
}

async function withRepository(run: (repoPath: string) => Promise<void>): Promise<void> {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-handoff-commit-");
	const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-handoff-commit-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		await run(join(sandboxRoot, "project"));
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanupSandbox();
		cleanupHome();
	}
}

describe("resolveDependencyHandoffCommit", () => {
	it("uses the prerequisite worktree HEAD when it is reachable from the base ref", async () => {
		await withRepository(async (repoPath) => {
			initRepository(repoPath);
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: PREREQUISITE_ID,
				baseRef: "main",
			});
			expect(ensured.ok).toBe(true);
			if (!ensured.path) {
				throw new Error("Expected a task worktree path.");
			}
			const taskCommit = commitFile(ensured.path, "feature.txt", "feat: prerequisite work");
			// Fast-forward main to the task commit, then advance it again so the
			// worktree HEAD is an ancestor rather than the base ref tip.
			runGit(repoPath, ["merge", "--ff-only", taskCommit]);
			runGit(repoPath, ["commit", "--allow-empty", "-qm", "later main work"]);

			await expect(
				resolveDependencyHandoffCommit({
					workspacePath: repoPath,
					prerequisiteTaskId: PREREQUISITE_ID,
					baseRef: "main",
				}),
			).resolves.toBe(taskCommit);
		});
	});

	it("never reports the base ref tip as the prerequisite commit", async () => {
		await withRepository(async (repoPath) => {
			initRepository(repoPath);
			// A worktree that was never committed in simply reports the base tip.
			const ensured = await ensureTaskWorktreeIfDoesntExist({
				cwd: repoPath,
				taskId: PREREQUISITE_ID,
				baseRef: "main",
			});
			expect(ensured.ok).toBe(true);

			await expect(
				resolveDependencyHandoffCommit({
					workspacePath: repoPath,
					prerequisiteTaskId: PREREQUISITE_ID,
					baseRef: "main",
				}),
			).resolves.toBeNull();
		});
	});

	it("falls back to the task id in the base ref log when the worktree is gone", async () => {
		await withRepository(async (repoPath) => {
			initRepository(repoPath);
			const commit = commitFile(repoPath, "feature.txt", `feat: finish ${PREREQUISITE_ID}`);

			await expect(
				resolveDependencyHandoffCommit({
					workspacePath: repoPath,
					prerequisiteTaskId: PREREQUISITE_ID,
					baseRef: "main",
				}),
			).resolves.toBe(commit);
		});
	});

	it("returns null when nothing can be attributed to the prerequisite", async () => {
		await withRepository(async (repoPath) => {
			initRepository(repoPath);
			commitFile(repoPath, "feature.txt", "feat: unrelated work");

			await expect(
				resolveDependencyHandoffCommit({
					workspacePath: repoPath,
					prerequisiteTaskId: PREREQUISITE_ID,
					baseRef: "main",
				}),
			).resolves.toBeNull();
		});
	});

	it("returns null instead of throwing when the base ref does not exist", async () => {
		await withRepository(async (repoPath) => {
			initRepository(repoPath);

			await expect(
				resolveDependencyHandoffCommit({
					workspacePath: repoPath,
					prerequisiteTaskId: PREREQUISITE_ID,
					baseRef: "does-not-exist",
				}),
			).resolves.toBeNull();
		});
	});
});
