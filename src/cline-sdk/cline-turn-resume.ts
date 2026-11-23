// Domain helpers for the explicit, single-shot native Cline turn resume.
//
// The Cline SDK does not expose a native "resume the interrupted run" API, so
// Kanban resumes by rebinding the persisted session and sending one explicit
// continuation instruction. These helpers keep the eligibility, refusal, and
// retryability rules in one place so the session service stays focused on
// orchestration.
import type { RuntimeTaskSessionSummary } from "../core/api-contract";
import { ClineSessionConfigUnavailableError } from "./cline-session-errors";
import { isCreditLimitError } from "./cline-session-state";

/**
 * Instruction sent as the next (single) turn after an interrupted turn.
 *
 * It intentionally does not repeat the original user message. The SDK keeps
 * the existing conversation (including applied tool results) and continues
 * from there.
 */
export const CLINE_RESUME_TURN_INSTRUCTION =
	"Continue the interrupted turn from where it stopped. Do not repeat steps that already completed, and do not re-run tool calls whose results are already in the conversation. Finish the remaining work.";

/** System message appended to the Kanban transcript when a resume is accepted. */
export const CLINE_RESUME_TURN_SYSTEM_MESSAGE = "Resuming interrupted turn";

const NON_RETRYABLE_AUTH_ERROR_PATTERNS = [
	"requires re-authentication",
	"re-authentication required",
	"invalid api key",
	"invalid_api_key",
	"missing api key",
	"no api key",
	"not authenticated",
	"authentication failed",
	"unauthorized",
] as const;

/**
 * Detect provider/auth failures that cannot be fixed by retrying the turn.
 *
 * Resuming these would just fail again, so the caller refuses and asks the
 * user to sign in or update credentials first.
 */
export function isClineAuthError(message: string | null): boolean {
	if (!message) {
		return false;
	}
	const normalized = message.toLowerCase();
	return NON_RETRYABLE_AUTH_ERROR_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Only dead turns are resumable:
 * - `interrupted` after the user aborted or the session was stopped.
 * - `awaiting_review` with `reviewReason: "error"` after a non-recoverable
 *   provider/runtime failure.
 *
 * Running turns are handled separately as a no-op so a double click cannot
 * start two continuations.
 */
export function canResumeClineTurn(summary: RuntimeTaskSessionSummary): boolean {
	if (summary.state === "interrupted") {
		return true;
	}
	return summary.state === "awaiting_review" && summary.reviewReason === "error";
}

export type ClineTurnResumeRefusalReason = "credit_limit" | "auth";

export interface ClineTurnResumeRefusal {
	reason: ClineTurnResumeRefusalReason;
	message: string;
}

/**
 * Return a refusal for failures that a resume attempt cannot fix.
 *
 * Credit-limit detection reuses the same helper as the event adapter, and the
 * activity notification type is checked first because the adapter clears
 * `warningMessage` for credit exhaustion.
 */
export function resolveClineTurnResumeRefusal(summary: RuntimeTaskSessionSummary): ClineTurnResumeRefusal | null {
	const activity = summary.latestHookActivity;
	const terminalMessages = [summary.warningMessage ?? null, activity?.finalMessage ?? null].filter(
		(message): message is string => typeof message === "string" && message.trim().length > 0,
	);

	const creditLimitExceeded =
		activity?.notificationType === "credit_limit" || terminalMessages.some(isCreditLimitError);
	if (creditLimitExceeded) {
		return {
			reason: "credit_limit",
			message: "This turn stopped because the Cline account ran out of credits. Add credits before resuming.",
		};
	}

	if (terminalMessages.some(isClineAuthError)) {
		return {
			reason: "auth",
			message: "This turn stopped because Cline needs you to sign in again. Re-authenticate before resuming.",
		};
	}

	return null;
}

const MISSING_LIVE_SESSION_PATTERNS = [
	"session not found",
	"no active cline session",
	"no resumable cline session",
	"no previous cline session config",
	"unknown session",
] as const;

/**
 * Detect the error shape produced when the persisted session exists but the
 * SDK runtime no longer holds a live session for it (for example after the
 * runtime host restarted). The service can rebuild a live session from
 * repaired persisted history in that case.
 *
 * `ClineSessionConfigUnavailableError` is matched structurally; the string
 * patterns remain as a fallback for errors that cross an SDK/process boundary
 * and lose their class identity.
 */
export function isMissingLiveClineSessionError(error: unknown): boolean {
	if (error instanceof ClineSessionConfigUnavailableError) {
		return true;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	const normalized = error.message.toLowerCase();
	return MISSING_LIVE_SESSION_PATTERNS.some((pattern) => normalized.includes(pattern));
}
