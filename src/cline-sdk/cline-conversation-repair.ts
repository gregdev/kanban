// Repairs conversation histories that contain tool calls without a matching
// tool result. Providers reject such histories with an error like
// "Tool result is missing for tool call call_...", which aborts the next turn.
//
// Two conversation shapes need repair:
// - Persisted SDK messages use Anthropic-style `tool_use` / `tool_result`
//   blocks. They are replayed as `initialMessages` whenever Kanban restarts a
//   session (for example after the previous turn ended or was aborted).
// - Agent runtime messages use `tool-call` / `tool-result` parts. They are sent
//   to the model on every iteration, including right after a tool execution was
//   interrupted before its results were appended.
import type {
	AgentHooks,
	AgentMessage,
	AgentMessagePart,
	AgentToolCallPart,
	AgentToolResultPart,
	ContentBlock,
	MessageWithMetadata,
	ToolResultContent,
	ToolUseContent,
} from "./sdk-runtime-boundary";

export const INTERRUPTED_TOOL_RESULT_TEXT =
	"Tool call was interrupted before a result was recorded. Re-check the current workspace state before continuing.";

const MISSING_TOOL_RESULT_ERROR_PATTERN = /tool result (?:is )?missing for tool call/i;

let repairedMessageSequence = 0;

function nextRepairedMessageId(suffix: string): string {
	repairedMessageSequence += 1;
	return `tool_result_repair_${suffix}_${repairedMessageSequence}`;
}

/**
 * Detects provider errors caused by an assistant tool call that has no
 * matching tool result in the replay history.
 */
export function isMissingToolResultError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	return MISSING_TOOL_RESULT_ERROR_PATTERN.test(message);
}

interface ToolCallDescriptor {
	id: string;
	name: string | null;
}

interface ToolResultDescriptor {
	id: string;
}

interface ConversationAdapter<TMessage, TBlock> {
	getRole(message: TMessage): string;
	getBlocks(message: TMessage): TBlock[] | null;
	readToolCall(block: TBlock): ToolCallDescriptor | null;
	readToolResult(block: TBlock): ToolResultDescriptor | null;
	createToolResultBlock(call: ToolCallDescriptor): TBlock;
	replaceBlocks(message: TMessage, blocks: TBlock[], changed: boolean): TMessage;
	/** Builds a tool-result message that immediately follows `template`. */
	createToolResultMessage(template: TMessage, results: TBlock[]): TMessage;
}

interface ToolCallRef extends ToolCallDescriptor {
	messageIndex: number;
	blockIndex: number;
}

interface ToolResultRef extends ToolResultDescriptor {
	messageIndex: number;
	blockIndex: number;
}

function blockKey(messageIndex: number, blockIndex: number): string {
	return `${messageIndex}:${blockIndex}`;
}

function repairToolResultSequence<TMessage, TBlock>(
	messages: readonly TMessage[],
	adapter: ConversationAdapter<TMessage, TBlock>,
): readonly TMessage[] {
	if (messages.length === 0) {
		return messages;
	}

	const calls: ToolCallRef[] = [];
	const results: ToolResultRef[] = [];
	messages.forEach((message, messageIndex) => {
		const blocks = adapter.getBlocks(message);
		if (!blocks) {
			return;
		}
		blocks.forEach((block, blockIndex) => {
			const call = adapter.readToolCall(block);
			if (call) {
				calls.push({ ...call, messageIndex, blockIndex });
				return;
			}
			const result = adapter.readToolResult(block);
			if (result) {
				results.push({ ...result, messageIndex, blockIndex });
			}
		});
	});

	if (calls.length === 0 && results.length === 0) {
		return messages;
	}

	const firstCallById = new Map<string, ToolCallRef>();
	for (const call of calls) {
		if (!firstCallById.has(call.id)) {
			firstCallById.set(call.id, call);
		}
	}

	// A result only counts when it follows its call and is the first result for
	// that call. Everything else is orphaned history (for example after
	// compaction sliced the call away) and would also be rejected by providers.
	const keptResultBlockKeys = new Set<string>();
	const resolvedCallIds = new Set<string>();
	for (const result of results) {
		const call = firstCallById.get(result.id);
		if (!call) {
			continue;
		}
		const followsCall =
			result.messageIndex > call.messageIndex ||
			(result.messageIndex === call.messageIndex && result.blockIndex > call.blockIndex);
		if (!followsCall || resolvedCallIds.has(result.id)) {
			continue;
		}
		resolvedCallIds.add(result.id);
		keptResultBlockKeys.add(blockKey(result.messageIndex, result.blockIndex));
	}

	const unresolvedCallsByMessageIndex = new Map<number, ToolCallDescriptor[]>();
	for (const call of calls) {
		if (resolvedCallIds.has(call.id)) {
			continue;
		}
		const unresolvedCalls = unresolvedCallsByMessageIndex.get(call.messageIndex) ?? [];
		unresolvedCalls.push({ id: call.id, name: call.name });
		unresolvedCallsByMessageIndex.set(call.messageIndex, unresolvedCalls);
	}

	const appendedResultsByMessageIndex = new Map<number, TBlock[]>();
	const insertedMessagesAfterIndex = new Map<number, TBlock[]>();
	for (const [messageIndex, unresolvedCalls] of unresolvedCallsByMessageIndex) {
		const nextIndex = messageIndex + 1;
		const nextBlocks = nextIndex < messages.length ? adapter.getBlocks(messages[nextIndex]) : null;
		const nextMessageHasToolResults = Boolean(nextBlocks?.some((block) => adapter.readToolResult(block) !== null));
		if (nextMessageHasToolResults) {
			const syntheticBlocks = unresolvedCalls.map((call) => adapter.createToolResultBlock(call));
			const existing = appendedResultsByMessageIndex.get(nextIndex) ?? [];
			existing.push(...syntheticBlocks);
			appendedResultsByMessageIndex.set(nextIndex, existing);
			continue;
		}
		insertedMessagesAfterIndex.set(
			messageIndex,
			unresolvedCalls.map((call) => adapter.createToolResultBlock(call)),
		);
	}

	let changed = false;
	const repaired: TMessage[] = [];
	messages.forEach((message, messageIndex) => {
		const blocks = adapter.getBlocks(message);
		if (!blocks) {
			repaired.push(message);
			return;
		}

		let messageChanged = false;
		const nextBlocks: TBlock[] = [];
		blocks.forEach((block, blockIndex) => {
			const isResult = adapter.readToolResult(block) !== null;
			if (isResult && !keptResultBlockKeys.has(blockKey(messageIndex, blockIndex))) {
				messageChanged = true;
				return;
			}
			nextBlocks.push(block);
		});

		const appendedResults = appendedResultsByMessageIndex.get(messageIndex);
		if (appendedResults) {
			nextBlocks.push(...appendedResults);
			messageChanged = true;
		}

		if (messageChanged) {
			changed = true;
		}
		if (nextBlocks.length === 0) {
			// Empty assistant/user messages are invalid input; dropping them is the
			// only safe repair once their orphaned blocks are removed.
			changed = true;
			return;
		}
		repaired.push(adapter.replaceBlocks(message, nextBlocks, messageChanged));

		const insertedResults = insertedMessagesAfterIndex.get(messageIndex);
		if (insertedResults) {
			repaired.push(adapter.createToolResultMessage(message, insertedResults));
			changed = true;
		}
	});

	return changed ? repaired : messages;
}

function isToolUseBlock(block: ContentBlock): block is ToolUseContent {
	return block.type === "tool_use";
}

function isToolResultBlock(block: ContentBlock): block is ToolResultContent {
	return block.type === "tool_result";
}

const persistedMessageAdapter: ConversationAdapter<MessageWithMetadata, ContentBlock> = {
	getRole: (message) => message.role,
	getBlocks: (message) => (Array.isArray(message.content) ? message.content : null),
	readToolCall: (block) =>
		isToolUseBlock(block) ? { id: block.id, name: typeof block.name === "string" ? block.name : null } : null,
	readToolResult: (block) => (isToolResultBlock(block) ? { id: block.tool_use_id } : null),
	createToolResultBlock: (call) => ({
		type: "tool_result",
		tool_use_id: call.id,
		content: INTERRUPTED_TOOL_RESULT_TEXT,
		is_error: true,
	}),
	replaceBlocks: (message, blocks, changed) => (changed ? { ...message, content: blocks } : message),
	createToolResultMessage: (template, results) => ({
		id: nextRepairedMessageId(template.id ?? "message"),
		role: "user",
		content: results,
		...(template.ts !== undefined ? { ts: template.ts } : {}),
		...(template.agent ? { agent: template.agent } : {}),
		...(template.sessionId ? { sessionId: template.sessionId } : {}),
	}),
};

function isAgentToolCallPart(block: AgentMessagePart): block is AgentToolCallPart {
	return block.type === "tool-call";
}

function isAgentToolResultPart(block: AgentMessagePart): block is AgentToolResultPart {
	return block.type === "tool-result";
}

const agentMessageAdapter: ConversationAdapter<AgentMessage, AgentMessagePart> = {
	getRole: (message) => message.role,
	getBlocks: (message) => message.content,
	readToolCall: (block) =>
		isAgentToolCallPart(block)
			? { id: block.toolCallId, name: block.toolName.length > 0 ? block.toolName : null }
			: null,
	readToolResult: (block) => (isAgentToolResultPart(block) ? { id: block.toolCallId } : null),
	createToolResultBlock: (call) => ({
		type: "tool-result",
		toolCallId: call.id,
		toolName: call.name ?? "tool",
		output: INTERRUPTED_TOOL_RESULT_TEXT,
		isError: true,
	}),
	replaceBlocks: (message, blocks, changed) => (changed ? { ...message, content: blocks } : message),
	createToolResultMessage: (template, results) => ({
		id: nextRepairedMessageId(template.id),
		role: "tool",
		content: results,
		createdAt: template.createdAt,
	}),
};

/**
 * Repairs persisted Cline session messages before they are replayed as
 * `initialMessages` for a restarted session.
 *
 * The result is mutable because the SDK's `ClineCoreStartInput.initialMessages`
 * is declared as `LlmsProviders.Message[]`, not a readonly array.
 */
export function repairClinePersistedToolResults(messages: MessageWithMetadata[]): MessageWithMetadata[] {
	const repaired = repairToolResultSequence(messages, persistedMessageAdapter);
	// Preserve array identity when nothing needed repair; only materialize a
	// mutable copy for the freshly built sequence.
	return repaired === messages ? messages : [...repaired];
}

/**
 * Repairs the live agent conversation before it is sent to the model.
 */
export function repairClineAgentToolResults(messages: readonly AgentMessage[]): readonly AgentMessage[] {
	return repairToolResultSequence(messages, agentMessageAdapter);
}

/**
 * Agent runtime hooks that sanitize the outgoing conversation on every model
 * call. This covers sessions that are still live, where the interrupted tool
 * call only exists in the agent's in-memory message state.
 */
export function createClineConversationRepairHooks(): AgentHooks {
	return {
		beforeModel: ({ request }) => {
			const repairedMessages = repairClineAgentToolResults(request.messages);
			if (repairedMessages === request.messages) {
				return undefined;
			}
			return { messages: repairedMessages };
		},
	};
}
