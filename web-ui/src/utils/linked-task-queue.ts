import type { BoardCard, BoardColumnId, BoardData } from "@/types";

const AUTO_START_SOURCE_COLUMN_IDS: ReadonlySet<BoardColumnId> = new Set(["in_progress", "review"]);

/**
 * Groups the backlog tasks that are waiting on another task into the task that
 * gates them. When the gating task (the dependency `toTaskId`) is in progress or
 * review, the backlog task (the dependency `fromTaskId`) is queued to start as
 * soon as the gating task is moved to done.
 *
 * Results are keyed by the gating task id and preserve backlog card order so the
 * UI can render a stable "Up next" list.
 */
export function getNextUpTasksByTaskId(board: BoardData): Map<string, BoardCard[]> {
	if (board.dependencies.length === 0) {
		return new Map();
	}
	const backlogColumn = board.columns.find((column) => column.id === "backlog");
	if (!backlogColumn || backlogColumn.cards.length === 0) {
		return new Map();
	}

	const columnIdByTaskId = new Map<string, BoardColumnId>();
	for (const column of board.columns) {
		for (const card of column.cards) {
			columnIdByTaskId.set(card.id, column.id);
		}
	}

	const gatingTaskIdsByWaitingTaskId = new Map<string, string[]>();
	for (const dependency of board.dependencies) {
		const gatingTaskIds = gatingTaskIdsByWaitingTaskId.get(dependency.fromTaskId);
		if (gatingTaskIds) {
			gatingTaskIds.push(dependency.toTaskId);
		} else {
			gatingTaskIdsByWaitingTaskId.set(dependency.fromTaskId, [dependency.toTaskId]);
		}
	}

	const nextUpTasksByTaskId = new Map<string, BoardCard[]>();
	for (const waitingTask of backlogColumn.cards) {
		for (const gatingTaskId of gatingTaskIdsByWaitingTaskId.get(waitingTask.id) ?? []) {
			const gatingColumnId = columnIdByTaskId.get(gatingTaskId);
			if (!gatingColumnId || !AUTO_START_SOURCE_COLUMN_IDS.has(gatingColumnId)) {
				continue;
			}
			const nextUpTasks = nextUpTasksByTaskId.get(gatingTaskId);
			if (nextUpTasks) {
				nextUpTasks.push(waitingTask);
			} else {
				nextUpTasksByTaskId.set(gatingTaskId, [waitingTask]);
			}
		}
	}

	return nextUpTasksByTaskId;
}
