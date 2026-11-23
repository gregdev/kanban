import { describe, expect, it } from "vitest";

import {
	analyzeFenceLines,
	computeFenceAutoClose,
	findFenceNavigationTarget,
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

describe("computeFenceAutoClose", () => {
	it("closes an untouched opener and parks the caret on the content line", () => {
		const edit = computeFenceAutoClose("```", 3);
		expect(edit).toEqual({ insert: "\n\n```\n", caretOffset: 1 });
	});

	it("preserves the fence length and character", () => {
		expect(computeFenceAutoClose("~~~py", 5)?.insert).toBe("\n\n~~~\n");
		expect(computeFenceAutoClose("````", 4)?.insert).toBe("\n\n````\n");
	});

	it("does nothing away from the end of the line", () => {
		expect(computeFenceAutoClose("```", 2)).toBeNull();
	});

	it("does nothing on prose or on a closing fence", () => {
		expect(computeFenceAutoClose("hello", 5)).toBeNull();
		expect(computeFenceAutoClose("```\ncode\n```", 10)).toBeNull();
	});

	it("only closes the opener, not a second fence inside an open block", () => {
		expect(computeFenceAutoClose("```\ncode\n```\ntail", 8)).toBeNull();
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
