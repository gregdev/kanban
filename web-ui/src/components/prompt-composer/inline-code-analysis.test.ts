import { describe, expect, it } from "vitest";

import { buildBacktickWrapEdit, findInlineCodeSpans } from "@/components/prompt-composer/inline-code-analysis";

function summarize(line: string, lineStart = 0) {
	return findInlineCodeSpans(line, lineStart).map((span) => ({
		text: line.slice(span.contentFrom - lineStart, span.contentTo - lineStart),
		from: span.from,
		to: span.to,
		delimiterLength: span.delimiterLength,
	}));
}

describe("findInlineCodeSpans", () => {
	it("finds a single-backtick span", () => {
		expect(summarize("use `foo` here")).toEqual([{ text: "foo", from: 4, to: 9, delimiterLength: 1 }]);
	});

	it("finds several spans on one line", () => {
		expect(summarize("`a` and `b`").map((span) => span.text)).toEqual(["a", "b"]);
	});

	it("matches the closing run length", () => {
		expect(summarize("``a`b``")).toEqual([{ text: "a`b", from: 0, to: 7, delimiterLength: 2 }]);
		expect(summarize("``a`` and `b`").map((span) => span.text)).toEqual(["a", "b"]);
	});

	it("ignores an unmatched opener", () => {
		expect(summarize("a `b")).toEqual([]);
	});

	it("ignores a run that is closed by a different length", () => {
		expect(summarize("``a` b")).toEqual([]);
	});

	it("ignores empty content so freshly typed backticks stay visible", () => {
		expect(summarize("``")).toEqual([]);
		expect(summarize("a `` b")).toEqual([]);
	});

	it("offsets spans by the line start", () => {
		expect(summarize("`x`", 10)).toEqual([{ text: "x", from: 10, to: 13, delimiterLength: 1 }]);
	});

	it("treats a mid-line triple run as inline code", () => {
		expect(summarize("see ```code``` here").map((span) => span.text)).toEqual(["code"]);
	});
});

describe("buildBacktickWrapEdit", () => {
	it("wraps a single-line selection in inline code and keeps it selected", () => {
		const edit = buildBacktickWrapEdit("hello world", 6, 11);
		expect(edit).toEqual({
			changes: [{ from: 6, to: 11, insert: "`world`" }],
			selection: { anchor: 7, head: 12 },
		});
	});

	it("wraps a multi-line selection in a fenced block covering its lines", () => {
		const text = "a\nb\nc";
		const edit = buildBacktickWrapEdit(text, 0, 3);
		expect(edit?.changes).toEqual([
			{ from: 0, to: 0, insert: "```\n" },
			{ from: 3, to: 3, insert: "\n```" },
		]);
		expect(edit?.selection).toEqual({ anchor: 4, head: 7 });
	});

	it("fences whole lines when the selection sits inside them", () => {
		const text = "intro\nlet a = 1;\nlet b = 2;\noutro";
		const from = text.indexOf("let a");
		const to = text.indexOf("outro");
		const edit = buildBacktickWrapEdit(text, from, to);
		// The opener lands at the start of the first selected line, the closer at the
		// end of the last one that the selection touches.
		expect(edit?.changes).toEqual([
			{ from: 6, to: 6, insert: "```\n" },
			{ from: 27, to: 27, insert: "\n```" },
		]);
	});

	it("treats a selection that ends on a line start as ending on the line above", () => {
		const text = "one\ntwo\nthree";
		// Selection covers "one\ntwo" but ends at the start of "three".
		const edit = buildBacktickWrapEdit(text, 0, 8);
		expect(edit?.changes).toEqual([
			{ from: 0, to: 0, insert: "```\n" },
			{ from: 7, to: 7, insert: "\n```" },
		]);
	});

	it("does nothing without a selection", () => {
		expect(buildBacktickWrapEdit("abc", 1, 1)).toBeNull();
	});
});
