// Linked-task auto-start.
//
// A task that is linked to a backlog task becomes a "ready" dependency when it
// leaves review for Done. Starting that backlog task used to live inline in the
// CLI trash path, which meant completing a task from the UI (or from any other
// board mutation that only goes through `workspace.saveState`) silently left
// the whole chain parked in backlog.
//
// This module owns the behavior for every caller:
//   - the runtime server invokes it from the `saveState` handler after the board
//     is persisted and broadcast, diffing the previous persisted board against
//     the incoming one so only an actual review -> trash transition triggers it;
//   - the CLI trash command invokes the same service with its runtime-backed
//     session starter instead of keeping its own copy of the loop.
//
// The board diff itself is pure in-memory work. Starting a task is delegated to
// the injected `startTaskSession`, which the runtime server binds to
// `startWorkspaceTaskSession` from `task-session-start.ts` (worktree ensure +
// Cline or PTY session start), and which the CLI binds to its runtime tRPC
// client. Moving the task to in_progress is persisted here so both callers and
// both agent runtimes behave identically.
import type {
	RuntimeBoardCard,
	RuntimeBoardColumnId,
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import {
	getReadyLinkedTaskIdsForTaskInTrash,
	getTaskColumnId,
	moveTaskToColumn,
	updateTaskDependencies,
} from "../core/task-board-mutations";
import { mutateWorkspaceState, type RuntimeWorkspaceAtomicMutationResponse } from "../state/workspace-state";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";

export type ReadyDependentTaskSkipReason = "not_backlog" | "session_running" | "already_starting" | "missing_card";

export interface SkippedReadyDependentTask {
	taskId: string;
	reason: ReadyDependentTaskSkipReason;
	message: string;
}

export interface StartedReadyDependentTask {
	taskId: string;
	ok: boolean;
	error?: string;
	movedToInProgress?: boolean;
}

export interface PlanReadyDependentTaskStartsInput {
	previousBoard: RuntimeBoardData;
	nextBoard: RuntimeBoardData;
	sessions?: Readonly<Record<string, RuntimeTaskSessionSummary>>;
	inFlightTaskIds?: ReadonlySet<string>;
}

export interface PlannedReadyDependentTaskStarts {
	/** Tasks that were in review in `previousBoard` and are in trash in `nextBoard`. */
	trashedTaskIds: string[];
	/** Dependent tasks that are safe to start now. */
	readyTaskIds: string[];
	/** Dependent tasks that were unblocked but deliberately not started. */
	skipped: SkippedReadyDependentTask[];
}

export interface StartReadyDependentTasksInput extends PlanReadyDependentTaskStartsInput {
	workspaceScope: RuntimeTrpcWorkspaceScope;
}

export interface StartReadyDependentTasksResult {
	trashedTaskIds: string[];
	readyTaskIds: string[];
	started: StartedReadyDependentTask[];
	skipped: SkippedReadyDependentTask[];
	/**
	 * Latest persisted state after the last in_progress move, when one happened.
	 * Callers that already saved the board should return this instead of their
	 * pre-auto-start response so the revision the client stores matches the
	 * server (the auto-start writes bump it).
	 */
	finalState?: RuntimeWorkspaceStateResponse;
}

export interface StartReadyDependentTasksDependencies {
	/**
	 * Starts the task session. The runtime server binds this to
	 * `startWorkspaceTaskSession` (task-session-start.ts) so native Cline and PTY
	 * agents share the same worktree/session/checkpoint behavior; the CLI binds
	 * it to its runtime tRPC client.
	 */
	startTaskSession: (
		workspaceScope: RuntimeTrpcWorkspaceScope,
		request: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	/** Optional live check; the persisted session snapshot is checked regardless. */
	isTaskSessionRunning?: (workspaceScope: RuntimeTrpcWorkspaceScope, taskId: string) => boolean | Promise<boolean>;
	warn?: (message: string) => void;
}

function buildColumnIdByTaskId(board: RuntimeBoardData): Map<string, RuntimeBoardColumnId> {
	const columnIdByTaskId = new Map<string, RuntimeBoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			columnIdByTaskId.set(card.id, column.id);
		}
	}
	return columnIdByTaskId;
}

export function findTaskCard(board: RuntimeBoardData, taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

/**
 * Pure diff: task ids that were in `review` in the previous board and are in
 * `trash` in the next one. Reorders, optimistic updates and unrelated edits
 * produce no ids, which is what keeps `saveState` from starting anything.
 */
export function findTasksMovedFromReviewToTrash(
	previousBoard: RuntimeBoardData,
	nextBoard: RuntimeBoardData,
): string[] {
	const previousColumnIdByTaskId = buildColumnIdByTaskId(previousBoard);
	const trashedTaskIds: string[] = [];
	for (const column of nextBoard.columns) {
		if (column.id !== "trash") {
			continue;
		}
		for (const card of column.cards) {
			if (previousColumnIdByTaskId.get(card.id) === "review") {
				trashedTaskIds.push(card.id);
			}
		}
	}
	return trashedTaskIds;
}

function findReadyDependentTaskIds(previousBoard: RuntimeBoardData, trashedTaskIds: string[]): string[] {
	if (trashedTaskIds.length === 0 || previousBoard.dependencies.length === 0) {
		return [];
	}
	const readyTaskIds: string[] = [];
	const seen = new Set<string>();
	for (const trashedTaskId of trashedTaskIds) {
		// The previous board is the one where the task still sits in review, so the
		// dependency records are intact (reading a persisted board drops links that
		// point at Done tasks). The helper resolves the current column internally
		// and only returns backlog dependents for a review task.
		const taskReadyIds = getReadyLinkedTaskIdsForTaskInTrash(previousBoard, trashedTaskId);
		for (const taskId of taskReadyIds) {
			if (seen.has(taskId)) {
				continue;
			}
			seen.add(taskId);
			readyTaskIds.push(taskId);
		}
	}
	return readyTaskIds;
}

/**
 * Pure eligibility pass. Keeping this separate from the start loop makes the
 * "only review -> trash", "must still be backlog" and "never double-start"
 * rules unit-testable without touching the filesystem or a session manager.
 */
export function planReadyDependentTaskStarts(
	input: PlanReadyDependentTaskStartsInput,
): PlannedReadyDependentTaskStarts {
	const trashedTaskIds = findTasksMovedFromReviewToTrash(input.previousBoard, input.nextBoard);
	const candidateTaskIds = findReadyDependentTaskIds(input.previousBoard, trashedTaskIds);
	const inFlightTaskIds = input.inFlightTaskIds ?? new Set<string>();
	const readyTaskIds: string[] = [];
	const skipped: SkippedReadyDependentTask[] = [];

	for (const taskId of candidateTaskIds) {
		const columnId = getTaskColumnId(input.nextBoard, taskId);
		if (columnId !== "backlog") {
			skipped.push({
				taskId,
				reason: "not_backlog",
				message: `Linked task "${taskId}" is in ${columnId ?? "an unknown column"} instead of backlog.`,
			});
			continue;
		}
		if (input.sessions?.[taskId]?.state === "running") {
			skipped.push({
				taskId,
				reason: "session_running",
				message: `Linked task "${taskId}" already has a running session.`,
			});
			continue;
		}
		if (inFlightTaskIds.has(taskId)) {
			skipped.push({
				taskId,
				reason: "already_starting",
				message: `Linked task "${taskId}" is already being started.`,
			});
			continue;
		}
		readyTaskIds.push(taskId);
	}

	return {
		trashedTaskIds,
		readyTaskIds,
		skipped,
	};
}

const inFlightTaskStartKeys = new Set<string>();

function createInFlightTaskKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}\u0000${taskId}`;
}

function getInFlightTaskIds(workspaceId: string): Set<string> {
	const prefix = `${workspaceId}\u0000`;
	const taskIds = new Set<string>();
	for (const key of inFlightTaskStartKeys) {
		if (key.startsWith(prefix)) {
			const taskId = key.slice(prefix.length);
			if (taskId) {
				taskIds.add(taskId);
			}
		}
	}
	return taskIds;
}

async function moveTaskToInProgress(
	workspacePath: string,
	taskId: string,
): Promise<RuntimeWorkspaceAtomicMutationResponse<boolean>> {
	return await mutateWorkspaceState(workspacePath, (state) => {
		if (getTaskColumnId(state.board, taskId) !== "backlog") {
			return {
				board: state.board,
				value: false,
				save: false,
			};
		}
		const moved = moveTaskToColumn(state.board, taskId, "in_progress");
		if (!moved.moved) {
			return {
				board: state.board,
				value: false,
				save: false,
			};
		}
		return {
			board: updateTaskDependencies(moved.board),
			value: true,
		};
	});
}

function createTaskSessionStartRequest(card: RuntimeBoardCard): RuntimeTaskSessionStartRequest {
	return {
		taskId: card.id,
		prompt: card.prompt,
		taskTitle: card.title,
		startInPlanMode: card.startInPlanMode,
		baseRef: card.baseRef,
		agentId: card.agentId,
		clineSettings: card.clineSettings,
	};
}

export async function startReadyDependentTasks(
	deps: StartReadyDependentTasksDependencies,
	input: StartReadyDependentTasksInput,
): Promise<StartReadyDependentTasksResult> {
	const { workspaceScope } = input;
	const planned = planReadyDependentTaskStarts({
		previousBoard: input.previousBoard,
		nextBoard: input.nextBoard,
		sessions: input.sessions,
		inFlightTaskIds: getInFlightTaskIds(workspaceScope.workspaceId),
	});
	const result: StartReadyDependentTasksResult = {
		trashedTaskIds: planned.trashedTaskIds,
		readyTaskIds: planned.readyTaskIds,
		started: [],
		skipped: [...planned.skipped],
	};
	if (planned.readyTaskIds.length === 0) {
		return result;
	}

	for (const taskId of planned.readyTaskIds) {
		const inFlightKey = createInFlightTaskKey(workspaceScope.workspaceId, taskId);
		// Re-check per task: a concurrent save can plan the same dependent before
		// either caller registers it as in flight.
		if (inFlightTaskStartKeys.has(inFlightKey)) {
			result.skipped.push({
				taskId,
				reason: "already_starting",
				message: `Linked task "${taskId}" is already being started.`,
			});
			continue;
		}
		if (deps.isTaskSessionRunning && (await deps.isTaskSessionRunning(workspaceScope, taskId))) {
			result.skipped.push({
				taskId,
				reason: "session_running",
				message: `Linked task "${taskId}" already has a running session.`,
			});
			continue;
		}
		const card = findTaskCard(input.nextBoard, taskId);
		if (!card) {
			result.skipped.push({
				taskId,
				reason: "missing_card",
				message: `Linked task "${taskId}" is no longer on the board.`,
			});
			continue;
		}

		inFlightTaskStartKeys.add(inFlightKey);
		try {
			const response = await deps.startTaskSession(workspaceScope, createTaskSessionStartRequest(card));
			if (!response.ok || !response.summary) {
				const error = response.error ?? "Could not start task session.";
				deps.warn?.(`Could not auto-start linked task "${taskId}". ${error}`);
				result.started.push({
					taskId,
					ok: false,
					error,
				});
				continue;
			}
			let movedToInProgress = false;
			try {
				const move = await moveTaskToInProgress(workspaceScope.workspacePath, taskId);
				movedToInProgress = move.value;
				if (move.saved) {
					// Expose the latest persisted state so the caller can return a
					// response whose revision matches the board it just wrote.
					result.finalState = move.state;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn?.(`Started linked task "${taskId}" but could not move it to in_progress. ${message}`);
			}
			result.started.push({
				taskId,
				ok: true,
				movedToInProgress,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			deps.warn?.(`Could not auto-start linked task "${taskId}". ${message}`);
			result.started.push({
				taskId,
				ok: false,
				error: message,
			});
		} finally {
			inFlightTaskStartKeys.delete(inFlightKey);
		}
	}

	return result;
}
