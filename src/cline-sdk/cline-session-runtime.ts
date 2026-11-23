// Owns the live SDK session host plus taskId to sessionId bindings.
// This is the runtime-facing layer for starting, looking up, resuming, and
// stopping native Cline sessions without exposing SDK details upstream.
import type { RuntimeClineReasoningEffort, RuntimeTaskImage, RuntimeTaskSessionMode } from "../core/api-contract";
import { createClineConversationRepairHooks, repairClinePersistedToolResults } from "./cline-conversation-repair";
import { extractClineSessionId } from "./cline-event-adapter";
import {
	type ClineMcpRuntimeService,
	type ClineMcpToolBundle,
	createClineMcpRuntimeService,
} from "./cline-mcp-runtime-service";
import { createKanbanClineLogger } from "./cline-runtime-logger";
import { ClineSessionConfigUnavailableError } from "./cline-session-errors";
import {
	type ClineRestartLaunchContext,
	type ClineRestartLaunchContextRequest,
	createPersistedClineStartConfig,
	KANBAN_CLINE_START_CONFIG_METADATA_KEY,
	type PersistedClineStartConfig,
	readPersistedClineStartConfig,
	resolveClineRestartLaunchRequest,
} from "./cline-session-launch-config";
import { buildSessionIdPrefix, createSessionId } from "./cline-session-state";
import { CLINE_MODEL_CATALOG_DEFAULTS } from "./sdk-provider-boundary";
import {
	type ClineSdkExtraTool,
	type ClineSdkPersistedMessage,
	type ClineSdkSessionHost,
	type ClineSdkSessionRecord,
	type ClineSdkStartSessionInput,
	type ClineSdkToolApprovalRequest,
	type ClineSdkToolApprovalResult,
	type ClineSdkUserInstructionService,
	createClineSdkRunCommandsTool,
	createClineSdkSessionHost,
} from "./sdk-runtime-boundary";

export { CLINE_MODEL_CATALOG_DEFAULTS } from "./sdk-provider-boundary";

const DEFAULT_CLINE_MAX_CONSECUTIVE_MISTAKES = 6;

interface ClineSessionHostBoundary {
	start(input: ClineSdkStartSessionInput): Promise<{ sessionId: string; result?: unknown }>;
	send(input: Parameters<ClineSdkSessionHost["send"]>[0]): Promise<unknown>;
	stop(sessionId: string): Promise<void>;
	abort(sessionId: string): Promise<void>;
	delete(sessionId: string): Promise<boolean>;
	dispose(reason?: string): Promise<void>;
	get(sessionId: string): Promise<ClineSdkSessionRecord | undefined>;
	list(limit?: number): Promise<ClineSdkSessionRecord[]>;
	update?(
		sessionId: string,
		updates: {
			prompt?: string | null;
			metadata?: Record<string, unknown> | null;
			title?: string | null;
		},
	): Promise<{ updated: boolean }>;
	readMessages(sessionId: string): Promise<ClineSdkPersistedMessage[]>;
	subscribe(listener: (event: unknown) => void): () => void;
}

function toSdkUserImages(images?: RuntimeTaskImage[]): string[] | undefined {
	if (!images || images.length === 0) {
		return undefined;
	}
	const userImages = images
		.map((image) => {
			const mimeType = image.mimeType.trim();
			const data = image.data.trim();
			if (!mimeType || !data) {
				return null;
			}
			return `data:${mimeType};base64,${data}`;
		})
		.filter((image): image is string => image !== null);
	return userImages.length > 0 ? userImages : undefined;
}

export interface StartClineSessionRuntimeRequest {
	taskId: string;
	cwd: string;
	prompt: string;
	/** Normalized Kanban task title; persisted to SDK session metadata when supported. */
	taskTitle?: string;
	initialMessages?: ClineSdkPersistedMessage[];
	images?: RuntimeTaskImage[];
	providerId: string;
	modelId: string;
	mode?: RuntimeTaskSessionMode;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	systemPrompt: string;
	/** Per-command timeout for the native agent's `run_commands` tool. */
	agentCommandTimeoutSec?: number;
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
}

export interface StartClineSessionRuntimeResult {
	sessionId: string;
	result: unknown;
	warnings?: string[];
}

export interface ClinePersistedTaskSessionSnapshot {
	record: ClineSdkSessionRecord;
	messages: ClineSdkPersistedMessage[];
}

export interface ResumeClineTaskTurnRuntimeRequest {
	taskId: string;
	/** Explicit continuation instruction. Never the original user message. */
	prompt: string;
	mode?: RuntimeTaskSessionMode;
	images?: RuntimeTaskImage[];
	delivery?: "queue" | "steer";
}

export interface ResumeClineTaskTurnRuntimeResult {
	sessionId: string;
	result: unknown;
}

export interface ClineSessionRuntime {
	startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult>;
	restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
	}): Promise<StartClineSessionRuntimeResult>;
	sendTaskSessionInput(
		taskId: string,
		prompt: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		delivery?: "queue" | "steer",
	): Promise<unknown>;
	resumeTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null>;
	resumeTaskTurn(request: ResumeClineTaskTurnRuntimeRequest): Promise<ResumeClineTaskTurnRuntimeResult>;
	stopTaskSession(taskId: string): Promise<void>;
	abortTaskSession(taskId: string): Promise<void>;
	clearTaskSessions(taskId: string): Promise<void>;
	getTaskSessionId(taskId: string): string | null;
	getTaskProviderId(taskId: string): string | null;
	/**
	 * Whether a dead task session can be rebuilt. True while the in-memory start
	 * request is available, and after a runtime restart when the task still has a
	 * persisted SDK session to replay.
	 */
	canRestartTaskSession(taskId: string): Promise<boolean>;
	readPersistedTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null>;
	dispose(): Promise<void>;
}

/**
 * Rebuilds the launch context the runtime cannot persist (system prompt,
 * interactive hooks, and the current provider credentials) when a restart
 * outlives the in-memory start request.
 */
export type ClineRestartLaunchContextResolver = (
	input: ClineRestartLaunchContextRequest,
) => Promise<ClineRestartLaunchContext | null>;

export interface CreateInMemoryClineSessionRuntimeOptions {
	onTaskEvent?: (taskId: string, event: unknown) => void;
	createSessionHost?: () => Promise<ClineSessionHostBoundary>;
	createMcpRuntimeService?: () => ClineMcpRuntimeService;
	resolveRestartLaunchConfig?: ClineRestartLaunchContextResolver;
}

// Best-effort: write the Kanban task title plus the secret-free start config to
// the SDK session metadata. The SDK owns the session store, so this keeps
// restart state next to the session it describes instead of inventing a second
// Kanban-side store.
async function persistKanbanSessionMetadata(
	sessionHost: ClineSessionHostBoundary,
	sessionId: string,
	input: {
		taskTitle?: string;
		startConfig: PersistedClineStartConfig;
	},
): Promise<void> {
	const title = input.taskTitle?.trim();
	if (!sessionHost.update) {
		return;
	}
	try {
		const existingRecord = await sessionHost.get(sessionId);
		const existingMetadata = existingRecord?.metadata ?? {};
		await sessionHost.update(sessionId, {
			...(title ? { title } : {}),
			metadata: {
				...existingMetadata,
				[KANBAN_CLINE_START_CONFIG_METADATA_KEY]: input.startConfig,
			},
		});
	} catch {
		// Best-effort only — Kanban board title remains canonical, and a restart
		// can still fall back to the session record's provider/model/cwd.
	}
}

// Own the SDK session host plus the taskId <-> sessionId bindings so higher layers can stay task-oriented.
export class InMemoryClineSessionRuntime implements ClineSessionRuntime {
	private readonly onTaskEvent: ((taskId: string, event: unknown) => void) | null;
	private readonly createSessionHost: () => Promise<ClineSessionHostBoundary>;
	private readonly clineMcpRuntimeService: ClineMcpRuntimeService;
	private readonly sessionIdByTaskId = new Map<string, string>();
	private readonly taskIdBySessionId = new Map<string, string>();
	private readonly lastStartRequestByTaskId = new Map<
		string,
		Omit<StartClineSessionRuntimeRequest, "prompt" | "images" | "initialMessages">
	>();
	private readonly mcpToolBundleByTaskId = new Map<string, ClineMcpToolBundle>();
	private readonly resolveRestartLaunchConfig: ClineRestartLaunchContextResolver | null;
	private sessionHostPromise: Promise<ClineSessionHostBoundary> | null = null;

	constructor(options: CreateInMemoryClineSessionRuntimeOptions = {}) {
		this.onTaskEvent = options.onTaskEvent ?? null;
		this.createSessionHost = options.createSessionHost ?? createClineSdkSessionHost;
		this.resolveRestartLaunchConfig = options.resolveRestartLaunchConfig ?? null;
		const createMcpRuntimeService = options.createMcpRuntimeService ?? createClineMcpRuntimeService;
		this.clineMcpRuntimeService = createMcpRuntimeService();
	}

	async startTaskSession(request: StartClineSessionRuntimeRequest): Promise<StartClineSessionRuntimeResult> {
		const requestedSessionId = createSessionId(request.taskId);
		const resolvedMode: RuntimeTaskSessionMode = request.mode ?? "act";
		this.lastStartRequestByTaskId.set(request.taskId, {
			taskId: request.taskId,
			cwd: request.cwd,
			providerId: request.providerId,
			modelId: request.modelId,
			mode: resolvedMode,
			apiKey: request.apiKey,
			baseUrl: request.baseUrl,
			reasoningEffort: request.reasoningEffort,
			systemPrompt: request.systemPrompt,
			agentCommandTimeoutSec: request.agentCommandTimeoutSec,
			taskTitle: request.taskTitle,
			userInstructionService: request.userInstructionService,
			requestToolApproval: request.requestToolApproval,
		});
		this.bindTaskSession(request.taskId, requestedSessionId);

		let mcpToolBundle: ClineMcpToolBundle | null = null;
		let startWarnings: string[] = [];
		try {
			mcpToolBundle = await this.clineMcpRuntimeService.createToolBundle();
			startWarnings = mcpToolBundle.warnings;
		} catch (error) {
			mcpToolBundle = null;
			const message = error instanceof Error ? error.message.trim() : String(error);
			if (message.length > 0) {
				startWarnings = [`Failed to load MCP tools: ${message}`];
			}
		}
		this.replaceTaskMcpToolBundle(request.taskId, mcpToolBundle);
		const hasMcpExtraTools = Boolean(mcpToolBundle && mcpToolBundle.tools.length > 0);
		const extraTools: ClineSdkExtraTool[] = [...(mcpToolBundle?.tools ?? [])];
		const commandTimeoutMs =
			typeof request.agentCommandTimeoutSec === "number" ? Math.round(request.agentCommandTimeoutSec * 1000) : null;
		if (commandTimeoutMs !== null) {
			const runCommandsTool = createClineSdkRunCommandsTool({
				cwd: request.cwd,
				timeoutMs: commandTimeoutMs,
			});
			// Registered last so it shadows the SDK's built-in `run_commands`, which
			// hard-codes a 30s timeout. See createClineSdkRunCommandsTool.
			if (runCommandsTool) {
				extraTools.push(runCommandsTool);
			}
		}
		const hasExtraTools = extraTools.length > 0;

		const sessionHost = await this.ensureSessionHost();
		const userImages = toSdkUserImages(request.images);
		const shouldSendInitialTurn = request.prompt.trim().length > 0 || Boolean(userImages?.length);
		// Interrupted tool executions can leave dangling tool calls in persisted
		// history (assistant tool_use without a tool_result). Providers reject that
		// history with "Tool result is missing for tool call ...", so repair it
		// before replaying it into a fresh session.
		const initialMessages = request.initialMessages
			? repairClinePersistedToolResults(request.initialMessages)
			: undefined;
		let startResult: Awaited<ReturnType<ClineSessionHostBoundary["start"]>>;
		try {
			// Hub-backed SDK hosts create the interactive session in start; the first turn runs through send.
			startResult = await sessionHost.start({
				config: {
					sessionId: requestedSessionId,
					providerId: request.providerId,
					modelId: request.modelId,
					apiKey: request.apiKey?.trim() || undefined,
					baseUrl: request.baseUrl?.trim() || undefined,
					reasoningEffort:
						request.reasoningEffort === null
							? ("none" as ClineSdkStartSessionInput["config"]["reasoningEffort"])
							: (request.reasoningEffort ?? undefined),
					cwd: request.cwd,
					mode: resolvedMode,
					enableTools: true,
					enableSpawnAgent: false,
					enableAgentTeams: false,
					...(hasMcpExtraTools ? { disableMcpSettingsTools: true } : {}),
					execution: {
						maxConsecutiveMistakes: DEFAULT_CLINE_MAX_CONSECUTIVE_MISTAKES,
					},
					systemPrompt: request.systemPrompt,
				},
				initialMessages,
				interactive: true,
				localRuntime: {
					// Repairs dangling tool calls on every model request, including live
					// sessions whose in-memory history was interrupted mid-tool.
					hooks: createClineConversationRepairHooks(),
					modelCatalogDefaults: CLINE_MODEL_CATALOG_DEFAULTS,
					...(request.userInstructionService ? { userInstructionService: request.userInstructionService } : {}),
					logger: createKanbanClineLogger({
						runtime: "kanban",
						taskId: request.taskId,
						requestedSessionId,
						providerId: request.providerId,
						modelId: request.modelId,
					}),
					...(hasExtraTools ? { extraTools } : {}),
				},
				...(request.requestToolApproval
					? { capabilities: { requestToolApproval: request.requestToolApproval } }
					: {}),
			});
		} catch (error) {
			this.clearTaskSessionBinding(request.taskId, requestedSessionId);
			await this.releaseTaskMcpToolBundle(request.taskId);
			throw error;
		}

		this.bindTaskSession(request.taskId, startResult.sessionId);
		if (startResult.sessionId !== requestedSessionId) {
			this.taskIdBySessionId.delete(requestedSessionId);
		}

		let result: unknown = startResult.result ?? null;
		await persistKanbanSessionMetadata(sessionHost, startResult.sessionId, {
			taskTitle: request.taskTitle,
			startConfig: createPersistedClineStartConfig({
				taskId: request.taskId,
				providerId: request.providerId,
				modelId: request.modelId,
				mode: resolvedMode,
				baseUrl: request.baseUrl,
				reasoningEffort: request.reasoningEffort,
				agentCommandTimeoutSec: request.agentCommandTimeoutSec,
			}),
		});
		if (shouldSendInitialTurn) {
			try {
				result = await sessionHost.send({
					sessionId: startResult.sessionId,
					prompt: request.prompt,
					userImages,
				});
			} catch (error) {
				this.clearTaskSessionBinding(request.taskId, startResult.sessionId);
				await this.releaseTaskMcpToolBundle(request.taskId);
				throw error;
			}
		}

		return {
			sessionId: startResult.sessionId,
			result,
			...(startWarnings.length > 0 ? { warnings: startWarnings } : {}),
		};
	}

	async restartTaskSession(input: {
		taskId: string;
		prompt: string;
		initialMessages?: ClineSdkPersistedMessage[];
		images?: RuntimeTaskImage[];
		mode?: RuntimeTaskSessionMode;
	}): Promise<StartClineSessionRuntimeResult> {
		const lastStartRequest = this.lastStartRequestByTaskId.get(input.taskId);
		if (lastStartRequest) {
			return await this.startTaskSession({
				...lastStartRequest,
				prompt: input.prompt,
				initialMessages: input.initialMessages,
				images: input.images,
				mode: input.mode ?? lastStartRequest.mode,
			});
		}

		// The runtime process restarted (rebuild, crash recovery) and lost the
		// in-memory start request. Rebuild it from the persisted SDK session and
		// the launch context the owning service can still resolve.
		const snapshot = await this.readPersistedTaskSession(input.taskId).catch(() => null);
		if (!snapshot) {
			throw new ClineSessionConfigUnavailableError(input.taskId);
		}
		const context = await this.resolvePersistedClineLaunchContext(input.taskId, snapshot.record);
		const launchRequest = resolveClineRestartLaunchRequest({
			record: snapshot.record,
			context,
			mode: input.mode,
		});
		if (!launchRequest) {
			throw new ClineSessionConfigUnavailableError(input.taskId);
		}

		return await this.startTaskSession({
			...launchRequest,
			taskId: input.taskId,
			prompt: input.prompt,
			initialMessages: input.initialMessages ?? snapshot.messages,
			images: input.images,
		});
	}

	private async resolvePersistedClineLaunchContext(
		taskId: string,
		record: ClineSdkSessionRecord,
	): Promise<ClineRestartLaunchContext | null> {
		const persistedStartConfig = readPersistedClineStartConfig(record);
		const cwd = record.cwd?.trim() || record.workspaceRoot?.trim() || "";
		if (!this.resolveRestartLaunchConfig) {
			return null;
		}
		try {
			return await this.resolveRestartLaunchConfig({
				taskId,
				cwd,
				providerId: persistedStartConfig?.providerId ?? record.provider?.trim() ?? "",
				modelId: persistedStartConfig?.modelId ?? record.model?.trim() ?? "",
			});
		} catch (error) {
			// Surface the resolver's actionable detail (for example a missing
			// provider configuration) instead of a bare "cannot restart" error.
			throw new ClineSessionConfigUnavailableError(taskId, error instanceof Error ? error.message : String(error));
		}
	}

	async sendTaskSessionInput(
		taskId: string,
		prompt: string,
		mode?: RuntimeTaskSessionMode,
		images?: RuntimeTaskImage[],
		delivery?: "queue" | "steer",
	): Promise<unknown> {
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			throw new Error(`No active Cline session for task ${taskId}.`);
		}
		const sessionHost = await this.ensureSessionHost();
		if (mode) {
			this.updateActiveSessionMode(sessionHost, sessionId, mode);
			this.updateLastStartRequestMode(taskId, mode);
		}
		return await sessionHost.send({
			sessionId,
			prompt,
			userImages: toSdkUserImages(images),
			...(delivery ? { delivery } : {}),
		});
	}

	async resumeTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}
		this.bindTaskSession(taskId, record.sessionId);
		const messages = await sessionHost.readMessages(record.sessionId);
		return {
			record,
			messages,
		};
	}

	// Single-shot resume of a dead turn: rebind the task to the persisted SDK
	// session, then drive exactly one continuation turn through send().
	async resumeTaskTurn(request: ResumeClineTaskTurnRuntimeRequest): Promise<ResumeClineTaskTurnRuntimeResult> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(request.taskId, sessionHost);
		const sessionId = record?.sessionId ?? this.sessionIdByTaskId.get(request.taskId) ?? null;
		if (!sessionId) {
			throw new Error(`No resumable Cline session for task ${request.taskId}.`);
		}
		this.bindTaskSession(request.taskId, sessionId);
		if (request.mode) {
			this.updateActiveSessionMode(sessionHost, sessionId, request.mode);
			this.updateLastStartRequestMode(request.taskId, request.mode);
		}
		const result = await sessionHost.send({
			sessionId,
			prompt: request.prompt,
			userImages: toSdkUserImages(request.images),
			...(request.delivery ? { delivery: request.delivery } : {}),
		});
		return { sessionId, result };
	}

	async stopTaskSession(taskId: string): Promise<void> {
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			await this.releaseTaskMcpToolBundle(taskId);
			return;
		}
		const sessionHost = await this.ensureSessionHost();
		try {
			await sessionHost.stop(sessionId);
			this.clearTaskSessionBinding(taskId, sessionId);
		} catch (error) {
			const persistedRecord = await sessionHost.get(sessionId).catch(() => undefined);
			if (!persistedRecord) {
				this.clearTaskSessionBinding(taskId, sessionId);
			}
			throw error;
		} finally {
			await this.releaseTaskMcpToolBundle(taskId);
		}
	}

	async abortTaskSession(taskId: string): Promise<void> {
		const sessionId = this.sessionIdByTaskId.get(taskId);
		if (!sessionId) {
			await this.releaseTaskMcpToolBundle(taskId);
			return;
		}
		const sessionHost = await this.ensureSessionHost();
		try {
			await sessionHost.abort(sessionId);
			this.clearTaskSessionBinding(taskId, sessionId);
		} catch (error) {
			const persistedRecord = await sessionHost.get(sessionId).catch(() => undefined);
			if (!persistedRecord) {
				this.clearTaskSessionBinding(taskId, sessionId);
			}
			throw error;
		} finally {
			await this.releaseTaskMcpToolBundle(taskId);
		}
	}

	async clearTaskSessions(taskId: string): Promise<void> {
		const sessionHost = await this.ensureSessionHost();
		const sessionIdPrefix = buildSessionIdPrefix(taskId);
		const records = await sessionHost.list();
		const matchingSessionIds = new Set(
			records.filter((record) => record.sessionId.startsWith(sessionIdPrefix)).map((record) => record.sessionId),
		);
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (activeSessionId) {
			matchingSessionIds.add(activeSessionId);
			await sessionHost.abort(activeSessionId).catch(() => undefined);
		}

		for (const sessionId of matchingSessionIds) {
			await sessionHost.delete(sessionId).catch(() => false);
			this.taskIdBySessionId.delete(sessionId);
		}
		this.clearTaskSessionBinding(taskId);
		await this.releaseTaskMcpToolBundle(taskId);
	}

	getTaskSessionId(taskId: string): string | null {
		return this.sessionIdByTaskId.get(taskId) ?? null;
	}

	getTaskProviderId(taskId: string): string | null {
		return this.lastStartRequestByTaskId.get(taskId)?.providerId ?? null;
	}

	async canRestartTaskSession(taskId: string): Promise<boolean> {
		if (this.lastStartRequestByTaskId.has(taskId)) {
			return true;
		}
		// After a runtime restart the in-memory start request is gone, but the SDK
		// still owns the persisted session history. That history is what makes a
		// rebuild possible, so it - not map membership - decides resumability.
		const snapshot = await this.readPersistedTaskSession(taskId).catch(() => null);
		return snapshot !== null;
	}

	async readPersistedTaskSession(taskId: string): Promise<ClinePersistedTaskSessionSnapshot | null> {
		const sessionHost = await this.ensureSessionHost();
		const record = await this.findPersistedTaskSessionRecord(taskId, sessionHost);
		if (!record) {
			return null;
		}
		const messages = await sessionHost.readMessages(record.sessionId);
		return {
			record,
			messages,
		};
	}

	async dispose(): Promise<void> {
		const hostPromise = this.sessionHostPromise;
		this.sessionHostPromise = null;
		if (hostPromise) {
			try {
				const host = await hostPromise;
				await host.dispose("kanban-runtime-dispose");
			} catch {
				// Ignore host disposal errors.
			}
		}
		this.sessionIdByTaskId.clear();
		this.taskIdBySessionId.clear();
		this.lastStartRequestByTaskId.clear();

		const mcpBundles = [...this.mcpToolBundleByTaskId.values()];
		this.mcpToolBundleByTaskId.clear();
		await Promise.all(
			mcpBundles.map(async (bundle) => {
				await bundle.dispose().catch(() => undefined);
			}),
		);
	}

	private replaceTaskMcpToolBundle(taskId: string, bundle: ClineMcpToolBundle | null): void {
		const current = this.mcpToolBundleByTaskId.get(taskId);
		if (current) {
			void current.dispose().catch(() => undefined);
			this.mcpToolBundleByTaskId.delete(taskId);
		}
		if (bundle) {
			this.mcpToolBundleByTaskId.set(taskId, bundle);
		}
	}

	private async releaseTaskMcpToolBundle(taskId: string): Promise<void> {
		const current = this.mcpToolBundleByTaskId.get(taskId);
		if (!current) {
			return;
		}
		this.mcpToolBundleByTaskId.delete(taskId);
		await current.dispose().catch(() => undefined);
	}

	private bindTaskSession(taskId: string, sessionId: string): void {
		const previousSessionId = this.sessionIdByTaskId.get(taskId);
		if (previousSessionId) {
			this.taskIdBySessionId.delete(previousSessionId);
		}
		this.sessionIdByTaskId.set(taskId, sessionId);
		this.taskIdBySessionId.set(sessionId, taskId);
	}

	private clearTaskSessionBinding(taskId: string, sessionId?: string): void {
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (!activeSessionId) {
			return;
		}
		if (sessionId && activeSessionId !== sessionId) {
			return;
		}
		this.sessionIdByTaskId.delete(taskId);
		this.taskIdBySessionId.delete(activeSessionId);
	}

	private async findPersistedTaskSessionRecord(
		taskId: string,
		sessionHost: ClineSessionHostBoundary,
	): Promise<ClineSdkSessionRecord | null> {
		const activeSessionId = this.sessionIdByTaskId.get(taskId);
		if (activeSessionId) {
			const activeRecord = (await sessionHost.get(activeSessionId)) ?? null;
			if (activeRecord) {
				return activeRecord;
			}
		}

		const sessionIdPrefix = buildSessionIdPrefix(taskId);
		const records: ClineSdkSessionRecord[] = await sessionHost.list();
		const matchingRecord = records
			.filter((record: ClineSdkSessionRecord) => record.sessionId.startsWith(sessionIdPrefix))
			.sort((left: ClineSdkSessionRecord, right: ClineSdkSessionRecord) => {
				const leftTimestamp = Date.parse(left.updatedAt || left.startedAt);
				const rightTimestamp = Date.parse(right.updatedAt || right.startedAt);
				return rightTimestamp - leftTimestamp;
			})[0];
		return matchingRecord ?? null;
	}

	private async ensureSessionHost(): Promise<ClineSessionHostBoundary> {
		if (!this.sessionHostPromise) {
			this.sessionHostPromise = this.createSessionHost().then((sessionHost: ClineSessionHostBoundary) => {
				sessionHost.subscribe((event: unknown) => {
					this.handleSessionEvent(event);
				});
				return sessionHost;
			});
		}
		return await this.sessionHostPromise;
	}

	private updateActiveSessionMode(
		sessionHost: ClineSessionHostBoundary,
		sessionId: string,
		mode: RuntimeTaskSessionMode,
	): void {
		const hostWithSessions = sessionHost as unknown as {
			sessions?: Map<string, { config?: { mode?: RuntimeTaskSessionMode } }>;
		};
		const activeSession = hostWithSessions.sessions?.get(sessionId);
		if (activeSession?.config) {
			activeSession.config.mode = mode;
		}
	}

	private updateLastStartRequestMode(taskId: string, mode: RuntimeTaskSessionMode): void {
		const lastStartRequest = this.lastStartRequestByTaskId.get(taskId);
		if (!lastStartRequest) {
			return;
		}
		this.lastStartRequestByTaskId.set(taskId, {
			...lastStartRequest,
			mode,
		});
	}

	private handleSessionEvent(event: unknown): void {
		const sessionId = extractClineSessionId(event);
		if (!sessionId) {
			return;
		}
		const taskId = this.taskIdBySessionId.get(sessionId);
		if (!taskId) {
			return;
		}
		const eventRecord = event && typeof event === "object" ? (event as { type?: unknown }) : null;
		const ended = eventRecord?.type === "ended";
		if (this.onTaskEvent) {
			this.onTaskEvent(taskId, event);
		}
		if (ended) {
			this.clearTaskSessionBinding(taskId, sessionId);
			void this.releaseTaskMcpToolBundle(taskId);
		}
	}
}

export function createInMemoryClineSessionRuntime(
	options: CreateInMemoryClineSessionRuntimeOptions = {},
): ClineSessionRuntime {
	return new InMemoryClineSessionRuntime(options);
}
