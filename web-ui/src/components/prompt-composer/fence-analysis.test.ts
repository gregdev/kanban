import { describe, expect, it } from "vitest";

import {
	analyzeFenceLines,
	computeFenceAutoPair,
	computeFencePairBackspaceChange,
	findFenceNavigationTarget,
	planFenceNewline,
	parseFenceDelimiter,
	splitLineRanges,
} from "@/components/prompt-composer/fence-analysis";

describe("parseFenceDelimiter", () => {
	it("recognises backtick and tilde fences", () => {
		expect(parseFenceDelimiter("```")).toEqual({ char: "`", length: 3, info: "" });
		expect(parseFenceDelimiter("```ts")).toEqual({ char: "`", length: 3, info: "ts" });
		expect(parseFenceDelimiter("``` ts")).toEqual({ char: "`", length: 3, info: " ts" });
		expect(parseFenceDelimiter("`````")).toEqual({ char: "`", length: 5, info: "" });
		expect(parseFenceDelimiter("~~~js")).toEqual({ char: "~", length: 3, info: "js" });
	});

	it("allows up to three leading spaces only", () => {
		expect(parseFenceDelimiter("   ```")).not.toBeNull();
		expect(parseFenceDelimiter("    ```")).toBeNull();
	});

	it("rejects short runs, prose and backticks in a backtick info string", () => {
		expect(parseFenceDelimiter("``")).toBeNull();
		expect(parseFenceDelimiter("plain text")).toBeNull();
		expect(parseFenceDelimiter("```a`b")).toBeNull();
	});
});

describe("splitLineRanges", () => {
	it("keeps a trailing empty line after a final newline", () => {
		expect(splitLineRanges("a\nb\n")).toEqual([
			{ start: 0, end: 1, text: "a" },
			{ start: 2, end: 3, text: "b" },
			{ start: 4, end: 4, text: "" },
		]);
	});

	it("handles empty and single-line text", () => {
		expect(splitLineRanges("")).toEqual([{ start: 0, end: 0, text: "" }]);
		expect(splitLineRanges("only")).toEqual([{ start: 0, end: 4, text: "only" }]);
	});
});

describe("analyzeFenceLines", () => {
	it("marks delimiters and the lines between them", () => {
		const states = analyzeFenceLines("before\n```ts\nconst a = 1;\n```\nafter");
		expect(states.map((state) => state.inFence)).toEqual([false, true, true, true, false]);
		expect(states.map((state) => state.isOpeningMarker)).toEqual([false, true, false, false, false]);
		expect(states.map((state) => state.isClosingMarker)).toEqual([false, false, false, true, false]);
	});

	it("treats an unclosed fence as running to the end of the text", () => {
		const states = analyzeFenceLines("```\nstill code\nmore code");
		expect(states.map((state) => state.inFence)).toEqual([true, true, true]);
		expect(states[1]?.isClosingMarker).toBe(false);
	});

	it("requires the closing fence to be at least as long as the opener", () => {
		const short = analyzeFenceLines("````\ncode\n```\nstill code");
		expect(short.map((state) => state.isClosingMarker)).toEqual([false, false, false, false]);
		expect(short[3]?.inFence).toBe(true);

		const long = analyzeFenceLines("```\ncode\n````\nafter");
		expect(long.map((state) => state.isClosingMarker)).toEqual([false, false, true, false]);
	});

	it("ignores a delimiter with a different fence character and pins the pair", () => {
		const states = analyzeFenceLines("```\n~~~\n```");
		expect(states.map((state) => state.isClosingMarker)).toEqual([false, false, true]);
	});
});

describe("planFenceNewline", () => {
	it("closes an untouched opener and parks the caret on the content line", () => {
		const plan = planFenceNewline("```", 3);
		expect(plan).toEqual({ insert: "\n\n```\n", caretOffset: 1 });
	});

	it("preserves the fence length and character", () => {
		expect(planFenceNewline("~~~py", 5)?.insert).toBe("\n\n~~~\n");
		expect(planFenceNewline("````", 4)?.insert).toBe("\n\n````\n");
	});

	it("does nothing away from the end of the line", () => {
		expect(planFenceNewline("```", 2)).toBeNull();
	});

	it("does nothing on prose or on a closing fence", () => {
		expect(planFenceNewline("hello", 5)).toBeNull();
		expect(planFenceNewline("```\ncode\n```", 10)).toBeNull();
	});

	it("only closes the opener, not a second fence inside an open block", () => {
		expect(planFenceNewline("```\ncode\n```\ntail", 8)).toBeNull();
	});

	it("steps into an auto-paired block instead of adding a second closer", () => {
		expect(planFenceNewline("```\n\n```\n", 3)).toEqual({ insert: "", caretOffset: 1 });
		expect(planFenceNewline("```ts\n\n```\n", 5)).toEqual({ insert: "", caretOffset: 1 });
	});

	it("leaves a paired block that already holds code to a plain newline", () => {
		expect(planFenceNewline("```\ncode\n```\n", 3)).toBeNull();
		expect(planFenceNewline("```ts\ncode\n```\n", 5)).toBeNull();
	});
});

describe("computeFenceAutoPair", () => {
	it("pairs a fence the keystroke just completed", () => {
		expect(computeFenceAutoPair("```", 2, 1)).toEqual({ insert: "\n\n```\n", caretOffset: 0 });
	});

	it("keeps the caret after the delimiter so an info string can follow", () => {
		// Typing ``` leaves the caret at offset 3; `ts` then becomes the info string.
		const edit = computeFenceAutoPair("```", 2, 1);
		expect(3 + (edit?.caretOffset ?? 0)).toBe(3);
	});

	it("mirrors the fence character and length", () => {
		expect(computeFenceAutoPair("~~~", 2, 1)?.insert).toBe("\n\n~~~\n");
		// A batch insert of the whole run (an IME or a synthetic edit) pairs once.
		expect(computeFenceAutoPair("````", 0, 4)?.insert).toBe("\n\n````\n");
	});

	it("allows up to three leading spaces", () => {
		expect(computeFenceAutoPair("   ```", 5, 1)?.insert).toBe("\n\n```\n");
	});

	it("ignores prose, indented code and mid-line runs", () => {
		expect(computeFenceAutoPair("foo```", 5, 1)).toBeNull();
		expect(computeFenceAutoPair("    ```", 6, 1)).toBeNull();
		expect(computeFenceAutoPair("``", 1, 1)).toBeNull();
	});

	it("does not pair a delimiter typed inside an open fence", () => {
		expect(computeFenceAutoPair("```\ncode\n```", 11, 1)).toBeNull();
	});

	it("resizes the paired closer when the opener's run grows", () => {
		expect(computeFenceAutoPair("````\n\n```\n", 3, 1)).toEqual({
			insert: "",
			caretOffset: 0,
			replace: { from: 6, to: 9, insert: "````" },
		});
	});

	it("leaves a closed block that already holds code alone", () => {
		expect(computeFenceAutoPair("````\ncode\n```\n", 3, 1)).toBeNull();
	});

	it("does not pair the same opener twice", () => {
		expect(computeFenceAutoPair("````\n\n````\n", 3, 1)).toBeNull();
	});
});

describe("computeFencePairBackspaceChange", () => {
	it("removes the pair once the opener stops being a fence", () => {
		const text = "```\n\n```\n";
		expect(computeFencePairBackspaceChange(text, 3)).toEqual({ from: 3, to: 8, insert: "" });
	});

	it("shortens the paired closer while the opener is still a fence", () => {
		const text = "````\n\n````\n";
		expect(computeFencePairBackspaceChange(text, 4)).toEqual({ from: 6, to: 10, insert: "```" });
	});

	it("ignores openers with an info string or with code in the block", () => {
		expect(computeFencePairBackspaceChange("```ts\n\n```\n", 5)).toBeNull();
		expect(computeFencePairBackspaceChange("```\ncode\n```\n", 3)).toBeNull();
	});

	it("ignores prose and the middle of a line", () => {
		expect(computeFencePairBackspaceChange("```\n\n```\n", 2)).toBeNull();
		expect(computeFencePairBackspaceChange("hello", 5)).toBeNull();
	});
});

describe("findFenceNavigationTarget", () => {
	const doc = "```\nconst a = 1;\n```\nafter";

	it("leaves the block from an empty line directly above the closing fence", () => {
		const withEmptyLine = "```\n\n```\nafter";
		// Caret at the end of the empty content line (offset 4).
		expect(findFenceNavigationTarget(withEmptyLine, 4, "down")).toEqual({ target: 9, insert: "" });
	});

	it("leaves the block from the closing fence line", () => {
		const closingStart = doc.indexOf("```", 1);
		expect(findFenceNavigationTarget(doc, closingStart + 3, "down")).toEqual({
			target: doc.length - "after".length,
			insert: "",
		});
	});

	it("inserts a trailing newline when the closing fence ends the document", () => {
		const closingOnly = "```\ncode\n```";
		expect(findFenceNavigationTarget(closingOnly, closingOnly.length, "down")).toEqual({
			target: closingOnly.length + 1,
			insert: "\n",
		});
	});

	it("stays put while walking non-empty code lines", () => {
		expect(findFenceNavigationTarget(doc, 9, "down")).toBeNull();
	});

	it("stays put outside a fence", () => {
		expect(findFenceNavigationTarget(doc, doc.length, "down")).toBeNull();
	});

	it("moves back into the block from the line below the closing fence", () => {
		const afterStart = doc.indexOf("after");
		expect(findFenceNavigationTarget(doc, afterStart, "up")).toEqual({
			target: doc.indexOf("const a = 1;") + "const a = 1;".length,
			insert: "",
		});
	});

	it("stays put on arrow up elsewhere", () => {
		expect(findFenceNavigationTarget(doc, 5, "up")).toBeNull();
	});
});
