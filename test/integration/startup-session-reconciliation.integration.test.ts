import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadGlobalRuntimeConfig, loadRuntimeConfig } from "../../src/config/runtime-config";
import type { RuntimeBoardData, RuntimeTaskSessionSummary } from "../../src/core/api-contract";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function hasGitRepository(path: string): boolean {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: path,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		env: createGitTestEnv(),
	});
	return result.status === 0 && result.stdout.trim() === "true";
}

async function pathIsDirectory(path: string): Promise<boolean> {
	try {
		const info = await stat(path);
		return info.isDirectory();
	} catch {
		return false;
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: taskIds.map(createCard) },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createRunningSession(taskId: string, agentId: "claude" | "cline"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId,
		workspacePath: `/tmp/${taskId}`,
		pid: 1234,
		startedAt: Date.now() - 1_000,
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

describe("startup session reconciliation integration", () => {
	it("marks persisted running sessions interrupted and persists board/session state without a viewer", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-startup-reconcile-");
		const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-startup-reconcile-");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		try {
			const projectPath = join(sandboxRoot, "project");
			mkdirSync(projectPath, { recursive: true });
			initGitRepository(projectPath);

			const initial = await loadWorkspaceState(projectPath);
			await saveWorkspaceState(projectPath, {
				board: createBoard(["terminal-running", "cline-running"]),
				sessions: {
					"terminal-running": createRunningSession("terminal-running", "claude"),
					"cline-running": createRunningSession("cline-running", "cline"),
				},
				expectedRevision: initial.revision,
			});

			const registry = await createWorkspaceRegistry({
				cwd: projectPath,
				loadGlobalRuntimeConfig,
				loadRuntimeConfig,
				hasGitRepository,
				pathIsDirectory,
				warn: () => {},
			});

			const workspaceId = registry.getActiveWorkspaceId();
			expect(workspaceId).not.toBeNull();
			if (!workspaceId) {
				return;
			}

			const persisted = await loadWorkspaceState(projectPath);
			expect(persisted.sessions["terminal-running"]?.state).toBe("interrupted");
			expect(persisted.sessions["terminal-running"]?.reviewReason).toBe("interrupted");
			expect(persisted.sessions["terminal-running"]?.pid).toBeNull();
			expect(persisted.sessions["cline-running"]?.state).toBe("interrupted");
			expect(persisted.sessions["cline-running"]?.reviewReason).toBe("interrupted");
			expect(persisted.sessions["cline-running"]?.pid).toBeNull();

			const inProgress = persisted.board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
			const trash = persisted.board.columns.find((column) => column.id === "trash")?.cards ?? [];
			expect(inProgress).toEqual([]);
			expect(trash.map((card) => card.id).sort()).toEqual(["cline-running", "terminal-running"]);

			const counts = await registry.summarizeProjectTaskCounts(workspaceId, projectPath);
			expect(counts.in_progress).toBe(0);
			expect(counts.trash).toBe(2);

			const reconciled = registry.getStartupReconciledSessions(workspaceId);
			expect(reconciled.map((summary) => summary.taskId).sort()).toEqual(["cline-running", "terminal-running"]);

			registry.disposeWorkspace(workspaceId, { stopTerminalSessions: false });
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
	});
});
