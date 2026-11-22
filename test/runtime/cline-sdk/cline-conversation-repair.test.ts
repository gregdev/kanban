import { describe, expect, it } from "vitest";

import {
	INTERRUPTED_TOOL_RESULT_TEXT,
	isMissingToolResultError,
	repairClineAgentToolResults,
	repairClinePersistedToolResults,
} from "../../../src/cline-sdk/cline-conversation-repair";
import type { AgentMessage, ClineSdkPersistedMessage, ContentBlock } from "../../../src/cline-sdk/sdk-runtime-boundary";

function readContentBlocks(message: ClineSdkPersistedMessage): ContentBlock[] {
	if (!Array.isArray(message.content)) {
		throw new Error("Expected array content blocks");
	}
	return message.content;
}

describe("repairClinePersistedToolResults", () => {
	it("appends an interrupted tool result when an assistant tool call has no result", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Fix the startup crash" },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "call_00_shPcwyAIWid0gsvd2AjS3789",
						name: "read_files",
						input: { files: [{ path: "src/index.ts" }] },
					},
				],
			},
		];

		const repaired = repairClinePersistedToolResults(messages);

		expect(repaired).toHaveLength(3);
		const repairedMessage = repaired[2];
		expect(repairedMessage?.role).toBe("user");
		expect(readContentBlocks(repairedMessage as ClineSdkPersistedMessage)).toEqual([
			{
				type: "tool_result",
				tool_use_id: "call_00_shPcwyAIWid0gsvd2AjS3789",
				content: INTERRUPTED_TOOL_RESULT_TEXT,
				is_error: true,
			},
		]);
	});

	it("returns the original array when every tool call already has a result", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{ role: "user", content: "Fix the startup crash" },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "tool-1", name: "read_files", input: {} }],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
			},
		];

		expect(repairClinePersistedToolResults(messages)).toBe(messages);
	});

	it("appends missing results to the tool-result message that already follows the call", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "tool-1", name: "read_files", input: {} },
					{ type: "tool_use", id: "tool-2", name: "run_commands", input: {} },
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
			},
		];

		const repaired = repairClinePersistedToolResults(messages);

		expect(repaired).toHaveLength(2);
		expect(readContentBlocks(repaired[1] as ClineSdkPersistedMessage)).toEqual([
			{ type: "tool_result", tool_use_id: "tool-1", content: "ok" },
			{
				type: "tool_result",
				tool_use_id: "tool-2",
				content: INTERRUPTED_TOOL_RESULT_TEXT,
				is_error: true,
			},
		]);
	});

	it("drops orphaned tool results whose tool call was removed from history", () => {
		const messages: ClineSdkPersistedMessage[] = [
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "missing-tool", content: "stale" }],
			},
			{ role: "assistant", content: "Recovered response" },
		];

		const repaired = repairClinePersistedToolResults(messages);

		expect(repaired).toHaveLength(1);
		expect(repaired[0]?.role).toBe("assistant");
	});
});

describe("repairClineAgentToolResults", () => {
	it("inserts a tool message before the next user prompt when an agent tool call has no result", () => {
		const messages: AgentMessage[] = [
			{ id: "msg-user-1", role: "user", content: [{ type: "text", text: "Fix it" }], createdAt: 1 },
			{
				id: "msg-assistant-1",
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "read_files",
						input: { files: [] },
					},
				],
				createdAt: 2,
			},
			{ id: "msg-user-2", role: "user", content: [{ type: "text", text: "What happened?" }], createdAt: 3 },
		];

		const repaired = repairClineAgentToolResults(messages);

		expect(repaired.map((message) => message.role)).toEqual(["user", "assistant", "tool", "user"]);
		expect(repaired[2]?.content).toEqual([
			{
				type: "tool-result",
				toolCallId: "call_1",
				toolName: "read_files",
				output: INTERRUPTED_TOOL_RESULT_TEXT,
				isError: true,
			},
		]);
	});

	it("appends missing results to the following tool message", () => {
		const messages: AgentMessage[] = [
			{
				id: "msg-assistant-1",
				role: "assistant",
				content: [
					{ type: "tool-call", toolCallId: "call_1", toolName: "read_files", input: {} },
					{ type: "tool-call", toolCallId: "call_2", toolName: "run_commands", input: {} },
				],
				createdAt: 1,
			},
			{
				id: "msg-tool-1",
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_files",
						output: "ok",
					},
				],
				createdAt: 2,
			},
		];

		const repaired = repairClineAgentToolResults(messages);

		expect(repaired).toHaveLength(2);
		expect(repaired[1]?.content).toEqual([
			{ type: "tool-result", toolCallId: "call_1", toolName: "read_files", output: "ok" },
			{
				type: "tool-result",
				toolCallId: "call_2",
				toolName: "run_commands",
				output: INTERRUPTED_TOOL_RESULT_TEXT,
				isError: true,
			},
		]);
	});

	it("returns the original array when the agent conversation is already valid", () => {
		const messages: AgentMessage[] = [
			{
				id: "msg-assistant-1",
				role: "assistant",
				content: [{ type: "tool-call", toolCallId: "call_1", toolName: "read_files", input: {} }],
				createdAt: 1,
			},
			{
				id: "msg-tool-1",
				role: "tool",
				content: [{ type: "tool-result", toolCallId: "call_1", toolName: "read_files", output: "ok" }],
				createdAt: 2,
			},
		];

		expect(repairClineAgentToolResults(messages)).toBe(messages);
	});
});

describe("isMissingToolResultError", () => {
	it("matches the provider error for a dangling tool call", () => {
		expect(
			isMissingToolResultError(new Error("Tool result is missing for tool call call_00_shPcwyAIWid0gsvd2AjS3789.")),
		).toBe(true);
	});

	it("ignores unrelated errors", () => {
		expect(isMissingToolResultError(new Error("Prompt is too long"))).toBe(false);
		expect(isMissingToolResultError("network timeout")).toBe(false);
	});
});
