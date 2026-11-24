import { describe, expect, it } from "vitest";

import {
	DEPENDENCY_HANDOFF_CONTEXT_HEADER,
	buildDependencyHandoffNote,
	prependDependencyHandoffNote,
} from "../../../src/core/dependency-handoff";

const COMMIT_SHA = "1234abcd5678ef901234abcd5678ef901234abcd";

describe("buildDependencyHandoffNote", () => {
	it("points at the prerequisite task and its commit", () => {
		const note = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			prerequisiteTitle: "Add the login form",
			baseRef: "main",
			commitSha: COMMIT_SHA,
		});

		expect(note).toBe(
			[
				DEPENDENCY_HANDOFF_CONTEXT_HEADER,
				'- This task is linked after abc12 "Add the login form", which completed and was moved to done.',
				`- Its changes were committed as ${COMMIT_SHA} onto main. Inspect with: git show ${COMMIT_SHA} --stat`,
			].join("\n"),
		);
		expect(note.split("\n")[0]).toBe(DEPENDENCY_HANDOFF_CONTEXT_HEADER);
	});

	it("falls back to the honest variant when no commit was resolved", () => {
		const note = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			prerequisiteTitle: "Add the login form",
			baseRef: "develop",
			commitSha: null,
		});

		expect(note.split("\n")).toEqual([
			DEPENDENCY_HANDOFF_CONTEXT_HEADER,
			'- This task is linked after abc12 "Add the login form", which completed and was moved to done.',
			"- No commit for the prerequisite was found on develop; its changes may not be present in this worktree.",
		]);
	});

	it("never states a commit that does not look like a sha", () => {
		const note = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			baseRef: "main",
			commitSha: "not-a-commit",
		});

		expect(note).toContain("No commit for the prerequisite was found on main");
		expect(note).not.toContain("git show");
	});

	it("omits the quoted title when the prerequisite card has none", () => {
		const withCommit = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			prerequisiteTitle: "   ",
			baseRef: "main",
			commitSha: COMMIT_SHA,
		});
		const withoutTitle = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			baseRef: "main",
			commitSha: COMMIT_SHA,
		});

		expect(withCommit).toContain("- This task is linked after abc12, which completed and was moved to done.");
		expect(withoutTitle).toBe(withCommit);
	});

	it("returns no note when the task id or base ref is missing", () => {
		expect(buildDependencyHandoffNote({ prerequisiteTaskId: "", baseRef: "main" })).toBe("");
		expect(buildDependencyHandoffNote({ prerequisiteTaskId: "abc12", baseRef: "  " })).toBe("");
	});

	it("keeps long titles from blowing the note's token budget", () => {
		const note = buildDependencyHandoffNote({
			prerequisiteTaskId: "abc12",
			prerequisiteTitle: "x".repeat(400),
			baseRef: "main",
			commitSha: COMMIT_SHA,
		});

		const titleLine = note.split("\n")[1] ?? "";
		expect(titleLine.length).toBeLessThan(160);
		expect(titleLine).toContain("…");
	});
});

describe("prependDependencyHandoffNote", () => {
	it("puts the note above the untouched prompt", () => {
		expect(prependDependencyHandoffNote("note", "do the thing")).toBe("note\n\ndo the thing");
	});

	it("returns the prompt unchanged when there is no note", () => {
		expect(prependDependencyHandoffNote("", "do the thing")).toBe("do the thing");
	});
});
