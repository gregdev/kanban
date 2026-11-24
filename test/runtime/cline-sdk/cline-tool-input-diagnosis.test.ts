import { describe, expect, it } from "vitest";

import {
	createClineToolInputDiagnosisHooks,
	diagnoseMalformedToolInput,
	formatMalformedToolInputError,
} from "../../../src/cline-sdk/cline-tool-input-diagnosis";
import type { AgentHooks } from "../../../src/cline-sdk/sdk-runtime-boundary";

type AfterToolContext = Parameters<NonNullable<AgentHooks["afterTool"]>>[0];

function createAfterToolContext(input: { metadata?: unknown }): AfterToolContext {
	return {
		toolCall: {
			type: "tool-call",
			toolCallId: "call_00_yMkMrlXhAOsScp7ce7in7527",
			toolName: "search_codebase",
			input: {},
			metadata: input.metadata,
		},
		input: {},
		result: { output: { error: "raw sdk error" }, isError: true },
	} as unknown as AfterToolContext;
}

describe("diagnoseMalformedToolInput", () => {
	it("names an invalid regex escape the way the model wrote it", () => {
		// Verbatim shape from task 05762: the model wanted regex `\{` and wrote a
		// single backslash inside a JSON string.
		expect(diagnoseMalformedToolInput('{"queries": ["import \\{ PromptCodeEditor"]}')).toBe(
			'invalid escape sequence "\\{" at position 21; inside a JSON string a literal backslash must be written as "\\\\".',
		);
	});

	it("flags an unescaped quote inside a string value", () => {
		expect(diagnoseMalformedToolInput('{"queries": ["he said "hi""]}')).toBe(
			`unescaped '"' at position 22 closes the string too early; escape inner quotes as '\\"'.`,
		);
	});

	it("reports a payload that ends inside a string", () => {
		expect(diagnoseMalformedToolInput('{"queries": ["abc')).toBe(
			"the arguments end before the JSON document is closed (truncated payload).",
		);
	});

	it("reports a payload with unclosed brackets", () => {
		expect(diagnoseMalformedToolInput('{"queries": ["a",')).toBe(
			"the arguments end before the JSON document is closed (truncated payload).",
		);
	});

	it("reports a closing bracket that was never opened", () => {
		expect(diagnoseMalformedToolInput('{"a": 1}}')).toBe(
			"the arguments contain a closing bracket that was never opened.",
		);
	});

	it("reports empty arguments", () => {
		expect(diagnoseMalformedToolInput("   ")).toBe("the arguments were empty.");
	});

	it("reports arguments that are not an object or array", () => {
		expect(diagnoseMalformedToolInput("queries=PromptCodeEditor")).toBe(
			"the arguments must be a JSON object or array.",
		);
	});

	it("ignores escaped quotes when scanning", () => {
		expect(diagnoseMalformedToolInput('{"a": "he said \\"hi\\"", "b": }')).toBe("the arguments are not valid JSON.");
	});
});

describe("formatMalformedToolInputError", () => {
	it("keeps the SDK prefix and adds the retry hint", () => {
		const message = formatMalformedToolInputError({
			toolName: "search_codebase",
			rawInputText: '{"queries": ["import \\{ PromptCodeEditor"]}',
		});

		expect(message.startsWith("Tool call search_codebase emitted invalid JSON arguments: ")).toBe(true);
		expect(message).toContain('invalid escape sequence "\\{"');
		expect(message).toContain("Re-emit the call with valid JSON.");
	});

	it("omits the hint when truncation already explains the fix", () => {
		const message = formatMalformedToolInputError({
			toolName: "run_commands",
			rawInputText: '{"commands": ["git add -A',
		});

		expect(message).toBe(
			"Tool call run_commands emitted invalid JSON arguments: the arguments end before the JSON document is closed (truncated payload).",
		);
	});

	it("falls back to a generic tool name", () => {
		const message = formatMalformedToolInputError({ toolName: null, rawInputText: "" });

		expect(message).toBe("Tool call tool emitted invalid JSON arguments: the arguments were empty.");
	});
});

describe("createClineToolInputDiagnosisHooks", () => {
	it("replaces the serialised SDK error so the model can act on it", async () => {
		const hooks = createClineToolInputDiagnosisHooks();
		const result = await hooks.afterTool?.(
			createAfterToolContext({
				metadata: {
					inputParseError:
						"Tool call search_codebase emitted invalid JSON arguments: Tool call arguments could not be parsed as JSON.",
					rawInputText: '{"queries": ["import \\{ PromptCodeEditor"]}',
				},
			}),
		);

		expect(result?.result?.isError).toBe(true);
		expect(result?.result?.output).toEqual({
			error: 'Tool call search_codebase emitted invalid JSON arguments: invalid escape sequence "\\{" at position 21; inside a JSON string a literal backslash must be written as "\\\\". Re-emit the call with valid JSON.',
		});
	});

	it("leaves successful tool calls untouched", async () => {
		const hooks = createClineToolInputDiagnosisHooks();

		expect(await hooks.afterTool?.(createAfterToolContext({ metadata: undefined }))).toBeUndefined();
		expect(
			await hooks.afterTool?.(createAfterToolContext({ metadata: { toolSource: { providerId: "x" } } })),
		).toBeUndefined();
	});
});
