// Persisted launch state for native Cline task sessions.
//
// The SDK keeps one record per session under `~/.cline/data/sessions` with the
// provider, model, cwd, and a free-form metadata bag. Kanban stores the small
// amount of extra launch state it owns (mode, base URL, reasoning effort, and
// command timeout) in that same record's metadata so a task can be restarted
// after the runtime process exits. Secrets are never written here: the API key
// is resolved from provider settings on every restart.
import type { RuntimeClineReasoningEffort, RuntimeTaskSessionMode } from "../core/api-contract";
import type {
	ClineSdkSessionRecord,
	ClineSdkToolApprovalRequest,
	ClineSdkToolApprovalResult,
	ClineSdkUserInstructionService,
} from "./sdk-runtime-boundary";

export const KANBAN_CLINE_START_CONFIG_METADATA_KEY = "kanbanStartConfig";

const TASK_SESSION_MODES: readonly RuntimeTaskSessionMode[] = ["act", "plan"];
const REASONING_EFFORTS: readonly RuntimeClineReasoningEffort[] = ["low", "medium", "high", "xhigh"];

export interface PersistedClineStartConfig {
	taskId: string;
	providerId: string;
	modelId: string;
	mode: RuntimeTaskSessionMode;
	baseUrl: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	agentCommandTimeoutSec?: number;
	updatedAt: string;
}

export interface CreatePersistedClineStartConfigInput {
	taskId: string;
	providerId: string;
	modelId: string;
	mode: RuntimeTaskSessionMode;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	agentCommandTimeoutSec?: number;
}

/** Build the secret-free start config persisted alongside the SDK session record. */
export function createPersistedClineStartConfig(
	input: CreatePersistedClineStartConfigInput,
): PersistedClineStartConfig {
	return {
		taskId: input.taskId,
		providerId: input.providerId,
		modelId: input.modelId,
		mode: input.mode,
		baseUrl: readNonEmptyString(input.baseUrl),
		...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
		...(typeof input.agentCommandTimeoutSec === "number" &&
		Number.isFinite(input.agentCommandTimeoutSec) &&
		input.agentCommandTimeoutSec > 0
			? { agentCommandTimeoutSec: input.agentCommandTimeoutSec }
			: {}),
		updatedAt: new Date().toISOString(),
	};
}

/** Read and validate the Kanban start config stored on a persisted SDK session. */
export function readPersistedClineStartConfig(
	record: Pick<ClineSdkSessionRecord, "metadata"> | null | undefined,
): PersistedClineStartConfig | null {
	const rawStartConfig = record?.metadata?.[KANBAN_CLINE_START_CONFIG_METADATA_KEY];
	if (!isRecord(rawStartConfig)) {
		return null;
	}
	const taskId = readNonEmptyString(rawStartConfig.taskId);
	const providerId = readNonEmptyString(rawStartConfig.providerId);
	const modelId = readNonEmptyString(rawStartConfig.modelId);
	const mode = readTaskSessionMode(rawStartConfig.mode);
	if (!taskId || !providerId || !modelId || !mode) {
		return null;
	}
	const reasoningEffort = readReasoningEffort(rawStartConfig.reasoningEffort);
	const agentCommandTimeoutSec =
		typeof rawStartConfig.agentCommandTimeoutSec === "number" &&
		Number.isFinite(rawStartConfig.agentCommandTimeoutSec) &&
		rawStartConfig.agentCommandTimeoutSec > 0
			? rawStartConfig.agentCommandTimeoutSec
			: undefined;
	return {
		taskId,
		providerId,
		modelId,
		mode,
		baseUrl: readNonEmptyString(rawStartConfig.baseUrl),
		...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
		...(agentCommandTimeoutSec !== undefined ? { agentCommandTimeoutSec } : {}),
		updatedAt: readNonEmptyString(rawStartConfig.updatedAt) ?? "",
	};
}

/** Read the human-readable title persisted on the SDK session record. */
export function readPersistedClineSessionTitle(
	record: Pick<ClineSdkSessionRecord, "metadata"> | null | undefined,
): string | null {
	return readNonEmptyString(record?.metadata?.title);
}

/**
 * Context the owning session service can rebuild for a restart that outlives
 * the in-memory start request: the system prompt, interactive runtime hooks,
 * and the current provider credentials.
 */
export interface ClineRestartLaunchContext {
	cwd?: string | null;
	providerId?: string | null;
	modelId?: string | null;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	mode?: RuntimeTaskSessionMode;
	systemPrompt?: string | null;
	taskTitle?: string | null;
	agentCommandTimeoutSec?: number;
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
}

export interface ClineRestartLaunchContextRequest {
	taskId: string;
	cwd: string;
	providerId: string;
	modelId: string;
}

export interface ClineRestartLaunchRequest {
	cwd: string;
	providerId: string;
	modelId: string;
	mode: RuntimeTaskSessionMode;
	systemPrompt: string;
	apiKey?: string | null;
	baseUrl?: string | null;
	reasoningEffort?: RuntimeClineReasoningEffort | null;
	taskTitle?: string;
	agentCommandTimeoutSec?: number;
	userInstructionService?: ClineSdkUserInstructionService;
	requestToolApproval?: (request: ClineSdkToolApprovalRequest) => Promise<ClineSdkToolApprovalResult>;
}

/**
 * Merge the persisted session record, the persisted Kanban start config, and the
 * freshly resolved launch context into one start request.
 *
 * The persisted start config is the durable snapshot of how the task was
 * launched. The resolved context wins for provider/model because the provider
 * resolver was seeded with the persisted ids and still reflects valid settings
 * plus a usable API key. Returns null when the record cannot support a restart,
 * which the caller reports as a `ClineSessionConfigUnavailableError`.
 */
export function resolveClineRestartLaunchRequest(input: {
	record: ClineSdkSessionRecord | null | undefined;
	context?: ClineRestartLaunchContext | null;
	mode?: RuntimeTaskSessionMode;
}): ClineRestartLaunchRequest | null {
	const record = input.record;
	if (!record) {
		return null;
	}
	const persisted = readPersistedClineStartConfig(record);
	const context = input.context ?? null;
	const cwd =
		readNonEmptyString(context?.cwd) ?? readNonEmptyString(record.cwd) ?? readNonEmptyString(record.workspaceRoot);
	const providerId =
		readNonEmptyString(context?.providerId) ?? persisted?.providerId ?? readNonEmptyString(record.provider);
	const modelId = readNonEmptyString(context?.modelId) ?? persisted?.modelId ?? readNonEmptyString(record.model);
	const systemPrompt = readNonEmptyString(context?.systemPrompt);
	if (!cwd || !providerId || !modelId || !systemPrompt) {
		return null;
	}
	const reasoningEffort = firstDefined(persisted?.reasoningEffort, context?.reasoningEffort);
	const agentCommandTimeoutSec = firstDefined(persisted?.agentCommandTimeoutSec, context?.agentCommandTimeoutSec);
	const taskTitle = readNonEmptyString(context?.taskTitle) ?? readPersistedClineSessionTitle(record);
	return {
		cwd,
		providerId,
		modelId,
		systemPrompt,
		mode: input.mode ?? persisted?.mode ?? context?.mode ?? "act",
		apiKey: context?.apiKey ?? null,
		baseUrl: persisted ? persisted.baseUrl : (context?.baseUrl ?? null),
		...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
		...(taskTitle ? { taskTitle } : {}),
		...(agentCommandTimeoutSec !== undefined ? { agentCommandTimeoutSec } : {}),
		...(context?.userInstructionService ? { userInstructionService: context.userInstructionService } : {}),
		...(context?.requestToolApproval ? { requestToolApproval: context.requestToolApproval } : {}),
	};
}

function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
	for (const value of values) {
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

function readNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function readTaskSessionMode(value: unknown): RuntimeTaskSessionMode | null {
	return typeof value === "string" && TASK_SESSION_MODES.includes(value as RuntimeTaskSessionMode)
		? (value as RuntimeTaskSessionMode)
		: null;
}

function readReasoningEffort(value: unknown): RuntimeClineReasoningEffort | null | undefined {
	if (value === null) {
		return null;
	}
	return typeof value === "string" && REASONING_EFFORTS.includes(value as RuntimeClineReasoningEffort)
		? (value as RuntimeClineReasoningEffort)
		: undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
