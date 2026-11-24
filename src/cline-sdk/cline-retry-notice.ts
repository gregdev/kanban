// Turns the SDK's recoverable `agent_error` diagnostics into one-line notices.
//
// `@clinebot/core`'s mistake tracker reports a failed turn by emitting an error
// event whose message is an internal diagnostic, for example:
//
//   1 tool call(s) failed: [search_codebase] {"error":"Tool call search_codebase
//   emitted invalid JSON arguments: Tool call arguments could not be parsed..."}
//
// Kanban renders every recoverable error as a `Retrying:` system message, so
// without this the transcript shows raw SDK JSON instead of a readable notice.
// Messages this module does not recognise are returned verbatim, so genuinely
// user-facing errors (provider auth failures, credit limits) keep their detail.

const TOOL_FAILURE_SUMMARY_PATTERN = /^(\d+)\s+tool call\(s\) failed(?::\s*([\s\S]*))?$/;
// Failure details are joined with "; " and every entry starts with "[<tool>]".
const TOOL_FAILURE_ENTRY_SEPARATOR = /;\s*(?=\[)/;
const TOOL_FAILURE_ENTRY_PATTERN = /^\[([^\]]+)\]\s*([\s\S]*)$/;
const MALFORMED_ARGUMENTS_PATTERN = /^Tool call .+? emitted invalid JSON arguments:/i;
// Loop detection reports itself instead of a tool failure, so match it first.
const REPEATED_CALL_PATTERN = /consecutive identical calls to `([^`]+)`/i;

const MAX_LISTED_TOOL_NAMES = 3;

interface FailedToolCall {
	toolName: string;
	malformedArguments: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Failure details carry the synthetic tool result, which the SDK serialises as
 * `{"error":"..."}`. Unwrap it so classification sees the real message.
 */
function readFailureMessage(detail: string): string {
	const trimmed = detail.trim();
	if (!trimmed.startsWith("{")) {
		return trimmed;
	}
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (isRecord(parsed) && typeof parsed.error === "string") {
			return parsed.error.trim();
		}
	} catch {
		// Not a serialised tool result; keep the raw detail below.
	}
	return trimmed;
}

function parseFailedToolCalls(details: string): FailedToolCall[] {
	if (!details.trim()) {
		return [];
	}
	const failedCalls: FailedToolCall[] = [];
	for (const rawEntry of details.split(TOOL_FAILURE_ENTRY_SEPARATOR)) {
		const match = rawEntry.trim().match(TOOL_FAILURE_ENTRY_PATTERN);
		if (!match?.[1]) {
			// Unrecognised shape: bail out entirely rather than half-describe it.
			return [];
		}
		const message = readFailureMessage(match[2] ?? "");
		failedCalls.push({
			toolName: match[1].trim(),
			malformedArguments: MALFORMED_ARGUMENTS_PATTERN.test(message),
		});
	}
	return failedCalls;
}

function formatToolNameList(toolNames: string[]): string {
	const uniqueNames = Array.from(new Set(toolNames));
	if (uniqueNames.length <= MAX_LISTED_TOOL_NAMES) {
		return uniqueNames.join(", ");
	}
	const listed = uniqueNames.slice(0, MAX_LISTED_TOOL_NAMES).join(", ");
	return `${listed} +${uniqueNames.length - MAX_LISTED_TOOL_NAMES} more`;
}

function describeFailedToolCalls(count: number): string {
	return count === 1 ? "1 failed tool call" : `${count} failed tool calls`;
}

/**
 * Rewrites an SDK recoverable-error message into a short user-facing phrase,
 * without the `Retrying:` prefix the caller adds. Unknown messages pass through
 * unchanged so provider errors keep their original wording.
 */
export function summarizeClineRecoverableError(errorMessage: string): string {
	const normalized = errorMessage.trim();
	const repeatedCallMatch = normalized.match(REPEATED_CALL_PATTERN);
	if (repeatedCallMatch?.[1]) {
		return `repeated calls to ${repeatedCallMatch[1].trim()}`;
	}

	const summaryMatch = normalized.match(TOOL_FAILURE_SUMMARY_PATTERN);
	if (!summaryMatch?.[1]) {
		return errorMessage;
	}
	const reportedCount = Number.parseInt(summaryMatch[1], 10);
	if (!Number.isFinite(reportedCount) || reportedCount <= 0) {
		return errorMessage;
	}

	const details = summaryMatch[2]?.trim() ?? "";
	if (!details) {
		return describeFailedToolCalls(reportedCount);
	}
	const failedCalls = parseFailedToolCalls(details);
	if (failedCalls.length === 0) {
		// Details we cannot parse keep their original wording rather than being
		// replaced by a bare count.
		return errorMessage;
	}

	const toolNames = failedCalls.map((failedCall) => failedCall.toolName);
	if (failedCalls.every((failedCall) => failedCall.malformedArguments)) {
		return `malformed tool arguments for ${formatToolNameList(toolNames)}`;
	}
	return `${describeFailedToolCalls(failedCalls.length)} (${formatToolNameList(toolNames)})`;
}
