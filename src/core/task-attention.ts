import type { RuntimeTaskSessionSummary } from "./api-contract";

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
 *
 * Shared by the runtime auto-review reconciler (which must not arm, deliver, or
 * complete a git action behind a pending question) and the web UI (which badges
 * such cards), so every actor agrees on what "waiting on the user" means.
 */
export function isTaskAwaitingUserInput(summary: RuntimeTaskSessionSummary | null | undefined): boolean {
	if (!summary || summary.state !== "awaiting_review") {
		return false;
	}
	return summary.latestHookActivity?.notificationType === USER_ATTENTION_NOTIFICATION_TYPE;
}
