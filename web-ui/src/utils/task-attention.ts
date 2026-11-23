import type { RuntimeTaskSessionSummary } from "@/runtime/types";

/**
 * `latestHookActivity.notificationType` value emitted when an agent pauses to
 * ask the user a question (e.g. Cline's `ask_followup_question` /
 * `plan_mode_respond`, or a hook-based agent's `user_attention` notification).
 */
export const USER_ATTENTION_NOTIFICATION_TYPE = "user_attention";

/**
 * True when a task's session is parked in review specifically because the agent
 * is waiting for the user to answer a question.
 *
 * This is intentionally derived from the existing session summary rather than a
 * new board state, so it can flow through every agent adapter (Cline SDK and
 * hook-based terminals) without changing the task pipeline.
 */
export function isTaskAwaitingUserInput(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary || summary.state !== "awaiting_review") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === USER_ATTENTION_NOTIFICATION_TYPE;
}

/**
 * Best-effort prompt shown when a task needs input. The agent's tool input
 * summary usually holds the question itself; fall back to the final message for
 * adapters that only report one.
 */
export function getTaskUserAttentionPrompt(summary: RuntimeTaskSessionSummary | null | undefined): string | null {
	if (!summary || !isTaskAwaitingUserInput(summary)) {
		return null;
	}
	const activity = summary.latestHookActivity;
	const prompt = activity?.toolInputSummary?.trim() || activity?.finalMessage?.trim();
	return prompt && prompt.length > 0 ? prompt : null;
}
