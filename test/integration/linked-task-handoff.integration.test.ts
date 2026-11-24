import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	RuntimeBoardCard,
	RuntimeBoardData,
	RuntimeBoardDependency,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import { DEPENDENCY_HANDOFF_CONTEXT_HEADER } from "../../src/core/dependency-handoff";
import { startReadyDependentTasks } from "../../src/server/linked-task-autostart";
import { loadWorkspaceState, saveWorkspaceState } from "../../src/state/workspace-state";
import { ensureTaskWorktreeIfDoesntExist } from "../../src/workspace/task-worktree";
import { createGitTestEnv } from "../utilities/git-env";
import { createTempDir } from "../utilities/temp-dir";

const PREREQUISITE_ID = "abc12";
const DEPENDENT_ID = "def34";
const BASE_REF = "main";

function createCard(taskId: string, title: string): RuntimeBoardCard {
	return {
		id: taskId,
		title,
		prompt: title,
		startInPlanMode: false,
		baseRef: BASE_REF,
		createdAt: 1,
		updatedAt: 1,
	};
}

function createDependency(): RuntimeBoardDependency {
	return {
		id: "dependency-1",
		fromTaskId: DEPENDENT_ID,
		toTaskId: PREREQUISITE_ID,
		createdAt: 1,
	};
}

interface BoardColumns {
	backlog?: RuntimeBoardCard[];
	inProgress?: RuntimeBoardCard[];
	review?: RuntimeBoardCard[];
	trash?: RuntimeBoardCard[];
}

function createBoard(columns: BoardColumns): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: columns.backlog ?? [] },
			{ id: "in_progress", title: "In Progress", cards: columns.inProgress ?? [] },
			{ id: "review", title: "Review", cards: columns.review ?? [] },
			{ id: "trash", title: "Done", cards: columns.trash ?? [] },
		],
		dependencies: [createDependency()],
	};
}

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
	runGit(path, ["checkout", "-B", BASE_REF]);
	writeFileSync(join(path, "README.md"), "# linked task handoff\n", "utf8");
	runGit(path, ["add", "."]);
	runGit(path, ["commit", "-qm", "init"]);
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

async function withLinkedWorkspace(
	run: (input: { workspaceId: string; workspacePath: string; prerequisiteCommit: string }) => Promise<void>,
): Promise<void> {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-handoff-integration-");
	const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-handoff-integration-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		const workspacePath = join(sandboxRoot, "project");
		initRepository(workspacePath);

		// The prerequisite agent commits in its task worktree, the commit lands on
		// the base ref, and the base ref then advances again. That leaves the
		// worktree HEAD reachable but not identical to the base ref tip, which is
		// exactly the case the handoff note must report.
		const ensured = await ensureTaskWorktreeIfDoesntExist({
			cwd: workspacePath,
			taskId: PREREQUISITE_ID,
			baseRef: BASE_REF,
		});
		if (!ensured.ok || !ensured.path) {
			throw new Error(ensured.error ?? "Expected the prerequisite worktree to be created.");
		}
		writeFileSync(join(ensured.path, "prerequisite.txt"), "prerequisite work\n", "utf8");
		runGit(ensured.path, ["add", "prerequisite.txt"]);
		runGit(ensured.path, ["commit", "-qm", "feat: prerequisite work"]);
		const prerequisiteCommit = runGit(ensured.path, ["rev-parse", "HEAD"]);
		runGit(workspacePath, ["merge", "--ff-only", prerequisiteCommit]);
		runGit(workspacePath, ["commit", "--allow-empty", "-qm", "later main work"]);

		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, {
			board: createBoard({
				review: [createCard(PREREQUISITE_ID, "Prerequisite task")],
				backlog: [createCard(DEPENDENT_ID, "Dependent task")],
			}),
			sessions: {},
			expectedRevision: initial.revision,
		});
		const workspaceId = `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		await run({ workspaceId, workspacePath, prerequisiteCommit });
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

describe("linked-task dependency handoff integration", () => {
	it("starts the dependent with the handoff note while the board card prompt stays untouched", async () => {
		await withLinkedWorkspace(async ({ workspaceId, workspacePath, prerequisiteCommit }) => {
			expect(prerequisiteCommit).toMatch(/^[0-9a-f]{40}$/);

			// `startTaskSession` receives what becomes the agent's first user message.
			const firstUserMessages: RuntimeTaskSessionStartRequest[] = [];
			const result = await startReadyDependentTasks(
				{
					startTaskSession: async (_scope, request) => {
						firstUserMessages.push(request);
						return { ok: true, summary: createRunningSummary(request.taskId) };
					},
					isDependencyHandoffContextEnabled: () => true,
				},
				{
					workspaceScope: { workspaceId, workspacePath },
					previousBoard: createBoard({
						review: [createCard(PREREQUISITE_ID, "Prerequisite task")],
						backlog: [createCard(DEPENDENT_ID, "Dependent task")],
					}),
					nextBoard: createBoard({
						trash: [createCard(PREREQUISITE_ID, "Prerequisite task")],
						backlog: [createCard(DEPENDENT_ID, "Dependent task")],
					}),
				},
			);

			expect(result.started).toEqual([expect.objectContaining({ taskId: DEPENDENT_ID, ok: true })]);
			expect(firstUserMessages).toHaveLength(1);
			const firstUserMessage = firstUserMessages[0]?.prompt ?? "";
			expect(firstUserMessage.startsWith(`${DEPENDENCY_HANDOFF_CONTEXT_HEADER}\n`)).toBe(true);
			expect(firstUserMessage).toContain(
				`- This task is linked after ${PREREQUISITE_ID} "Prerequisite task", which completed and was moved to done.`,
			);
			expect(firstUserMessage).toContain(
				`- Its changes were committed as ${prerequisiteCommit} onto ${BASE_REF}. Inspect with: git show ${prerequisiteCommit} --stat`,
			);
			expect(firstUserMessage.endsWith("\n\nDependent task")).toBe(true);

			// The board still owns the user's original prompt: the note is only part
			// of the kickoff, never persisted onto the card.
			const state = await loadWorkspaceState(workspacePath);
			const dependentCard = state.board.columns
				.flatMap((column) => column.cards)
				.find((card) => card.id === DEPENDENT_ID);
			expect(dependentCard?.prompt).toBe("Dependent task");
			expect(dependentCard?.prompt).not.toContain(DEPENDENCY_HANDOFF_CONTEXT_HEADER);
			expect(state.board.columns.find((column) => column.id === "in_progress")?.cards[0]?.id).toBe(DEPENDENT_ID);
		});
	});
});
