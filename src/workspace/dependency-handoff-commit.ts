// Best-effort commit resolution for the dependency handoff note.
//
// The note may only state a commit when Kanban can prove one exists for the
// prerequisite. Two facts are checked, in order:
//
//   1. The prerequisite's task worktree is authoritative while it still exists:
//      its HEAD is the commit the prerequisite agent created. It is only usable
//      when it is reachable from the dependent's base ref and is not merely the
//      base ref tip (a worktree starts detached at the base commit, so an
//      unmodified worktree reports the base commit as HEAD).
//   2. Otherwise the prerequisite was committed onto the base ref under its task
//      id (the handoff contract), so search that ref's log.
//
// Anything else resolves to null and the caller emits the honest "no commit"
// variant instead of guessing.
import { runGit } from "./git-utils";
import { getTaskWorkspacePathInfo } from "./task-worktree";

export interface ResolveDependencyHandoffCommitInput {
	workspacePath: string;
	prerequisiteTaskId: string;
	/** Base ref the dependent worktree is created from. */
	baseRef: string;
}

async function resolveCommitAtRef(cwd: string, ref: string): Promise<string | null> {
	const result = await runGit(cwd, ["rev-parse", "--verify", ref]);
	const commit = result.ok ? result.stdout.trim() : "";
	return commit || null;
}

async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
	const result = await runGit(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
	return result.ok;
}

/**
 * Resolves the prerequisite commit, or null when no commit can be attributed to
 * it. Never throws: the caller only needs the note to be factual, not to fail
 * the auto-start.
 */
export async function resolveDependencyHandoffCommit(
	input: ResolveDependencyHandoffCommitInput,
): Promise<string | null> {
	const prerequisiteTaskId = input.prerequisiteTaskId.trim();
	const baseRef = input.baseRef.trim();
	if (!prerequisiteTaskId || !baseRef) {
		return null;
	}

	try {
		const baseRefTip = await resolveCommitAtRef(input.workspacePath, baseRef);
		if (baseRefTip) {
			const worktree = await getTaskWorkspacePathInfo({
				cwd: input.workspacePath,
				taskId: prerequisiteTaskId,
				baseRef,
			});
			if (worktree.exists) {
				const worktreeHead = await resolveCommitAtRef(worktree.path, "HEAD");
				if (
					worktreeHead &&
					worktreeHead !== baseRefTip &&
					(await isAncestor(input.workspacePath, worktreeHead, baseRef))
				) {
					return worktreeHead;
				}
			}
		}

		// `--fixed-strings` keeps a task id with regex metacharacters from
		// matching unrelated commit messages.
		const log = await runGit(input.workspacePath, [
			"log",
			baseRef,
			`--grep=${prerequisiteTaskId}`,
			"--fixed-strings",
			"--format=%H",
			"-n",
			"1",
		]);
		const matchedCommit = log.ok ? (log.stdout.trim().split("\n")[0]?.trim() ?? "") : "";
		return matchedCommit || null;
	} catch {
		return null;
	}
}
