import { describe, expect, it } from "vitest";

import type { BoardCard, BoardColumnId, BoardData } from "@/types";
import { getNextUpTasksByTaskId } from "@/utils/linked-task-queue";

const COLUMN_ORDER: BoardColumnId[] = ["backlog", "in_progress", "review", "trash"];

function createTask(id: string): BoardCard {
	return {
		id,
		title: id,
		prompt: id,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

function createBoard(input: {
	tasksByColumn: Partial<Record<BoardColumnId, string[]>>;
	dependencies?: Array<[fromTaskId: string, toTaskId: string]>;
}): BoardData {
	return {
		columns: COLUMN_ORDER.map((columnId) => ({
			id: columnId,
			title: columnId,
			cards: (input.tasksByColumn[columnId] ?? []).map(createTask),
		})),
		dependencies: (input.dependencies ?? []).map(([fromTaskId, toTaskId], index) => ({
			id: `dependency-${index}`,
			fromTaskId,
			toTaskId,
			createdAt: index,
		})),
	};
}

function taskIds(tasks: BoardCard[] | undefined): string[] {
	return (tasks ?? []).map((task) => task.id);
}

describe("getNextUpTasksByTaskId", () => {
	it("queues backlog tasks behind a review task that gates them", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-b", "task-c"],
				review: ["task-a"],
			},
			dependencies: [
				["task-b", "task-a"],
				["task-c", "task-a"],
			],
		});

		const nextUpTasksByTaskId = getNextUpTasksByTaskId(board);

		expect(taskIds(nextUpTasksByTaskId.get("task-a"))).toEqual(["task-b", "task-c"]);
	});

	it("queues backlog tasks behind an in-progress task", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-b"],
				in_progress: ["task-a"],
			},
			dependencies: [["task-b", "task-a"]],
		});

		expect(taskIds(getNextUpTasksByTaskId(board).get("task-a"))).toEqual(["task-b"]);
	});

	it("preserves backlog order rather than dependency creation order", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-c", "task-b"],
				review: ["task-a"],
			},
			dependencies: [
				["task-b", "task-a"],
				["task-c", "task-a"],
			],
		});

		expect(taskIds(getNextUpTasksByTaskId(board).get("task-a"))).toEqual(["task-c", "task-b"]);
	});

	it("ignores links between two backlog tasks", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-a", "task-b"],
			},
			dependencies: [["task-b", "task-a"]],
		});

		expect(getNextUpTasksByTaskId(board).size).toBe(0);
	});

	it("ignores links to done tasks and non-backlog waiting tasks", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-b"],
				in_progress: ["task-c"],
				review: ["task-a"],
				trash: ["task-d"],
			},
			dependencies: [
				["task-b", "task-d"],
				["task-c", "task-a"],
			],
		});

		expect(getNextUpTasksByTaskId(board).size).toBe(0);
	});

	it("ignores dependencies that reference missing tasks", () => {
		const board = createBoard({
			tasksByColumn: {
				review: ["task-a"],
			},
			dependencies: [["missing-task", "task-a"]],
		});

		expect(getNextUpTasksByTaskId(board).size).toBe(0);
	});

	it("attributes queued tasks to each gating task independently", () => {
		const board = createBoard({
			tasksByColumn: {
				backlog: ["task-b", "task-c"],
				review: ["task-a", "task-d"],
			},
			dependencies: [
				["task-b", "task-a"],
				["task-c", "task-d"],
			],
		});

		const nextUpTasksByTaskId = getNextUpTasksByTaskId(board);

		expect(taskIds(nextUpTasksByTaskId.get("task-a"))).toEqual(["task-b"]);
		expect(taskIds(nextUpTasksByTaskId.get("task-d"))).toEqual(["task-c"]);
	});
});
