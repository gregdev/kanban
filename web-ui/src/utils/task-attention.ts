import { isTaskAwaitingUserInput } from "@runtime-task-attention";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

// The predicate is shared with the runtime auto-review reconciler, which must
// respect the same "waiting on the user" state before it ships a task.
export { isTaskAwaitingUserInput, USER_ATTENTION_NOTIFICATION_TYPE } from "@runtime-task-attention";

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
