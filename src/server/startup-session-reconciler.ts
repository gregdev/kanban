// Startup reconciliation for task sessions persisted in workspace state.
//
// A crash, hard kill, power loss, or WSL/VM restart leaves `running` session
// summaries on disk even though no process survives. This module turns those
// phantom sessions into the same `interrupted` shape the shutdown coordinator
// writes, moves their cards to Done (the existing restore-from-trash affordance
// resumes them), and persists the result so the board and `kanban task list`
// agree before any browser connects.

import type { RuntimeTaskSessionSummary, RuntimeWorkspaceStateResponse } from "../core/api-contract";
import { getTaskColumnId, moveTaskToColumn, updateTaskDependencies } from "../core/task-board-mutations";
import { mutateWorkspaceState } from "../state/workspace-state";
import type { TerminalSessionManager } from "../terminal/session-manager";

export interface ReconcileStartupWorkspaceSessionsInput {
	workspacePath: string;
	terminalManager: TerminalSessionManager;
	/**
	 * Sessions loaded from workspace state. Native Cline summaries are reconciled
	 * from this snapshot instead of through the terminal manager, because their
	 * live owner is the Cline session service, not a PTY.
	 */
	persistedSessions: Record<string, RuntimeTaskSessionSummary>;
}

export interface ReconcileStartupWorkspaceSessionsResult {
	/** Summaries that were persisted as running/starting and are now interrupted. */
	reconciledSummaries: RuntimeTaskSessionSummary[];
	/** Whether the reconciled board/session state was written back to disk. */
	persisted: boolean;
}

function moveReconciledCardsToTrash(
	board: RuntimeWorkspaceStateResponse["board"],
	summaries: RuntimeTaskSessionSummary[],
): RuntimeWorkspaceStateResponse["board"] {
	let nextBoard = board;
	for (const summary of summaries) {
		if (getTaskColumnId(nextBoard, summary.taskId) === "trash") {
			continue;
		}
		const moved = moveTaskToColumn(nextBoard, summary.taskId, "trash");
		if (moved.moved) {
			nextBoard = moved.board;
		}
	}
	return updateTaskDependencies(nextBoard);
}

// Cline resumability is deliberately not decided here. Every persisted active
// Cline session becomes interrupted, and `ClineTaskSessionService` later asks
// `readPersistedTaskSession` before claiming it can resume (see
// reconcileInterruptedTaskSession / isTaskSessionResumable).
function reconcilePersistedClineSessions(
	persistedSessions: Record<string, RuntimeTaskSessionSummary>,
	terminalReconciledTaskIds: Set<string>,
): RuntimeTaskSessionSummary[] {
	const reconciled: RuntimeTaskSessionSummary[] = [];
	for (const [taskId, summary] of Object.entries(persistedSessions)) {
		if (terminalReconciledTaskIds.has(taskId) || summary.state !== "running" || summary.agentId !== "cline") {
			continue;
		}
		reconciled.push({
			...summary,
			taskId,
			state: "interrupted",
			reviewReason: "interrupted",
			pid: null,
			updatedAt: Date.now(),
		});
	}
	return reconciled;
}

export async function reconcileStartupWorkspaceSessions(
	input: ReconcileStartupWorkspaceSessionsInput,
): Promise<ReconcileStartupWorkspaceSessionsResult> {
	const terminalReconciled = input.terminalManager.reconcileStaleSessions();
	const clineReconciled = reconcilePersistedClineSessions(
		input.persistedSessions,
		new Set(terminalReconciled.map((summary) => summary.taskId)),
	);
	const reconciledSummaries = [...terminalReconciled, ...clineReconciled];
	if (reconciledSummaries.length === 0) {
		return {
			reconciledSummaries,
			persisted: false,
		};
	}

	const mutation = await mutateWorkspaceState(input.workspacePath, (state) => {
		const nextBoard = moveReconciledCardsToTrash(state.board, reconciledSummaries);
		const nextSessions = {
			...state.sessions,
		};
		for (const summary of reconciledSummaries) {
			nextSessions[summary.taskId] = summary;
		}
		return {
			board: nextBoard,
			sessions: nextSessions,
			value: null,
		};
	});

	return {
		reconciledSummaries,
		persisted: mutation.saved,
	};
}
