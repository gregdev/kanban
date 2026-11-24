import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import { startReadyDependentTasks } from "../../../src/server/linked-task-autostart";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { createWorkspaceApi } from "../../../src/trpc/workspace-api";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const PREREQUISITE_ID = "prerequisite";
const DEPENDENT_ID = "dependent";

function createCard(taskId: string): RuntimeBoardCard {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

interface BoardColumns {
	backlog?: string[];
	inProgress?: string[];
	review?: string[];
	trash?: string[];
}

function createBoard(columns: BoardColumns, dependencies: RuntimeBoardDependency[] = []): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: (columns.backlog ?? []).map(createCard) },
			{ id: "in_progress", title: "In Progress", cards: (columns.inProgress ?? []).map(createCard) },
			{ id: "review", title: "Review", cards: (columns.review ?? []).map(createCard) },
			{ id: "trash", title: "Done", cards: (columns.trash ?? []).map(createCard) },
		],
		dependencies,
	};
}

function createDependency(): RuntimeBoardDependency {
	return {
		id: `${DEPENDENT_ID}-${PREREQUISITE_ID}`,
		fromTaskId: DEPENDENT_ID,
		toTaskId: PREREQUISITE_ID,
		createdAt: 1,
	};
}

function createRunningSummary(taskId: string): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "running",
		agentId: "claude",
		workspacePath: `/tmp/${taskId}`,
		pid: 1234,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

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

describe("workspace.saveState linked-task auto-start", () => {
	it("starts the backlog dependent when the prerequisite moves from review to trash", async () => {
		const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-save-state-");
		const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-save-state-");
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = tempHome;
		process.env.USERPROFILE = tempHome;
		try {
			const workspacePath = join(sandboxRoot, "project");
			mkdirSync(workspacePath, { recursive: true });
			initGitRepository(workspacePath);

			const initial = await loadWorkspaceState(workspacePath);
			await saveWorkspaceState(workspacePath, {
				board: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [createDependency()]),
				sessions: {},
				expectedRevision: initial.revision,
			});
			const workspaceId = (await loadWorkspaceContext(workspacePath)).workspaceId;

			const startTaskSession = vi.fn(
				async (_scope: { workspaceId: string }, request: RuntimeTaskSessionStartRequest) => ({
					ok: true as const,
					summary: createRunningSummary(request.taskId),
				}),
			);
			const broadcastRuntimeWorkspaceStateUpdated = vi.fn();
			const broadcastRuntimeProjectsUpdated = vi.fn();
			const api = createWorkspaceApi({
				ensureTerminalManagerForWorkspace: vi.fn(async () => ({ listSummaries: () => [] }) as never),
				getScopedClineTaskSessionService: vi.fn(),
				broadcastRuntimeWorkspaceStateUpdated,
				broadcastRuntimeProjectsUpdated,
				buildWorkspaceStateSnapshot: vi.fn(),
				autoStartReadyDependentTasks: (workspaceScope, input) =>
					startReadyDependentTasks({ startTaskSession }, { workspaceScope, ...input }),
				warn: vi.fn(),
			});

			const beforeSave = await loadWorkspaceState(workspacePath);
			const savedResponse = await api.saveState(
				{ workspaceId, workspacePath },
				{
					board: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [createDependency()]),
					sessions: {},
					expectedRevision: beforeSave.revision,
				},
			);

			expect(startTaskSession).toHaveBeenCalledTimes(1);
			expect(startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({ workspaceId }),
				expect.objectContaining({
					taskId: DEPENDENT_ID,
					prompt: expect.stringContaining(`Task ${DEPENDENT_ID}`),
				}),
			);
			expect(broadcastRuntimeWorkspaceStateUpdated).toHaveBeenCalled();

			const afterSave = await loadWorkspaceState(workspacePath);
			expect(afterSave.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(DEPENDENT_ID);
			expect(afterSave.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe(PREREQUISITE_ID);
			// The save itself bumps the revision once and the auto-start move bumps it
			// again. The response must carry the post-auto-start state, otherwise the
			// client would persist a stale expectedRevision for its next save.
			expect(savedResponse.revision).toBe(beforeSave.revision + 2);
			expect(savedResponse.revision).toBe(afterSave.revision);
			expect(savedResponse.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(
				DEPENDENT_ID,
			);

			// A later save that only reorders the same board is not a transition.
			await api.saveState(
				{ workspaceId, workspacePath },
				{
					board: createBoard({ trash: [PREREQUISITE_ID], inProgress: [DEPENDENT_ID] }, [createDependency()]),
					sessions: afterSave.sessions,
					expectedRevision: afterSave.revision,
				},
			);
			expect(startTaskSession).toHaveBeenCalledTimes(1);
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
