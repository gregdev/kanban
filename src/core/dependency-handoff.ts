// Deterministic handoff note for auto-started dependents.
//
// Dependencies are scheduling metadata only: when a linked prerequisite finishes
// and unblocks a backlog task, the dependent agent starts with its own stored
// prompt and no knowledge that a predecessor existed. That made agents re-derive
// the codebase state from scratch and occasionally duplicate or revert work that
// the prerequisite had already committed.
//
// This module builds the short, factual pointer that the auto-start path
// prepends to the kickoff prompt. It is deliberately harness metadata: no
// transcript replay, no diffs, and no LLM summary. Callers must never persist
// the result onto the board card.
export const DEPENDENCY_HANDOFF_CONTEXT_HEADER = "Kanban handoff context (harness note, not from the user):";

export interface DependencyHandoffNoteInput {
	/** Id of the task that completed and unblocked the dependent. */
	prerequisiteTaskId: string;
	/** Display title from the prerequisite card, when the board still has it. */
	prerequisiteTitle?: string | null;
	/** Base ref the dependent worktree is created from. */
	baseRef: string;
	/** Commit resolved for the prerequisite, or null when nothing was found. */
	commitSha?: string | null;
}

/** Keeps a user-authored title from blowing the note past its token budget. */
const MAX_PREREQUISITE_TITLE_LENGTH = 80;

const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

function normalizeInlineText(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncateTitle(title: string): string {
	if (title.length <= MAX_PREREQUISITE_TITLE_LENGTH) {
		return title;
	}
	return `${title.slice(0, MAX_PREREQUISITE_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Builds the plain-text handoff note. Returns an empty string when there is not
 * enough information for a factual statement (missing task id or base ref), so
 * callers can treat the result as "no note".
 */
export function buildDependencyHandoffNote(input: DependencyHandoffNoteInput): string {
	const prerequisiteTaskId = normalizeInlineText(input.prerequisiteTaskId);
	const baseRef = normalizeInlineText(input.baseRef);
	if (!prerequisiteTaskId || !baseRef) {
		return "";
	}

	const title = truncateTitle(normalizeInlineText(input.prerequisiteTitle));
	const prerequisiteLabel = title ? `${prerequisiteTaskId} "${title}"` : prerequisiteTaskId;
	const lines = [
		DEPENDENCY_HANDOFF_CONTEXT_HEADER,
		`- This task is linked after ${prerequisiteLabel}, which completed and was moved to done.`,
	];

	const commitSha = normalizeInlineText(input.commitSha);
	if (commitSha && COMMIT_SHA_PATTERN.test(commitSha)) {
		lines.push(
			`- Its changes were committed as ${commitSha} onto ${baseRef}. Inspect with: git show ${commitSha} --stat`,
		);
	} else {
		lines.push(
			`- No commit for the prerequisite was found on ${baseRef}; its changes may not be present in this worktree.`,
		);
	}

	return lines.join("\n");
}

/** Prepends the note, keeping the user's stored prompt intact below it. */
export function prependDependencyHandoffNote(note: string, prompt: string): string {
	if (!note) {
		return prompt;
	}
	return prompt ? `${note}\n\n${prompt}` : note;
}
