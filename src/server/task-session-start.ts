// Shared task-session start orchestration.
//
// Both the browser-facing runtime API and optional startup auto-resume need the
// same agent resolution, worktree, Cline provider, and checkpoint behavior. Keep
// it here so the two call sites cannot drift apart.
import { createClineProviderService } from "../cline-sdk/cline-provider-service";
import type { ClineTaskSessionService } from "../cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../config/runtime-config";
import type { RuntimeTaskSessionStartRequest, RuntimeTaskSessionStartResponse } from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveTaskTitle } from "../core/task-title.js";
import { resolveAgentCommand } from "../terminal/agent-registry";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type { RuntimeTrpcWorkspaceScope } from "../trpc/app-router";
import { resolveTaskCwd } from "../workspace/task-worktree";
import { captureTaskTurnCheckpoint } from "../workspace/turn-checkpoints";

export interface StartWorkspaceTaskSessionDependencies {
	getScopedTerminalManager: (scope: RuntimeTrpcWorkspaceScope) => Promise<TerminalSessionManager>;
	getScopedClineTaskSessionService: (scope: RuntimeTrpcWorkspaceScope) => Promise<ClineTaskSessionService>;
	loadScopedRuntimeConfig: (scope: RuntimeTrpcWorkspaceScope) => Promise<RuntimeConfigState>;
	broadcastTaskChatCleared?: (workspaceId: string, taskId: string) => void;
	clineProviderService?: ReturnType<typeof createClineProviderService>;
}

async function resolveExistingTaskCwdOrEnsure(options: {
	cwd: string;
	taskId: string;
	baseRef: string;
}): Promise<string> {
	try {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: false,
		});
	} catch {
		return await resolveTaskCwd({
			cwd: options.cwd,
			taskId: options.taskId,
			baseRef: options.baseRef,
			ensure: true,
		});
	}
}

export async function startWorkspaceTaskSession(
	deps: StartWorkspaceTaskSessionDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	body: RuntimeTaskSessionStartRequest,
): Promise<RuntimeTaskSessionStartResponse> {
	try {
		if (body.resumeFromTrash) {
			deps.broadcastTaskChatCleared?.(workspaceScope.workspaceId, body.taskId);
		}
		const requestedClineTaskMode = body.mode ?? "act";
		const scopedRuntimeConfig = await deps.loadScopedRuntimeConfig(workspaceScope);
		const taskCwd = isHomeAgentSessionId(body.taskId)
			? workspaceScope.workspacePath
			: await resolveExistingTaskCwdOrEnsure({
					cwd: workspaceScope.workspacePath,
					taskId: body.taskId,
					baseRef: body.baseRef,
				});
		const shouldCaptureTurnCheckpoint = !body.resumeFromTrash && !isHomeAgentSessionId(body.taskId);

		// Per-task config source-of-truth precedence:
		//
		// agentId resolution (which agent runtime to use):
		//   1. previousTerminalAgentId — persisted in the terminal session summary from
		//      the last run; ensures trash-restore resumes with the same agent runtime.
		//   2. body.agentId — the card's current per-task agent override.
		//   3. scopedRuntimeConfig.selectedAgentId — the workspace-level default.
		//
		// clineSettings (which LLM model and reasoning profile the Cline agent uses):
		//   Always taken from the card's current override object. There is no
		//   session-level persistence for these;
		//   if the user changes the model on the card, the next session launch
		//   (including trash-restore) uses the updated values.
		const terminalManager = await deps.getScopedTerminalManager(workspaceScope);
		const previousTerminalAgentId = body.resumeFromTrash
			? (terminalManager.getSummary(body.taskId)?.agentId ?? null)
			: null;
		const effectiveAgentId = previousTerminalAgentId ?? body.agentId ?? scopedRuntimeConfig.selectedAgentId;
		let useClinePath = effectiveAgentId === "cline";
		const shouldProbePersistedClineSession =
			body.resumeFromTrash && !useClinePath && previousTerminalAgentId === null;
		if (shouldProbePersistedClineSession) {
			// If the terminal summary already has a concrete non-Cline agentId,
			// skip Cline persisted-session probing. That probe can cold-start the
			// Cline session host and adds multi-second latency to Codex restores.
			const clineSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
			const persistedSession = await clineSessionService.rebindPersistedTaskSession(body.taskId).catch(() => null);
			if (persistedSession) {
				useClinePath = true;
			}
		}

		if (useClinePath) {
			return await startClineTaskSession(deps, workspaceScope, body, {
				taskCwd,
				requestedClineTaskMode,
				shouldCaptureTurnCheckpoint,
				agentCommandTimeoutSec: scopedRuntimeConfig.agentCommandTimeoutSec,
			});
		}

		return await startTerminalTaskSession(workspaceScope, body, scopedRuntimeConfig, terminalManager, {
			taskCwd,
			effectiveAgentId,
			shouldCaptureTurnCheckpoint,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			summary: null,
			error: message,
		};
	}
}

async function startClineTaskSession(
	deps: StartWorkspaceTaskSessionDependencies,
	workspaceScope: RuntimeTrpcWorkspaceScope,
	body: RuntimeTaskSessionStartRequest,
	context: {
		taskCwd: string;
		requestedClineTaskMode: "act" | "plan";
		shouldCaptureTurnCheckpoint: boolean;
		agentCommandTimeoutSec: number;
	},
): Promise<RuntimeTaskSessionStartResponse> {
	const clineProviderService = deps.clineProviderService ?? createClineProviderService();
	const hasTaskLevelClineSettingsOverride = body.clineSettings !== undefined;
	const clineLaunchConfig = await clineProviderService.resolveLaunchConfig({
		providerIdOverride: body.clineSettings?.providerId ?? undefined,
		modelIdOverride: body.clineSettings?.modelId ?? undefined,
		...(hasTaskLevelClineSettingsOverride
			? {
					reasoningEffortOverride: body.clineSettings?.reasoningEffort ?? null,
				}
			: {}),
	});
	const clineTaskSessionService = await deps.getScopedClineTaskSessionService(workspaceScope);
	const resolvedClineTitle = resolveTaskTitle(body.taskTitle?.trim(), body.prompt);
	const summary = await clineTaskSessionService.startTaskSession({
		taskId: body.taskId,
		cwd: context.taskCwd,
		prompt: body.prompt,
		taskTitle: resolvedClineTitle.length > 0 ? resolvedClineTitle : undefined,
		images: body.images,
		resumeFromTrash: body.resumeFromTrash,
		providerId: clineLaunchConfig.providerId,
		modelId: clineLaunchConfig.modelId,
		mode: context.requestedClineTaskMode,
		startInPlanMode: body.startInPlanMode,
		apiKey: clineLaunchConfig.apiKey,
		baseUrl: clineLaunchConfig.baseUrl,
		reasoningEffort: clineLaunchConfig.reasoningEffort,
		agentCommandTimeoutSec: context.agentCommandTimeoutSec,
	});

	let nextSummary = summary;
	if (context.shouldCaptureTurnCheckpoint) {
		try {
			const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
			const checkpoint = await captureTaskTurnCheckpoint({
				cwd: context.taskCwd,
				taskId: body.taskId,
				turn: nextTurn,
			});
			nextSummary = clineTaskSessionService.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
		} catch {
			// Best effort checkpointing only.
		}
	}

	return {
		ok: true,
		summary: nextSummary,
	};
}

async function startTerminalTaskSession(
	workspaceScope: RuntimeTrpcWorkspaceScope,
	body: RuntimeTaskSessionStartRequest,
	scopedRuntimeConfig: RuntimeConfigState,
	terminalManager: TerminalSessionManager,
	context: {
		taskCwd: string;
		effectiveAgentId: NonNullable<RuntimeTaskSessionStartRequest["agentId"]>;
		shouldCaptureTurnCheckpoint: boolean;
	},
): Promise<RuntimeTaskSessionStartResponse> {
	const resolvedConfig =
		context.effectiveAgentId !== scopedRuntimeConfig.selectedAgentId
			? { ...scopedRuntimeConfig, selectedAgentId: context.effectiveAgentId }
			: scopedRuntimeConfig;
	const resolved = resolveAgentCommand(resolvedConfig);
	if (!resolved) {
		return {
			ok: false,
			summary: null,
			error: "No runnable agent command is configured. Open Settings, install a supported CLI, and select it.",
		};
	}
	const summary = await terminalManager.startTaskSession({
		taskId: body.taskId,
		agentId: resolved.agentId,
		binary: resolved.binary,
		args: resolved.args,
		autonomousModeEnabled: scopedRuntimeConfig.agentAutonomousModeEnabled,
		cwd: context.taskCwd,
		prompt: body.prompt,
		images: body.images,
		startInPlanMode: body.startInPlanMode,
		resumeFromTrash: body.resumeFromTrash,
		cols: body.cols,
		rows: body.rows,
		workspaceId: workspaceScope.workspaceId,
	});

	let nextSummary = summary;
	if (context.shouldCaptureTurnCheckpoint) {
		try {
			const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
			const checkpoint = await captureTaskTurnCheckpoint({
				cwd: context.taskCwd,
				taskId: body.taskId,
				turn: nextTurn,
			});
			nextSummary = terminalManager.applyTurnCheckpoint(body.taskId, checkpoint) ?? summary;
		} catch {
			// Best effort checkpointing only.
		}
	}
	return {
		ok: true,
		summary: nextSummary,
	};
}
