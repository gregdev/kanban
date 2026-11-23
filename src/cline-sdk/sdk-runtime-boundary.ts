// Centralize direct SDK runtime imports here.
// All native Cline session-host creation and persisted artifact reads should
// flow through this boundary so the rest of Kanban stays decoupled from the
// SDK package layout.

import {
	type AgentEvent,
	type BasicLogger,
	buildWorkspaceMetadata,
	ClineCore,
	type ClineCoreStartInput,
	type CoreSessionEvent,
	createDefaultExecutors,
	createDefaultTools,
	createUserInstructionConfigService,
	formatRulesForSystemPrompt,
	getClineDefaultSystemPrompt,
	isRuleEnabled,
	type MessageWithMetadata,
	type RuleConfig,
	resolveClineDataDir,
	type SessionHistoryRecord,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type UserInstructionConfigService,
} from "@clinebot/core";
import { CLINE_BUILTIN_SLASH_COMMANDS } from "./cline-slash-commands";
import { getCliTelemetryService } from "./cline-telemetry-service";

export { TelemetryLoggerSink, TelemetryService } from "@clinebot/core";
export type {
	AgentHooks,
	AgentMessage,
	AgentMessagePart,
	AgentToolCallPart,
	AgentToolResultPart,
	ContentBlock,
	MessageWithMetadata,
	ToolResultContent,
	ToolUseContent,
} from "@clinebot/shared";

export type ClineSdkSessionHost = ClineCore;
export type ClineSdkBasicLogger = BasicLogger;
export type ClineSdkAgentEvent = AgentEvent;

export type ClineSdkSessionEvent = CoreSessionEvent;

export type ClineSdkStartSessionInput = ClineCoreStartInput;
export type ClineSdkSessionRecord = SessionHistoryRecord;
export type ClineSdkPersistedMessage = MessageWithMetadata;
export type ClineSdkUserInstructionService = UserInstructionConfigService;
export interface ClineSdkSlashCommand {
	name: string;
	instructions: string;
	description?: string;
}
export type ClineSdkToolApprovalRequest = ToolApprovalRequest;
export type ClineSdkToolApprovalResult = ToolApprovalResult;
export type ClineSdkExtraTool = NonNullable<ClineSdkStartSessionInput["config"]["extraTools"]>[number];

export interface CreateClineSdkRunCommandsToolOptions {
	/** Working directory for command execution. */
	cwd: string;
	/** Per-command timeout in milliseconds. */
	timeoutMs: number;
}

/**
 * Build the SDK `run_commands` tool with an explicit command timeout.
 *
 * Why this exists: @clinebot/core 0.0.38 hard-codes a 30s timeout in both the
 * tool wrapper (`bashTimeoutMs`) and the process executor (`timeoutMs`), and
 * exposes no session-level setting for either. The SDK tool factory already
 * accepts the knob, so this reuses the SDK factories instead of reimplementing
 * the tool.
 *
 * Register the result through `localRuntime.extraTools`: the SDK composes tools
 * as `[...builtinTools, ...extraTools]` and the agent runtime stores them in a
 * name-keyed map, so a later `run_commands` replaces the builtin for both the
 * model-facing schema and execution.
 *
 * TODO: delete this override once @clinebot/core threads `bashTimeoutMs` through
 * `CoreSessionConfig` / `LocalRuntimeStartOptions`.
 */
export function createClineSdkRunCommandsTool(options: CreateClineSdkRunCommandsToolOptions): ClineSdkExtraTool | null {
	if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
		return null;
	}
	const bashExecutor = createDefaultExecutors({ bash: { timeoutMs: options.timeoutMs } }).bash;
	if (!bashExecutor) {
		return null;
	}
	const tools = createDefaultTools({
		cwd: options.cwd,
		bashTimeoutMs: options.timeoutMs,
		executors: { bash: bashExecutor },
	});
	return tools.find((tool) => tool.name === "run_commands") ?? null;
}

export async function createClineSdkSessionHost(): Promise<ClineSdkSessionHost> {
	return await ClineCore.create({
		backendMode: "auto",
		telemetry: getCliTelemetryService(),
	});
}

export function resolveClineSdkDataDir(): string {
	return resolveClineDataDir();
}
export async function buildClineSdkWorkspaceMetadata(cwd: string): Promise<string> {
	return await buildWorkspaceMetadata(cwd);
}

export function createClineSdkUserInstructionService(workspacePath: string): ClineSdkUserInstructionService {
	return createUserInstructionConfigService({
		skills: { workspacePath },
		rules: { workspacePath },
		workflows: { workspacePath },
	});
}

export function listClineSdkWorkflowSlashCommands(service?: ClineSdkUserInstructionService): ClineSdkSlashCommand[] {
	const builtIns: ClineSdkSlashCommand[] = CLINE_BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		instructions: "",
		description: command.description,
	}));
	if (!service) {
		return builtIns;
	}
	const byName = new Map<string, ClineSdkSlashCommand>();
	for (const command of builtIns) {
		byName.set(command.name, command);
	}
	for (const command of service.listRuntimeCommands()) {
		if (byName.has(command.name)) {
			continue;
		}
		byName.set(command.name, {
			name: command.name,
			instructions: command.instructions,
			description: command.kind === "workflow" ? "Workflow command" : "Skill command",
		});
	}
	return [...byName.values()];
}

export function resolveClineSdkWorkflowSlashCommand(prompt: string, service: ClineSdkUserInstructionService): string {
	return service.resolveRuntimeSlashCommand(prompt);
}

export function loadClineSdkRulesForSystemPrompt(service: ClineSdkUserInstructionService): string {
	const rules = service
		.listRecords<RuleConfig>("rule")
		.map((record) => record.item)
		.filter(isRuleEnabled)
		.sort((left, right) => left.name.localeCompare(right.name));
	return formatRulesForSystemPrompt(rules);
}

export async function resolveClineSdkSystemPrompt(input: {
	cwd: string;
	providerId: string;
	rules?: string;
}): Promise<string> {
	// The Cline SDK can run against non-Cline providers too, but only the
	// "cline" provider expects the extra workspace metadata block that powers
	// its repo-aware behavior in the same way the official CLI does.
	const shouldAppendWorkspaceMetadata = input.providerId === "cline";
	const workspaceMetadata = shouldAppendWorkspaceMetadata ? await buildWorkspaceMetadata(input.cwd) : "";
	return getClineDefaultSystemPrompt({
		ide: "Kanban",
		rootPath: input.cwd,
		providerId: input.providerId,
		metadata: workspaceMetadata,
		rules: input.rules ?? "",
	});
}
