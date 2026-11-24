// Diagnoses why a model's tool-call arguments were not valid JSON.
//
// Providers occasionally emit malformed JSON for tool arguments (a single
// backslash where JSON needs two, or an unescaped quote inside a string).
// `@clinebot/agents` rejects the call before it executes and hands the model a
// serialised `{"error":"..."}` object, which the model rarely acts on: two of
// the four observed failures in task 05762 needed a second attempt. Naming the
// offending construct and its position makes the retry succeed first time.
import type { AgentAfterToolResult, AgentHooks } from "./sdk-runtime-boundary";

/** Escape characters JSON allows after a backslash. */
const VALID_ESCAPE_CHARACTERS = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);
/** Characters that may legally follow a completed JSON string. */
const CHARACTERS_AFTER_STRING = new Set([",", ":", "}", "]"]);
const RETRY_HINT = "Re-emit the call with valid JSON.";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNextNonWhitespaceCharacter(text: string, from: number): string | null {
	for (let index = from; index < text.length; index += 1) {
		const character = text[index];
		if (character !== undefined && !/\s/.test(character)) {
			return character;
		}
	}
	return null;
}

function describeTruncatedPayload(): string {
	return "the arguments end before the JSON document is closed (truncated payload).";
}

/**
 * Explains the first structural problem in a malformed tool-call payload.
 *
 * The returned text is a continuation of the SDK's
 * `Tool call <name> emitted invalid JSON arguments: ` prefix, so it starts
 * lowercase and ends with a period.
 */
export function diagnoseMalformedToolInput(rawInputText: string): string {
	const text = rawInputText.trim();
	if (!text) {
		return "the arguments were empty.";
	}
	if (!text.startsWith("{") && !text.startsWith("[")) {
		return "the arguments must be a JSON object or array.";
	}

	let inString = false;
	let depth = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === undefined) {
			break;
		}

		if (inString) {
			if (character === "\\") {
				const escaped = text[index + 1];
				if (escaped === undefined) {
					return describeTruncatedPayload();
				}
				if (!VALID_ESCAPE_CHARACTERS.has(escaped)) {
					return `invalid escape sequence "\\${escaped}" at position ${index}; inside a JSON string a literal backslash must be written as "\\\\".`;
				}
				// Skip the escape character so an escaped quote cannot end the string.
				index += 1;
				continue;
			}
			if (character === '"') {
				inString = false;
				// A string that stops where JSON expects a separator means the
				// author almost certainly forgot to escape an inner quote.
				const follower = readNextNonWhitespaceCharacter(text, index + 1);
				if (follower !== null && !CHARACTERS_AFTER_STRING.has(follower)) {
					return `unescaped '"' at position ${index} closes the string too early; escape inner quotes as '\\"'.`;
				}
			}
			continue;
		}

		if (character === '"') {
			inString = true;
			continue;
		}
		if (character === "{" || character === "[") {
			depth += 1;
			continue;
		}
		if (character === "}" || character === "]") {
			depth -= 1;
		}
	}

	if (inString) {
		return describeTruncatedPayload();
	}
	if (depth > 0) {
		return describeTruncatedPayload();
	}
	if (depth < 0) {
		return "the arguments contain a closing bracket that was never opened.";
	}
	return "the arguments are not valid JSON.";
}

/**
 * Builds the replacement tool result for a call whose arguments failed to parse.
 * The prefix matches the SDK's own wording so downstream classification keeps
 * working.
 */
export function formatMalformedToolInputError(input: { toolName: string | null; rawInputText: string }): string {
	const toolName = input.toolName?.trim() || "tool";
	const diagnosis = diagnoseMalformedToolInput(input.rawInputText);
	// Truncation and empty payloads already imply the fix; a bad escape or quote
	// benefits from the explicit hint.
	const needsHint = diagnosis.startsWith("invalid escape") || diagnosis.startsWith("unescaped");
	const hint = needsHint ? ` ${RETRY_HINT}` : "";
	return `Tool call ${toolName} emitted invalid JSON arguments: ${diagnosis}${hint}`;
}

function readMalformedArgumentsToolCall(metadata: unknown): { rawInputText: string } | null {
	if (!isRecord(metadata) || typeof metadata.inputParseError !== "string") {
		return null;
	}
	return {
		rawInputText: typeof metadata.rawInputText === "string" ? metadata.rawInputText : "",
	};
}

/**
 * Replaces the SDK's serialised error object with an actionable message.
 *
 * A call whose arguments failed to parse is skipped before `beforeTool` hooks
 * run (`prepareToolExecution` sets `skipReason` from `metadata.inputParseError`
 * first), so `afterTool` is the only supported place to improve what the model
 * reads next.
 */
export function createClineToolInputDiagnosisHooks(): AgentHooks {
	return {
		afterTool: ({ toolCall, result }): AgentAfterToolResult | undefined => {
			const malformed = readMalformedArgumentsToolCall(toolCall.metadata);
			if (!malformed) {
				return undefined;
			}
			return {
				result: {
					...result,
					output: {
						error: formatMalformedToolInputError({
							toolName: toolCall.toolName,
							rawInputText: malformed.rawInputText,
						}),
					},
					isError: true,
				},
			};
		},
	};
}
