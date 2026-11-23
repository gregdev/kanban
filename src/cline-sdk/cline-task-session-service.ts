// Task-oriented facade for native Cline sessions.
// runtime-api.ts uses this service to start sessions, send messages, load
// history, and subscribe to summaries and chat events without knowing SDK
// host, repository, or event-adapter details.
import type {
	RuntimeClineReasoningEffort,
	RuntimeTaskImage,
	RuntimeTaskSessionMode,
	RuntimeTaskSessionSummary,
	RuntimeTaskTurnCheckpoint,
} from "../core/api-contract";
import { isHomeAgentSessionId } from "../core/home-agent-session";
import { resolveHomeAgentAppendSystemPrompt } from "../prompts/append-system-prompt";
import { captureTaskTurnCheckpoint, deleteTaskTurnCheckpointRef } from "../workspace/turn-checkpoints";
import {
	compactPersistedMessagesForContextOverflow,
	isContextOverflowError,
} from "./cline-context-overflow-compaction";
import { isMissingToolResultError } from "./cline-conversation-repair";
import { applyClineSessionEvent } from "./cline-event-adapter";
import {
	type ClineMessageRepository,
	createInMemoryClineMessageRepository,
	createTaskEntryFromPersistedSession,
} from "./cline-message-repository";
import { createClineProviderService, type ResolvedClineLaunchConfig } from "./cline-provider-service";
import { type ClineRuntimeSetup, createClineRuntimeSetup } from "./cline-runtime-setup";
import { ClineSessionConfigUnavailableError } from "./cline-session-errors";
import type { ClineRestartLaunchContext, ClineRestartLaunchContextRequest } from "./cline-session-launch-config";
import {
	type ClineSessionRuntime,
	type CreateInMemoryClineSessionRuntimeOptions,
	createInMemoryClineSessionRuntime,
} from "./cline-session-runtime";
import {
	type ClineTaskMessage,
	type ClineTaskSessionEntry,
	clearActiveTurnState,
	cloneSummary,
	createAssistantMessage,
	createDefaultSummary,
	createMessage,
	isCreditLimitError,
	now,
	setOrCreateAssistantMessage,
	updateSummary,
} from "./cline-session-state";
import {
	CLINE_RESUME_TURN_INSTRUCTION,
	CLINE_RESUME_TURN_SYSTEM_MESSAGE,
	canResumeClineTurn,
	isMissingLiveClineSessionError,
	resolveClineTurnResumeRefusal,
} from "./cline-turn-resume";
import {
	type ClineRuntimeSetupLease,
	type ClineWatcherRegistry,
	createClineWatcherRegistry,
} from "./cline-watcher-registry";
import { SDK_DEFAULT_MODEL_ID, SDK_DEFAULT_PROVIDER_ID } from "./sdk-provider-boundary";
import {
	type ClineSdkPersistedMessage,
	type ClineSdkSlashCommand,
	listClineSdkWorkflowSlashCommands,
	resolveClineSdkSystemPrompt,
} from "./sdk-runtime-boundary.js";

export type { ClineTaskMessage } from "./cline-session-state";

export interface StartClineTaskSessionRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	startInPlanMode?: boolean;
	/** Normalized Kanban task title; written to SDK session metadata (best-effort). */
	taskTitle?: string;
	initialMessages?: ClineSdkPersistedMessage[];
	images?: RuntimeTaskImage[];
	resumeFromTrash?: boolean;
	resumeFromPersistence?: boolean;
	providerId?: string | null;
	modelId?: string | null;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	/** Per-command timeout for the native agent's `run_commands` tool. */
	agentCommandTimeoutSec?: number;
	systemPrompt?: string | null;
}

export type ClineTaskTurnResumeOutcome = "resumed" | "already_running" | "not_found" | "not_resumable" | "refused";

export interface ClineTaskTurnResumeResult {
	outcome: ClineTaskTurnResumeOutcome;
	summary: RuntimeTaskSessionSummary | null;
	error?: string;
}

export interface ClineTaskSessionService {
	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void;
	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void;
	startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary>;
	stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	resumeTaskTurn(taskId: string): Promise<ClineTaskTurnResumeResult>;
	sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null>;
	reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null>;
	getSummary(taskId: string): RuntimeTaskSessionSummary | null;
	listSummaries(): RuntimeTaskSessionSummary[];
	listMessages(taskId: string): ClineTaskMessage[];
	listSlashCommands(workspacePath: string): Promise<ClineSdkSlashCommand[]>;
	loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]>;
	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null;
	dispose(): Promise<void>;
}

/** Narrow view of the provider service needed to rebuild a restart launch config. */
export interface ClineTaskSessionProviderConfigResolver {
	resolveLaunchConfig(overrides?: {
		providerIdOverride?: string;
		modelIdOverride?: string;
	}): Promise<ResolvedClineLaunchConfig>;
}

export interface CreateInMemoryClineTaskSessionServiceOptions {
	createSessionRuntime?: (options: CreateInMemoryClineSessionRuntimeOptions) => ClineSessionRuntime;
	createMessageRepository?: () => ClineMessageRepository;
	createRuntimeSetup?: (workspacePath: string) => Promise<ClineRuntimeSetup>;
	watcherRegistry?: ClineWatcherRegistry;
	createProviderConfigResolver?: () => ClineTaskSessionProviderConfigResolver;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message.length > 0) {
			return message;
		}
	}
	return "Unknown error";
}

function readAgentResultText(result: unknown): string | null {
	if (!result || typeof result !== "object") {
		return null;
	}
	if (!("text" in result)) {
		return null;
	}
	const text = result.text;
	if (typeof text !== "string") {
		return null;
	}
	const normalized = text.trim();
	return normalized.length > 0 ? normalized : null;
}

function formatStartWarnings(warnings: readonly string[] | undefined): string | null {
	if (!warnings) {
		return null;
	}
	const normalized = warnings.map((warning) => warning.trim()).filter((warning) => warning.length > 0);
	if (normalized.length === 0) {
		return null;
	}
	if (normalized.length === 1) {
		return normalized[0] ?? null;
	}
	return `${normalized[0]} (+${normalized.length - 1} more MCP warning${normalized.length === 2 ? "" : "s"})`;
}

function buildClineStartPrompt(prompt: string, startInPlanMode?: boolean): string {
	if (!startInPlanMode) {
		return prompt;
	}
	const trimmedPrompt = prompt.trim();
	return [
		"First, inspect the codebase and produce a clear implementation plan only.",
		"Do not modify files, do not use write tools, and do not implement anything yet.",
		"After you present the plan, ask for approval before making changes.",
		trimmedPrompt ? `\n\nTask:\n${trimmedPrompt}` : " Ask the user what they want planned if the task is unclear.",
	].join(" ");
}
export class InMemoryClineTaskSessionService implements ClineTaskSessionService {
	private readonly pendingTurnCancelTaskIds = new Set<string>();
	private readonly providerIdByTaskId = new Map<string, string>();
	private readonly sessionRuntime: ClineSessionRuntime;
	private readonly messageRepository: ClineMessageRepository;
	private readonly watcherRegistry: ClineWatcherRegistry;
	private readonly providerConfigResolver: ClineTaskSessionProviderConfigResolver;
	private readonly runtimeSetupLeaseByWorkspacePath = new Map<string, Promise<ClineRuntimeSetupLease>>();

	constructor(options: CreateInMemoryClineTaskSessionServiceOptions = {}) {
		const createSessionRuntime = options.createSessionRuntime ?? createInMemoryClineSessionRuntime;
		const createMessageRepository = options.createMessageRepository ?? createInMemoryClineMessageRepository;
		const createProviderConfigResolver = options.createProviderConfigResolver ?? createClineProviderService;
		this.providerConfigResolver = createProviderConfigResolver();
		this.watcherRegistry =
			options.watcherRegistry ??
			createClineWatcherRegistry({
				createRuntimeSetup: options.createRuntimeSetup ?? createClineRuntimeSetup,
			});
		this.sessionRuntime = createSessionRuntime({
			onTaskEvent: (taskId: string, event: unknown) => {
				this.handleTaskEvent(taskId, event);
			},
			// A restart can outlive the in-memory start request (runtime rebuild,
			// crash recovery). Rebuild the system prompt and provider credentials
			// from the same sources the initial start used.
			resolveRestartLaunchConfig: (input) => this.resolveRestartLaunchConfig(input),
		});
		this.messageRepository = createMessageRepository();
	}

	onSummary(listener: (summary: RuntimeTaskSessionSummary) => void): () => void {
		return this.messageRepository.onSummary(listener);
	}

	onMessage(listener: (taskId: string, message: ClineTaskMessage) => void): () => void {
		return this.messageRepository.onMessage(listener);
	}

	private resolveProviderIdForTask(taskId: string): string {
		const cached = this.providerIdByTaskId.get(taskId);
		if (cached) {
			return cached;
		}
		// Fall back to the runtime's last-start-request for tasks rebound from persistence.
		const fromRuntime = this.sessionRuntime.getTaskProviderId(taskId);
		if (fromRuntime) {
			this.providerIdByTaskId.set(taskId, fromRuntime);
			return fromRuntime;
		}
		return SDK_DEFAULT_PROVIDER_ID;
	}

	private isClineProviderForTask(taskId: string): boolean {
		return this.resolveProviderIdForTask(taskId) === "cline";
	}

	private emitTaskFailure(
		taskId: string,
		entry: ClineTaskSessionEntry,
		context: "start" | "send" | "resume",
		error: unknown,
	): void {
		const errorMessage = toErrorMessage(error);
		const creditLimitError = this.isClineProviderForTask(taskId) && isCreditLimitError(errorMessage);
		// A missing launch config is a configuration problem, not a crashed SDK
		// call. Keep its actionable guidance intact instead of prefixing it with
		// "Cline SDK ... failed" and inviting another message that cannot work.
		const configUnavailable = error instanceof ClineSessionConfigUnavailableError;
		if (!creditLimitError) {
			const systemMessage = createMessage(
				taskId,
				"system",
				configUnavailable
					? errorMessage
					: `Cline SDK ${context} failed: ${errorMessage}. You can send another message to continue the conversation.`,
			);
			entry.messages.push(systemMessage);
			this.emitMessage(taskId, systemMessage);
		}
		clearActiveTurnState(entry);
		const errorSummary = updateSummary(entry, {
			state: "awaiting_review",
			reviewReason: "error",
			lastOutputAt: now(),
			lastHookAt: now(),
			warningMessage: creditLimitError ? null : errorMessage,
			latestHookActivity: {
				activityText: configUnavailable
					? errorMessage
					: `${context === "start" ? "Start" : context === "send" ? "Send" : "Resume"} failed: ${errorMessage}`,
				toolName: null,
				toolInputSummary: null,
				finalMessage: errorMessage,
				hookEventName: "agent_error",
				notificationType: creditLimitError ? "credit_limit" : null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(errorSummary);
	}

	private async dispatchResolvedTaskInput(input: {
		taskId: string;
		prompt: string;
		mode?: RuntimeTaskSessionMode;
		images?: RuntimeTaskImage[];
		delivery?: "queue" | "steer";
	}): Promise<{
		result: unknown;
		warnings?: string[];
	}> {
		if (this.sessionRuntime.getTaskSessionId(input.taskId)) {
			return {
				result: await this.sessionRuntime.sendTaskSessionInput(
					input.taskId,
					input.prompt,
					input.mode,
					input.images,
					input.delivery,
				),
			};
		}

		if (isHomeAgentSessionId(input.taskId) && !(await this.sessionRuntime.canRestartTaskSession(input.taskId))) {
			throw new ClineSessionConfigUnavailableError(input.taskId);
		}

		const persistedSnapshot = await this.sessionRuntime.readPersistedTaskSession(input.taskId);
		const restartedSession = await this.sessionRuntime.restartTaskSession({
			taskId: input.taskId,
			prompt: input.prompt,
			mode: input.mode,
			images: input.images,
			initialMessages: persistedSnapshot?.messages,
		});
		return {
			result: restartedSession.result,
			warnings: restartedSession.warnings,
		};
	}

	private async retryAfterContextOverflow(input: {
		taskId: string;
		prompt: string;
		mode: RuntimeTaskSessionMode;
		images?: RuntimeTaskImage[];
		error: unknown;
	}): Promise<{ result: unknown; warnings?: string[] } | null> {
		if (!isContextOverflowError(input.error)) {
			return null;
		}

		const persistedSnapshot = await this.sessionRuntime.readPersistedTaskSession(input.taskId).catch(() => null);
		const compactedMessages = compactPersistedMessagesForContextOverflow(persistedSnapshot?.messages ?? []);
		if (!compactedMessages) {
			return null;
		}

		await this.sessionRuntime.stopTaskSession(input.taskId).catch(() => null);
		const restartedSession = await this.sessionRuntime.restartTaskSession({
			taskId: input.taskId,
			prompt: input.prompt,
			mode: input.mode,
			images: input.images,
			initialMessages: compactedMessages,
		});
		return {
			result: restartedSession.result,
			warnings: restartedSession.warnings,
		};
	}

	// Providers reject a conversation containing an assistant tool call without
	// a matching tool result ("Tool result is missing for tool call ..."). The
	// live SDK session keeps that dangling call in memory, so replaying the same
	// session fails forever. Rebuild the session from repaired persisted history.
	private async retryAfterMissingToolResult(input: {
		taskId: string;
		prompt: string;
		mode: RuntimeTaskSessionMode;
		images?: RuntimeTaskImage[];
		error: unknown;
	}): Promise<{ result: unknown; warnings?: string[] } | null> {
		if (!isMissingToolResultError(input.error)) {
			return null;
		}

		const persistedSnapshot = await this.sessionRuntime.readPersistedTaskSession(input.taskId).catch(() => null);
		if (!persistedSnapshot || persistedSnapshot.messages.length === 0) {
			return null;
		}

		await this.sessionRuntime.stopTaskSession(input.taskId).catch(() => null);
		// startTaskSession repairs dangling tool calls before replaying history.
		const restartedSession = await this.sessionRuntime.restartTaskSession({
			taskId: input.taskId,
			prompt: input.prompt,
			mode: input.mode,
			images: input.images,
			initialMessages: persistedSnapshot.messages,
		});
		return {
			result: restartedSession.result,
			warnings: restartedSession.warnings,
		};
	}

	async startTaskSession(request: StartClineTaskSessionRequest): Promise<RuntimeTaskSessionSummary> {
		const existing = this.messageRepository.getTaskEntry(request.taskId);
		if (
			!request.resumeFromTrash &&
			!request.resumeFromPersistence &&
			existing &&
			(existing.summary.state === "running" || existing.summary.state === "awaiting_review")
		) {
			return cloneSummary(existing.summary);
		}

		const providerId = request.providerId?.trim().toLowerCase() || SDK_DEFAULT_PROVIDER_ID;
		this.providerIdByTaskId.set(request.taskId, providerId);
		const modelId = request.modelId?.trim() || SDK_DEFAULT_MODEL_ID;
		const resolvedMode: RuntimeTaskSessionMode = request.startInPlanMode ? "act" : (request.mode ?? "act");
		const normalizedPrompt = request.prompt.trim();
		const hasRequestImages = Boolean(request.images && request.images.length > 0);
		const initialState = request.resumeFromTrash
			? "awaiting_review"
			: normalizedPrompt.length > 0 || hasRequestImages
				? "running"
				: "idle";
		const initialReviewReason = request.resumeFromTrash ? "attention" : null;
		const shouldHydratePersistedHistory = request.resumeFromTrash || request.resumeFromPersistence;
		const persistedResumeSnapshot = shouldHydratePersistedHistory
			? await this.sessionRuntime.readPersistedTaskSession(request.taskId).catch(() => null)
			: null;

		const entry = persistedResumeSnapshot
			? createTaskEntryFromPersistedSession(request.taskId, persistedResumeSnapshot.messages, {
					state: initialState,
					mode: resolvedMode,
					workspacePath: request.cwd,
					startedAt: now(),
					lastOutputAt: now(),
					reviewReason: initialReviewReason,
				})
			: ({
					summary: {
						...createDefaultSummary(request.taskId),
						state: initialState,
						mode: resolvedMode,
						workspacePath: request.cwd,
						startedAt: now(),
						lastOutputAt: now(),
						reviewReason: initialReviewReason,
					},
					messages: [],
					activeAssistantMessageId: null,
					activeReasoningMessageId: null,
					toolMessageIdByToolCallId: new Map<string, string>(),
					toolInputByToolCallId: new Map<string, unknown>(),
				} satisfies ClineTaskSessionEntry);
		this.messageRepository.setTaskEntry(request.taskId, entry);
		this.pendingTurnCancelTaskIds.delete(request.taskId);

		if (!request.resumeFromTrash && (normalizedPrompt.length > 0 || hasRequestImages)) {
			const message = createMessage(request.taskId, "user", normalizedPrompt, request.images);
			entry.messages.push(message);
			this.emitMessage(request.taskId, message);
			const runningSummary = updateSummary(entry, {
				state: "running",
				reviewReason: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(runningSummary);
		}
		this.emitSummary(entry.summary);

		void (async () => {
			const assistantCountBeforeStart = entry.messages.filter((message) => message.role === "assistant").length;
			try {
				const runtimeSetup = await this.ensureRuntimeSetup(request.cwd);
				const runtimePrompt = runtimeSetup.resolvePrompt(
					buildClineStartPrompt(request.prompt, request.startInPlanMode),
				);
				let systemPrompt =
					request.systemPrompt?.trim() ||
					(await resolveClineSdkSystemPrompt({
						cwd: request.cwd,
						providerId,
						rules: runtimeSetup.loadRules(),
					}));
				const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(request.taskId);
				if (appendedSystemPrompt) {
					systemPrompt = `${systemPrompt}\n\n${appendedSystemPrompt}`;
				}

				const startResult = await this.sessionRuntime.startTaskSession({
					taskId: request.taskId,
					cwd: request.cwd,
					prompt: runtimePrompt,
					taskTitle: request.taskTitle,
					initialMessages: persistedResumeSnapshot?.messages ?? request.initialMessages,
					images: request.images,
					providerId,
					modelId,
					mode: resolvedMode,
					apiKey: request.apiKey,
					baseUrl: request.baseUrl,
					reasoningEffort: request.reasoningEffort,
					agentCommandTimeoutSec: request.agentCommandTimeoutSec,
					systemPrompt,
					userInstructionService: runtimeSetup.userInstructionService,
					requestToolApproval: runtimeSetup.requestToolApproval,
				});
				const warningMessage = formatStartWarnings(startResult.warnings);
				if (warningMessage) {
					this.emitSummary(
						updateSummary(entry, {
							warningMessage,
						}),
					);
				}

				const initialAgentText = readAgentResultText(startResult.result);
				if (initialAgentText) {
					const assistantCountAfterStart = entry.messages.filter((message) => message.role === "assistant").length;
					if (assistantCountAfterStart > assistantCountBeforeStart) {
						return;
					}
					const agentMessage =
						setOrCreateAssistantMessage(entry, request.taskId, initialAgentText) ??
						createAssistantMessage(entry, request.taskId, initialAgentText);
					this.emitMessage(request.taskId, agentMessage);
				}
			} catch (error) {
				this.emitTaskFailure(request.taskId, entry, "start", error);
			}
		})();

		return cloneSummary(entry.summary);
	}

	async stopTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		let entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			// Runtime restarts can clear in-memory task entries while the SDK still has a persisted
			// session for this task. Rebind first so stop() can target that recovered session id.
			const reboundSummary = await this.rebindPersistedTaskSession(taskId);
			if (!reboundSummary) {
				return null;
			}
			entry = this.messageRepository.getTaskEntry(taskId);
			if (!entry) {
				return reboundSummary;
			}
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.sessionRuntime.stopTaskSession(taskId).catch(() => null);
		if (entry.summary.state === "idle") {
			return cloneSummary(entry.summary);
		}
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async abortTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.sessionRuntime.abortTaskSession(taskId).catch(() => null);
		const summary = updateSummary(entry, {
			state: "interrupted",
			reviewReason: "interrupted",
			exitCode: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async cancelTaskTurn(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			return null;
		}
		if (entry.summary.state !== "running") {
			return null;
		}
		this.pendingTurnCancelTaskIds.add(taskId);
		await this.sessionRuntime.abortTaskSession(taskId).catch(() => null);
		clearActiveTurnState(entry);
		const summary = updateSummary(entry, {
			state: "idle",
			reviewReason: null,
			exitCode: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Turn canceled",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_canceled",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(summary);
		return summary;
	}

	// Explicit, single-shot recovery for a native Cline turn that died mid-flight.
	// The SDK has no native resume API, so this rebinds the persisted session and
	// sends one continuation instruction. It never re-adds the original user
	// message and never re-sends already-applied tool results.
	async resumeTaskTurn(taskId: string): Promise<ClineTaskTurnResumeResult> {
		let entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			const reboundSummary = await this.rebindPersistedTaskSession(taskId);
			if (!reboundSummary) {
				return {
					outcome: "not_found",
					summary: null,
					error: "This task has no Cline session to resume.",
				};
			}
			entry = this.messageRepository.getTaskEntry(taskId);
			if (!entry) {
				return {
					outcome: "not_found",
					summary: reboundSummary,
					error: "This task has no Cline session to resume.",
				};
			}
		}

		if (entry.summary.state === "running") {
			return {
				outcome: "already_running",
				summary: cloneSummary(entry.summary),
			};
		}

		if (!canResumeClineTurn(entry.summary)) {
			return {
				outcome: "not_resumable",
				summary: cloneSummary(entry.summary),
				error: "Only interrupted turns or turns stopped by an error can be resumed.",
			};
		}

		const refusal = resolveClineTurnResumeRefusal(entry.summary);
		if (refusal) {
			return {
				outcome: "refused",
				summary: cloneSummary(entry.summary),
				error: refusal.message,
			};
		}

		// A user-requested resume supersedes any pending cancellation.
		this.pendingTurnCancelTaskIds.delete(taskId);

		// Rebind to the latest persisted session before changing observable state
		// so a task with nothing to resume fails without flapping the board.
		const persistedSnapshot = await this.sessionRuntime.resumeTaskSession(taskId).catch(() => null);
		if (!persistedSnapshot && !this.sessionRuntime.getTaskSessionId(taskId)) {
			return {
				outcome: "not_found",
				summary: cloneSummary(entry.summary),
				error: "This task has no Cline session to resume.",
			};
		}

		clearActiveTurnState(entry);
		const systemMessage = createMessage(taskId, "system", CLINE_RESUME_TURN_SYSTEM_MESSAGE);
		entry.messages.push(systemMessage);
		this.emitMessage(taskId, systemMessage);

		const effectiveMode: RuntimeTaskSessionMode = entry.summary.mode ?? "act";
		const runningSummary = updateSummary(entry, {
			state: "running",
			mode: effectiveMode,
			reviewReason: null,
			warningMessage: null,
			lastOutputAt: now(),
			lastHookAt: now(),
			latestHookActivity: {
				activityText: "Resuming interrupted turn",
				toolName: null,
				toolInputSummary: null,
				finalMessage: null,
				hookEventName: "turn_start",
				notificationType: null,
				source: "cline-sdk",
			},
		});
		this.emitSummary(runningSummary);

		const assistantCountBeforeResume = entry.messages.filter((message) => message.role === "assistant").length;
		void (async () => {
			try {
				const result = await this.dispatchResumeTurn({
					taskId,
					mode: effectiveMode,
					persistedMessages: persistedSnapshot?.messages,
				});
				const agentText = readAgentResultText(result);
				if (agentText) {
					const assistantCountAfterResume = entry.messages.filter(
						(message) => message.role === "assistant",
					).length;
					if (assistantCountAfterResume <= assistantCountBeforeResume) {
						const agentMessage =
							setOrCreateAssistantMessage(entry, taskId, agentText) ??
							createAssistantMessage(entry, taskId, agentText);
						this.emitMessage(taskId, agentMessage);
					}
				}
				// `done`/`ended` events normally drive the terminal transition. If a
				// host returns the result inline without them, never leave the board
				// stuck on `running`.
				if (entry.summary.state === "running") {
					clearActiveTurnState(entry);
					this.emitSummary(
						updateSummary(entry, {
							state: "awaiting_review",
							reviewReason: null,
							warningMessage: null,
							lastOutputAt: now(),
							lastHookAt: now(),
						}),
					);
				}
			} catch (error) {
				this.emitTaskFailure(taskId, entry, "resume", error);
			}
		})();

		return {
			outcome: "resumed",
			summary: cloneSummary(entry.summary),
		};
	}

	private async dispatchResumeTurn(input: {
		taskId: string;
		mode: RuntimeTaskSessionMode;
		persistedMessages?: ClineSdkPersistedMessage[];
	}): Promise<unknown> {
		try {
			const resumed = await this.sessionRuntime.resumeTaskTurn({
				taskId: input.taskId,
				prompt: CLINE_RESUME_TURN_INSTRUCTION,
				mode: input.mode,
			});
			return resumed.result;
		} catch (error) {
			// A persisted session can outlive the live SDK host. Rebuild a live
			// session from repaired persisted history exactly once; this is not a
			// retry loop and the SDK still owns bounded retries for the new turn.
			if (
				!isMissingLiveClineSessionError(error) ||
				!(await this.sessionRuntime.canRestartTaskSession(input.taskId))
			) {
				throw error;
			}
			const persistedMessages =
				input.persistedMessages && input.persistedMessages.length > 0
					? input.persistedMessages
					: (await this.sessionRuntime.readPersistedTaskSession(input.taskId).catch(() => null))?.messages;
			if (!persistedMessages || persistedMessages.length === 0) {
				throw error;
			}
			const restarted = await this.sessionRuntime.restartTaskSession({
				taskId: input.taskId,
				prompt: CLINE_RESUME_TURN_INSTRUCTION,
				mode: input.mode,
				initialMessages: persistedMessages,
			});
			return restarted.result;
		}
	}

	async sendTaskSessionInput(
		taskId: string,
		text: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
	): Promise<RuntimeTaskSessionSummary | null> {
		const entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			return null;
		}
		if (
			entry.summary.state !== "running" &&
			entry.summary.state !== "awaiting_review" &&
			entry.summary.state !== "idle" &&
			entry.summary.state !== "failed"
		) {
			return null;
		}
		this.pendingTurnCancelTaskIds.delete(taskId);
		const normalized = text.trim();
		const hasImages = Boolean(images && images.length > 0);
		const effectiveMode: RuntimeTaskSessionMode = mode ?? entry.summary.mode ?? "act";
		if (normalized.length === 0 && !hasImages) {
			return null;
		}
		if (!this.sessionRuntime.getTaskSessionId(taskId)) {
			if (isHomeAgentSessionId(taskId) && !(await this.sessionRuntime.canRestartTaskSession(taskId))) {
				return null;
			}
		}
		{
			const message = createMessage(taskId, "user", normalized, images);
			entry.messages.push(message);
			this.emitMessage(taskId, message);
			clearActiveTurnState(entry);
			const queueDelivery = entry.summary.state === "running";
			const waitingSummary = updateSummary(entry, {
				state: "running",
				mode: effectiveMode,
				reviewReason: null,
				warningMessage: null,
				lastOutputAt: now(),
				lastHookAt: now(),
				latestHookActivity: {
					activityText: "Agent active",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "turn_start",
					notificationType: null,
					source: "cline-sdk",
				},
			});
			this.emitSummary(waitingSummary);
			const assistantCountBeforeSend = entry.messages.filter((message) => message.role === "assistant").length;
			void this.ensureRuntimeSetup(entry.summary.workspacePath ?? "")
				.then(async (runtimeSetup) => {
					const resolvedPrompt = runtimeSetup.resolvePrompt(normalized);
					try {
						return await this.dispatchResolvedTaskInput({
							taskId,
							prompt: resolvedPrompt,
							mode: effectiveMode,
							images,
							delivery: queueDelivery ? "queue" : undefined,
						});
					} catch (error) {
						const overflowRecovered = await this.retryAfterContextOverflow({
							taskId,
							prompt: resolvedPrompt,
							mode: effectiveMode,
							images,
							error,
						});
						if (overflowRecovered) {
							return overflowRecovered;
						}
						const toolResultRecovered = await this.retryAfterMissingToolResult({
							taskId,
							prompt: resolvedPrompt,
							mode: effectiveMode,
							images,
							error,
						});
						if (toolResultRecovered) {
							return toolResultRecovered;
						}
						throw error;
					}
				})
				.then(({ result, warnings }) => {
					const warningMessage = formatStartWarnings(warnings);
					if (warningMessage) {
						this.emitSummary(
							updateSummary(entry, {
								warningMessage,
							}),
						);
					}
					const agentText = readAgentResultText(result);
					if (agentText) {
						const assistantCountAfterSend = entry.messages.filter(
							(message) => message.role === "assistant",
						).length;
						if (assistantCountAfterSend > assistantCountBeforeSend) {
							return;
						}
						const agentMessage =
							setOrCreateAssistantMessage(entry, taskId, agentText) ??
							createAssistantMessage(entry, taskId, agentText);
						this.emitMessage(taskId, agentMessage);
					}
				})
				.catch((error: unknown) => {
					this.emitTaskFailure(taskId, entry, "send", error);
				});
		}
		const summary = updateSummary(entry, {
			state: "running",
			mode: effectiveMode,
			reviewReason: null,
			lastOutputAt: now(),
		});
		this.emitSummary(summary);
		return summary;
	}

	async reloadTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		let entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			const reboundSummary = await this.rebindPersistedTaskSession(taskId);
			if (!reboundSummary) {
				return null;
			}
			entry = this.messageRepository.getTaskEntry(taskId);
			if (!entry) {
				return reboundSummary;
			}
		}

		this.pendingTurnCancelTaskIds.delete(taskId);
		await this.sessionRuntime.stopTaskSession(taskId).catch(() => null);
		clearActiveTurnState(entry);

		const effectiveMode: RuntimeTaskSessionMode = entry.summary.mode ?? "act";
		if (!this.sessionRuntime.getTaskSessionId(taskId)) {
			if (isHomeAgentSessionId(taskId) && !(await this.sessionRuntime.canRestartTaskSession(taskId))) {
				return null;
			}
		}
		try {
			const { warnings } = await this.dispatchResolvedTaskInput({
				taskId,
				prompt: "",
				mode: effectiveMode,
			});
			const warningMessage = formatStartWarnings(warnings);
			const summary = updateSummary(entry, {
				state: "idle",
				mode: effectiveMode,
				reviewReason: null,
				warningMessage: warningMessage ?? null,
				lastOutputAt: now(),
			});
			this.emitSummary(summary);
			return cloneSummary(summary);
		} catch (error) {
			this.emitTaskFailure(taskId, entry, "start", error);
			return cloneSummary(entry.summary);
		}
	}

	async clearTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const existingEntry = this.messageRepository.getTaskEntry(taskId);
		this.pendingTurnCancelTaskIds.delete(taskId);
		this.providerIdByTaskId.delete(taskId);
		await this.sessionRuntime.clearTaskSessions(taskId).catch(() => undefined);
		this.messageRepository.clearHydratedTaskMessages(taskId);
		if (!existingEntry) {
			return null;
		}

		const clearedEntry: ClineTaskSessionEntry = {
			summary: {
				...createDefaultSummary(taskId),
				mode: existingEntry.summary.mode,
				workspacePath: existingEntry.summary.workspacePath,
			},
			messages: [],
			activeAssistantMessageId: null,
			activeReasoningMessageId: null,
			toolMessageIdByToolCallId: new Map<string, string>(),
			toolInputByToolCallId: new Map<string, unknown>(),
		};
		this.messageRepository.setTaskEntry(taskId, clearedEntry);
		this.emitSummary(clearedEntry.summary);
		return cloneSummary(clearedEntry.summary);
	}

	async rebindPersistedTaskSession(taskId: string): Promise<RuntimeTaskSessionSummary | null> {
		const existingEntry = this.messageRepository.getTaskEntry(taskId);
		if (existingEntry && existingEntry.summary.state !== "failed") {
			return cloneSummary(existingEntry.summary);
		}
		const snapshot = await this.sessionRuntime.readPersistedTaskSession(taskId);
		if (!snapshot) {
			return existingEntry ? cloneSummary(existingEntry.summary) : null;
		}
		const startedAt = Date.parse(snapshot.record.startedAt);
		const updatedAt = Date.parse(snapshot.record.updatedAt || snapshot.record.startedAt);
		const persistedCwd = typeof snapshot.record.cwd === "string" ? snapshot.record.cwd.trim() : "";
		const persistedWorkspaceRoot =
			typeof snapshot.record.workspaceRoot === "string" ? snapshot.record.workspaceRoot.trim() : "";
		const reboundState = existingEntry?.summary.state === "failed" ? "failed" : "awaiting_review";
		const reboundReviewReason = existingEntry?.summary.state === "failed" ? "error" : "attention";
		const entry = createTaskEntryFromPersistedSession(taskId, snapshot.messages, {
			agentId: "cline",
			state: reboundState,
			mode: existingEntry?.summary.mode ?? null,
			reviewReason: reboundReviewReason,
			workspacePath: persistedCwd || persistedWorkspaceRoot || null,
			startedAt: Number.isFinite(startedAt) ? startedAt : null,
			lastOutputAt: Number.isFinite(updatedAt) ? updatedAt : null,
			warningMessage: existingEntry?.summary.warningMessage ?? null,
			latestHookActivity: existingEntry?.summary.latestHookActivity ?? null,
			latestTurnCheckpoint: existingEntry?.summary.latestTurnCheckpoint ?? null,
			previousTurnCheckpoint: existingEntry?.summary.previousTurnCheckpoint ?? null,
		});
		this.messageRepository.setTaskEntry(taskId, entry);
		return cloneSummary(entry.summary);
	}

	getSummary(taskId: string): RuntimeTaskSessionSummary | null {
		return this.messageRepository.getSummary(taskId);
	}

	listSummaries(): RuntimeTaskSessionSummary[] {
		return this.messageRepository.listSummaries();
	}

	listMessages(taskId: string): ClineTaskMessage[] {
		return this.messageRepository.listMessages(taskId);
	}

	async listSlashCommands(workspacePath: string): Promise<ClineSdkSlashCommand[]> {
		const runtimeSetup = await this.ensureRuntimeSetup(workspacePath);
		await Promise.all([
			runtimeSetup.userInstructionService.refreshType("skill"),
			runtimeSetup.userInstructionService.refreshType("workflow"),
		]);
		return listClineSdkWorkflowSlashCommands(runtimeSetup.userInstructionService);
	}

	async loadTaskSessionMessages(taskId: string): Promise<ClineTaskMessage[]> {
		return await this.messageRepository.hydrateTaskMessages(taskId, async () => {
			return await this.sessionRuntime.readPersistedTaskSession(taskId);
		});
	}

	applyTurnCheckpoint(taskId: string, checkpoint: RuntimeTaskTurnCheckpoint): RuntimeTaskSessionSummary | null {
		const summary = this.messageRepository.applyTurnCheckpoint(taskId, checkpoint);
		if (!summary) {
			return null;
		}
		this.emitSummary(summary);
		return summary;
	}

	async dispose(): Promise<void> {
		await this.sessionRuntime.dispose();
		this.pendingTurnCancelTaskIds.clear();
		for (const leasePromise of this.runtimeSetupLeaseByWorkspacePath.values()) {
			try {
				const lease = await leasePromise;
				await lease.release();
			} catch {
				// Ignore runtime setup disposal failures.
			}
		}
		this.runtimeSetupLeaseByWorkspacePath.clear();
		this.messageRepository.dispose();
	}

	private emitSummary(summary: RuntimeTaskSessionSummary): void {
		this.messageRepository.emitSummary(summary);
	}

	private emitMessage(taskId: string, message: ClineTaskMessage): void {
		this.messageRepository.emitMessage(taskId, message);
	}

	private shouldCaptureReviewCheckpoint(
		previousSummary: RuntimeTaskSessionSummary,
		nextSummary: RuntimeTaskSessionSummary | null,
	): nextSummary is RuntimeTaskSessionSummary {
		if (!nextSummary) {
			return false;
		}
		if (isHomeAgentSessionId(nextSummary.taskId) || !nextSummary.workspacePath) {
			return false;
		}
		return previousSummary.state !== "awaiting_review" && nextSummary.state === "awaiting_review";
	}

	private captureReviewCheckpoint(taskId: string, summary: RuntimeTaskSessionSummary): void {
		const nextTurn = (summary.latestTurnCheckpoint?.turn ?? 0) + 1;
		const staleRef = summary.previousTurnCheckpoint?.ref ?? null;
		void captureTaskTurnCheckpoint({
			cwd: summary.workspacePath ?? ".",
			taskId,
			turn: nextTurn,
		})
			.then((checkpoint) => {
				this.applyTurnCheckpoint(taskId, checkpoint);
				if (!staleRef) {
					return;
				}
				void deleteTaskTurnCheckpointRef({
					cwd: summary.workspacePath ?? ".",
					ref: staleRef,
				}).catch(() => {
					// Best effort cleanup only.
				});
			})
			.catch(() => {
				// Best effort checkpointing only.
			});
	}

	// Rebuild what the runtime cannot persist for a restart that outlived the
	// in-memory start request: the system prompt (workspace rules + home-agent
	// append), the interactive runtime hooks, and current provider credentials.
	private async resolveRestartLaunchConfig(
		input: ClineRestartLaunchContextRequest,
	): Promise<ClineRestartLaunchContext | null> {
		const cwd = input.cwd.trim();
		if (!cwd) {
			return null;
		}
		const launchConfig = await this.providerConfigResolver.resolveLaunchConfig({
			providerIdOverride: input.providerId || undefined,
			modelIdOverride: input.modelId || undefined,
		});
		const providerId = launchConfig.providerId.trim() || input.providerId || SDK_DEFAULT_PROVIDER_ID;
		const runtimeSetup = await this.ensureRuntimeSetup(cwd);
		let systemPrompt = await resolveClineSdkSystemPrompt({
			cwd,
			providerId,
			rules: runtimeSetup.loadRules(),
		});
		const appendedSystemPrompt = resolveHomeAgentAppendSystemPrompt(input.taskId);
		if (appendedSystemPrompt) {
			systemPrompt = `${systemPrompt}\n\n${appendedSystemPrompt}`;
		}
		return {
			cwd,
			providerId,
			modelId: launchConfig.modelId,
			apiKey: launchConfig.apiKey,
			baseUrl: launchConfig.baseUrl,
			reasoningEffort: launchConfig.reasoningEffort,
			systemPrompt,
			userInstructionService: runtimeSetup.userInstructionService,
			requestToolApproval: runtimeSetup.requestToolApproval,
		};
	}

	private async ensureRuntimeSetup(workspacePath: string): Promise<ClineRuntimeSetup> {
		const normalizedWorkspacePath = workspacePath.trim();
		let leasePromise = this.runtimeSetupLeaseByWorkspacePath.get(normalizedWorkspacePath);
		if (!leasePromise) {
			leasePromise = this.watcherRegistry.acquire(normalizedWorkspacePath);
			this.runtimeSetupLeaseByWorkspacePath.set(normalizedWorkspacePath, leasePromise);
		}
		const lease = await leasePromise;
		return lease.setup;
	}

	private handleTaskEvent(taskId: string, event: unknown): void {
		const entry = this.messageRepository.getTaskEntry(taskId);
		if (!entry) {
			return;
		}
		const previousSummary = cloneSummary(entry.summary);
		let latestSummary: RuntimeTaskSessionSummary | null = null;
		applyClineSessionEvent({
			event,
			taskId,
			entry,
			pendingTurnCancelTaskIds: this.pendingTurnCancelTaskIds,
			isClineProvider: this.isClineProviderForTask(taskId),
			emitSummary: (summary: RuntimeTaskSessionSummary) => {
				latestSummary = summary;
				this.emitSummary(summary);
			},
			emitMessage: (taskIdFromEvent: string, message: ClineTaskMessage) => {
				this.emitMessage(taskIdFromEvent, message);
			},
		});
		const shouldAbortForCreditLimit =
			entry.summary.latestHookActivity?.notificationType === "credit_limit" &&
			previousSummary?.latestHookActivity?.notificationType !== "credit_limit";
		if (this.shouldCaptureReviewCheckpoint(previousSummary, latestSummary)) {
			this.captureReviewCheckpoint(taskId, latestSummary);
		}
		if (shouldAbortForCreditLimit) {
			void this.sessionRuntime.abortTaskSession(taskId).catch(() => undefined);
		}
	}
}

export function createInMemoryClineTaskSessionService(
	options: CreateInMemoryClineTaskSessionServiceOptions = {},
): ClineTaskSessionService {
	return new InMemoryClineTaskSessionService(options);
}
