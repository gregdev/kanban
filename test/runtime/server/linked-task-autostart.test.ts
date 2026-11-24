import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	findTasksMovedFromReviewToTrash,
	planReadyDependentTaskStarts,
	startReadyDependentTasks,
} from "../../../src/server/linked-task-autostart";
import { loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
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

function createDependency(fromTaskId: string, toTaskId: string): RuntimeBoardDependency {
	return {
		id: `${fromTaskId}-${toTaskId}`,
		fromTaskId,
		toTaskId,
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

describe("findTasksMovedFromReviewToTrash", () => {
	it("detects only review -> trash transitions", () => {
		const previousBoard = createBoard({
			review: ["reviewed", "still-reviewed"],
			backlog: ["from-backlog"],
			trash: ["already-done"],
		});
		const nextBoard = createBoard({
			trash: ["reviewed", "from-backlog", "already-done"],
			review: ["still-reviewed"],
		});

		expect(findTasksMovedFromReviewToTrash(previousBoard, nextBoard)).toEqual(["reviewed"]);
	});

	it("treats reorders, drags between other columns and unrelated saves as no transition", () => {
		const previousBoard = createBoard({ backlog: ["task-a"], review: ["task-b"] }, [
			createDependency("task-a", "task-b"),
		]);
		const reorderedBoard = createBoard({ review: ["task-b"], backlog: ["task-a"] }, [
			createDependency("task-a", "task-b"),
		]);
		const movedToProgressBoard = createBoard({ backlog: ["task-b"], inProgress: ["task-a"] }, [
			createDependency("task-a", "task-b"),
		]);

		expect(findTasksMovedFromReviewToTrash(previousBoard, reorderedBoard)).toEqual([]);
		expect(findTasksMovedFromReviewToTrash(previousBoard, movedToProgressBoard)).toEqual([]);
	});
});

describe("planReadyDependentTaskStarts", () => {
	const dependency = createDependency(DEPENDENT_ID, PREREQUISITE_ID);

	it("plans the backlog dependent of a task that moved from review to trash", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
		});

		expect(planned.trashedTaskIds).toEqual([PREREQUISITE_ID]);
		expect(planned.readyTaskIds).toEqual([DEPENDENT_ID]);
		expect(planned.skipped).toEqual([]);
	});

	it("never plans a dependent that the same save moved out of backlog", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			nextBoard: createBoard({ trash: [PREREQUISITE_ID], inProgress: [DEPENDENT_ID] }, [dependency]),
		});

		expect(planned.readyTaskIds).toEqual([]);
		expect(planned.skipped).toEqual([expect.objectContaining({ taskId: DEPENDENT_ID, reason: "not_backlog" })]);
	});

	it("does not plan dependents when the prerequisite left backlog instead of review", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ backlog: [PREREQUISITE_ID, DEPENDENT_ID] }, [dependency]),
			nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
		});

		expect(planned.trashedTaskIds).toEqual([]);
		expect(planned.readyTaskIds).toEqual([]);
	});

	it("skips a dependent whose session is already running", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			sessions: { [DEPENDENT_ID]: createRunningSummary(DEPENDENT_ID) },
		});

		expect(planned.readyTaskIds).toEqual([]);
		expect(planned.skipped).toEqual([expect.objectContaining({ taskId: DEPENDENT_ID, reason: "session_running" })]);
	});

	it("skips a dependent that another in-flight save is already starting", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [dependency]),
			inFlightTaskIds: new Set([DEPENDENT_ID]),
		});

		expect(planned.readyTaskIds).toEqual([]);
		expect(planned.skipped).toEqual([expect.objectContaining({ taskId: DEPENDENT_ID, reason: "already_starting" })]);
	});

	it("deduplicates a dependent that several trashed prerequisites unblock", () => {
		const planned = planReadyDependentTaskStarts({
			previousBoard: createBoard({ review: ["first", "second"], backlog: [DEPENDENT_ID] }, [
				createDependency(DEPENDENT_ID, "first"),
				createDependency(DEPENDENT_ID, "second"),
			]),
			nextBoard: createBoard({ trash: ["first", "second"], backlog: [DEPENDENT_ID] }),
		});

		expect(planned.trashedTaskIds).toEqual(["first", "second"]);
		expect(planned.readyTaskIds).toEqual([DEPENDENT_ID]);
	});
});

interface WorkspaceFixture {
	workspaceId: string;
	workspacePath: string;
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

async function withWorkspace(run: (fixture: WorkspaceFixture) => Promise<void>): Promise<void> {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-linked-autostart-");
	const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-linked-autostart-");
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
			board: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [
				createDependency(DEPENDENT_ID, PREREQUISITE_ID),
			]),
			sessions: {},
			expectedRevision: initial.revision,
		});
		await run({
			workspaceId: `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			workspacePath,
		});
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

describe("startReadyDependentTasks", () => {
	it("starts the dependent once and moves it to in_progress", async () => {
		await withWorkspace(async ({ workspaceId, workspacePath }) => {
			const startTaskSession = vi.fn(async (_scope, request: { taskId: string }) => ({
				ok: true as const,
				summary: createRunningSummary(request.taskId),
			}));
			const result = await startReadyDependentTasks(
				{ startTaskSession },
				{
					workspaceScope: { workspaceId, workspacePath },
					previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [
						createDependency(DEPENDENT_ID, PREREQUISITE_ID),
					]),
					nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [
						createDependency(DEPENDENT_ID, PREREQUISITE_ID),
					]),
				},
			);

			expect(result.trashedTaskIds).toEqual([PREREQUISITE_ID]);
			expect(result.readyTaskIds).toEqual([DEPENDENT_ID]);
			expect(result.started).toEqual([
				expect.objectContaining({ taskId: DEPENDENT_ID, ok: true, movedToInProgress: true }),
			]);
			expect(startTaskSession).toHaveBeenCalledTimes(1);
			expect(startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({ workspaceId }),
				expect.objectContaining({ taskId: DEPENDENT_ID, prompt: `Task ${DEPENDENT_ID}` }),
			);

			const state = await loadWorkspaceState(workspacePath);
			expect(state.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(DEPENDENT_ID);
		});
	});

	it("guards concurrent saves with a per-task in-flight set", async () => {
		await withWorkspace(async ({ workspaceId, workspacePath }) => {
			let releaseStart: () => void = () => {};
			const startGate = new Promise<void>((resolve) => {
				releaseStart = () => {
					resolve();
				};
			});
			const startTaskSession = vi.fn(async (_scope, request: { taskId: string }) => {
				await startGate;
				return {
					ok: true as const,
					summary: createRunningSummary(request.taskId),
				};
			});
			const input = {
				workspaceScope: { workspaceId, workspacePath },
				previousBoard: createBoard({ review: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [
					createDependency(DEPENDENT_ID, PREREQUISITE_ID),
				]),
				nextBoard: createBoard({ trash: [PREREQUISITE_ID], backlog: [DEPENDENT_ID] }, [
					createDependency(DEPENDENT_ID, PREREQUISITE_ID),
				]),
			};

			const first = startReadyDependentTasks({ startTaskSession }, input);
			const second = await startReadyDependentTasks({ startTaskSession }, input);

			expect(startTaskSession).toHaveBeenCalledTimes(1);
			expect(second.started).toEqual([]);
			expect(second.skipped).toEqual([
				expect.objectContaining({ taskId: DEPENDENT_ID, reason: "already_starting" }),
			]);

			releaseStart();
			const firstResult = await first;
			expect(firstResult.started).toEqual([expect.objectContaining({ taskId: DEPENDENT_ID, ok: true })]);
		});
	});
});
