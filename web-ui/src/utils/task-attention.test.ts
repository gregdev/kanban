import { describe, expect, it } from "vitest";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { getTaskUserAttentionPrompt, isTaskAwaitingUserInput } from "@/utils/task-attention";

function createSummary(overrides?: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state: "awaiting_review",
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: null,
		exitCode: null,
		lastHookAt: 1,
		latestHookActivity: null,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

describe("isTaskAwaitingUserInput", () => {
	it("returns false for a missing summary", () => {
		expect(isTaskAwaitingUserInput(null)).toBe(false);
		expect(isTaskAwaitingUserInput(undefined)).toBe(false);
	});

	it("returns false unless the session is parked in review", () => {
		const summary = createSummary({
			state: "running",
			latestHookActivity: {
				activityText: null,
				toolName: "ask_followup_question",
				toolInputSummary: "Need approval?",
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: "user_attention",
				source: "cline-sdk",
			},
		});
		expect(isTaskAwaitingUserInput(summary)).toBe(false);
	});

	it("returns false when the review was triggered by something other than user attention", () => {
		for (const notificationType of [null, "credit_limit"]) {
			const summary = createSummary({
				latestHookActivity: {
					activityText: "Waiting for review",
					toolName: null,
					toolInputSummary: null,
					finalMessage: null,
					hookEventName: "agent_end",
					notificationType,
					source: "cline-sdk",
				},
			});
			expect(isTaskAwaitingUserInput(summary)).toBe(false);
		}
	});

	it("returns true when the review is waiting on a user_attention notification", () => {
		const summary = createSummary({
			latestHookActivity: {
				activityText: "Using ask_followup_question(Need approval?)",
				toolName: "ask_followup_question",
				toolInputSummary: "Need approval?",
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: "user_attention",
				source: "cline-sdk",
			},
		});
		expect(isTaskAwaitingUserInput(summary)).toBe(true);
	});
});

describe("getTaskUserAttentionPrompt", () => {
	it("returns the tool input summary as the pending question", () => {
		const summary = createSummary({
			latestHookActivity: {
				activityText: "Using ask_followup_question(Need approval?)",
				toolName: "ask_followup_question",
				toolInputSummary: "Need approval?",
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: "user_attention",
				source: "cline-sdk",
			},
		});
		expect(getTaskUserAttentionPrompt(summary)).toBe("Need approval?");
	});

	it("falls back to the final message when there is no tool summary", () => {
		const summary = createSummary({
			latestHookActivity: {
				activityText: null,
				toolName: null,
				toolInputSummary: null,
				finalMessage: "Which approach do you prefer?",
				hookEventName: "notification",
				notificationType: "user_attention",
				source: "claude",
			},
		});
		expect(getTaskUserAttentionPrompt(summary)).toBe("Which approach do you prefer?");
	});

	it("returns null when the task is not waiting on the user", () => {
		const summary = createSummary({
			state: "running",
			latestHookActivity: {
				activityText: "Using ask_followup_question(Need approval?)",
				toolName: "ask_followup_question",
				toolInputSummary: "Need approval?",
				finalMessage: null,
				hookEventName: "tool_call",
				notificationType: "user_attention",
				source: "cline-sdk",
			},
		});
		expect(getTaskUserAttentionPrompt(summary)).toBeNull();
	});
});
