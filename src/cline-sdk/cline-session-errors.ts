// Typed failures for native Cline session recovery.
//
// These live in their own module so both the session runtime (which throws them)
// and the turn-resume helpers (which classify them) can import them without
// creating a circular dependency.

const DEFAULT_CONFIG_UNAVAILABLE_MESSAGE =
	"Restart the task (or rebind it to its persisted Cline session) to continue.";

/**
 * Raised when Kanban can no longer rebuild the launch configuration for a task
 * session, for example after the runtime process restarted and the persisted
 * session metadata no longer carries a usable provider/model/mode combination.
 *
 * The message is user-facing on purpose: it must tell the user what to do next
 * instead of reading like a generic SDK crash.
 */
export class ClineSessionConfigUnavailableError extends Error {
	readonly taskId: string;

	constructor(taskId: string, detail?: string | null) {
		const normalizedDetail = detail?.trim() ?? "";
		const message = normalizedDetail
			? `Cannot restart the Cline session for task ${taskId}: ${ensureSentence(normalizedDetail)} ${DEFAULT_CONFIG_UNAVAILABLE_MESSAGE}`
			: `No stored Cline session configuration is available for task ${taskId}. ${DEFAULT_CONFIG_UNAVAILABLE_MESSAGE}`;
		super(message, normalizedDetail ? { cause: detail } : undefined);
		this.name = "ClineSessionConfigUnavailableError";
		this.taskId = taskId;
	}
}

function ensureSentence(value: string): string {
	return /[.!?]$/.test(value) ? value : `${value}.`;
}
