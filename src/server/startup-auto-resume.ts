// Optional startup auto-resume.
//
// Reconcile is the safe default: interrupted tasks wait for the user to restore
// them from Done. This module implements the opt-in `autoResumeInterruptedTasks`
// behavior, which starts a bounded number of tasks that were running when the
// previous runtime died. It is intentionally conservative:
//   - off by default,
//   - capped per startup,
//   - never resumes home-agent sessions,
//   - skips CLI agents that are no longer available on PATH,
//   - for native Cline, requires a persisted SDK session (checked via
//     readPersistedTaskSession) instead of assuming the conversation survives.
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type {
	RuntimeBoardCard,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionStartResponse,
	RuntimeTaskSessionSummary,
	RuntimeWorkspaceStateResponse,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { getTaskColumnId, moveTaskToColumn, updateTaskDependencies } from "../core/task-board-mutations";
import { loadWorkspaceState, mutateWorkspaceState } from "../state/workspace-state";
import { resolveAgentCommand } from "../terminal/agent-registry";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";

export const MAX_AUTO_RESUME_TASKS_PER_STARTUP = 3;

export interface StartupAutoResumeSession {
	workspaceId: string;
	workspacePath: string;
	summary: RuntimeTaskSessionSummary;
}

export interface RunStartupAutoResumeDependencies {
	listReconciledSessions: () => StartupAutoResumeSession[];
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	startTaskSession: (
		scope: RuntimeTrpcWorkspaceScope,
		request: RuntimeTaskSessionStartRequest,
	) => Promise<RuntimeTaskSessionStartResponse>;
	warn: (message: string) => void;
	maxTasks?: number;
}

function findCard(board: RuntimeWorkspaceStateResponse["board"], taskId: string): RuntimeBoardCard | null {
	for (const column of board.columns) {
		const card = column.cards.find((candidate) => candidate.id === taskId);
		if (card) {
			return card;
		}
	}
	return null;
}

async function moveTaskBetweenColumns(
	workspacePath: string,
	taskId: string,
	fromColumnId: "trash" | "review",
	toColumnId: "review" | "trash",
): Promise<boolean> {
	const response = await mutateWorkspaceState(workspacePath, (state) => {
		if (getTaskColumnId(state.board, taskId) !== fromColumnId) {
			return {
				board: state.board,
				value: false,
				save: false,
			};
		}
		const moved = moveTaskToColumn(state.board, taskId, toColumnId);
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
	return response.value;
}

async function persistResumedSummary(workspacePath: string, summary: RuntimeTaskSessionSummary): Promise<void> {
	await mutateWorkspaceState(workspacePath, (state) => ({
		board: state.board,
		sessions: {
			...state.sessions,
			[summary.taskId]: summary,
		},
		value: null,
	}));
}

export async function runStartupAutoResume(deps: RunStartupAutoResumeDependencies): Promise<number> {
	const candidates = deps.listReconciledSessions();
	if (candidates.length === 0) {
		return 0;
	}
	const maxTasks = Math.max(0, deps.maxTasks ?? MAX_AUTO_RESUME_TASKS_PER_STARTUP);
	if (maxTasks === 0) {
		return 0;
	}

	const configByWorkspaceId = new Map<string, RuntimeConfigState>();
	const stateByWorkspacePath = new Map<string, RuntimeWorkspaceStateResponse>();
	let startedTasks = 0;
	const reportSkipped = (candidate: StartupAutoResumeSession, reason: string): void => {
		deps.warn(`Skipped auto-resume for task "${candidate.summary.taskId}". ${reason}`);
	};

	for (const [index, candidate] of candidates.entries()) {
		if (startedTasks >= maxTasks) {
			const remaining = candidates.length - index;
			deps.warn(
				`Auto-resume is limited to ${maxTasks} task(s) per startup. ${remaining} interrupted task(s) stay in Done.`,
			);
			break;
		}
		if (isHomeAgentSessionId(candidate.summary.taskId)) {
			reportSkipped(candidate, "Home agent sessions are never resumed automatically.");
			continue;
		}

		const scope: RuntimeTrpcWorkspaceScope = {
			workspaceId: candidate.workspaceId,
			workspacePath: candidate.workspacePath,
		};
		let runtimeConfig = configByWorkspaceId.get(candidate.workspaceId);
		if (!runtimeConfig) {
			try {
				runtimeConfig = await deps.loadScopedRuntimeConfig(scope);
				configByWorkspaceId.set(candidate.workspaceId, runtimeConfig);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not load runtime config for ${candidate.workspacePath}. ${message}`);
				continue;
			}
		}
		if (!runtimeConfig.autoResumeInterruptedTasks) {
			// The flag is global; if it was disabled between candidates, stop.
			break;
		}

		let workspaceState = stateByWorkspacePath.get(candidate.workspacePath);
		if (!workspaceState) {
			try {
				workspaceState = await loadWorkspaceState(candidate.workspacePath);
				stateByWorkspacePath.set(candidate.workspacePath, workspaceState);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not load workspace state for ${candidate.workspacePath}. ${message}`);
				continue;
			}
		}
		const card = findCard(workspaceState.board, candidate.summary.taskId);
		if (!card) {
			reportSkipped(candidate, "The task is no longer on the board.");
			continue;
		}

		const effectiveAgentId = candidate.summary.agentId ?? card.agentId ?? runtimeConfig.selectedAgentId;
		if (effectiveAgentId === "cline") {
			try {
				const clineTaskSessionService = await deps.getScopedClineTaskSessionService(scope);
				const reconciliation = await clineTaskSessionService.reconcileInterruptedTaskSession(candidate.summary);
				if (!reconciliation.resumable) {
					reportSkipped(candidate, "No persisted Cline session exists to resume.");
					continue;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				deps.warn(`Could not check the persisted Cline session for task "${candidate.summary.taskId}". ${message}`);
				continue;
			}
		} else {
			const resolved = resolveAgentCommand({
				...runtimeConfig,
				selectedAgentId: effectiveAgentId,
			});
			if (!resolved) {
				reportSkipped(candidate, `The ${effectiveAgentId} agent is not available on PATH.`);
				continue;
			}
		}

		try {
			const moved = await moveTaskBetweenColumns(candidate.workspacePath, card.id, "trash", "review");
			if (!moved) {
				reportSkipped(candidate, "The task is no longer in Done.");
				continue;
			}
			startedTasks += 1;
			const response = await deps.startTaskSession(scope, {
				taskId: card.id,
				prompt: "",
				taskTitle: card.title,
				baseRef: card.baseRef,
				// The persisted summary remembers which runtime owned the task. For
				// native Cline that is essential because the PTY manager deliberately
				// does not hold Cline summaries.
				agentId: effectiveAgentId,
				clineSettings: card.clineSettings,
				resumeFromTrash: true,
			});
			if (!response.ok || !response.summary) {
				await moveTaskBetweenColumns(candidate.workspacePath, card.id, "review", "trash").catch(() => false);
				deps.warn(`Could not auto-resume task "${card.id}" after restart. ${response.error ?? "Unknown error"}`);
				continue;
			}
			await persistResumedSummary(candidate.workspacePath, response.summary).catch(() => undefined);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			await moveTaskBetweenColumns(candidate.workspacePath, card.id, "review", "trash").catch(() => false);
			deps.warn(`Could not auto-resume task "${card.id}" after restart. ${message}`);
		}
	}

	return startedTasks;
}
