/**
 * Inline code analysis for the prompt composer.
 *
 * Like `fence-analysis.ts`, this implements only the subset of CommonMark the
 * composer needs: a run of backticks closes on the next run of exactly the same
 * length, and spans are line-local (a span never crosses a newline). Callers skip
 * lines that belong to a fenced block, where backticks are code and not markers.
 */

import { findLineIndex, splitLineRanges } from "@/components/prompt-composer/fence-analysis";

export interface InlineCodeSpan {
	/** Offset of the opening backtick run. */
	from: number;
	/** Offset just past the closing backtick run. */
	to: number;
	/** Offset of the first content character. */
	contentFrom: number;
	/** Offset just past the last content character. */
	contentTo: number;
	/** Length of the opening and closing backtick runs. */
	delimiterLength: number;
}

/** A single text change, shaped so `EditorView.dispatch({ changes })` accepts it. */
export interface MarkdownTextChange {
	from: number;
	to: number;
	insert: string;
}

/** A replacement plus the selection that should follow it. */
export interface MarkdownWrapEdit {
	changes: MarkdownTextChange[];
	selection: { anchor: number; head: number };
}

function countRun(line: string, index: number): number {
	let end = index;
	while (line[end] === "`") {
		end += 1;
	}
	return end - index;
}

/**
 * Inline code spans on a single line. `lineStart` is the offset of the line's
 * first character, so spans come back in document offsets.
 *
 * Empty content (`` `` ``) is deliberately not a span: hiding both delimiters
 * would make the characters the user just typed disappear.
 */
export function findInlineCodeSpans(line: string, lineStart = 0): InlineCodeSpan[] {
	const spans: InlineCodeSpan[] = [];
	let index = 0;
	while (index < line.length) {
		if (line[index] !== "`") {
			index += 1;
			continue;
		}
		const openLength = countRun(line, index);
		let search = index + openLength;
		let closeAt: number | null = null;
		while (search < line.length) {
			if (line[search] !== "`") {
				search += 1;
				continue;
			}
			const closeLength = countRun(line, search);
			if (closeLength === openLength) {
				closeAt = search;
				break;
			}
			search += closeLength;
		}
		if (closeAt === null) {
			index += openLength;
			continue;
		}
		const contentFrom = index + openLength;
		if (closeAt > contentFrom) {
			spans.push({
				from: lineStart + index,
				to: lineStart + closeAt + openLength,
				contentFrom: lineStart + contentFrom,
				contentTo: lineStart + closeAt,
				delimiterLength: openLength,
			});
		}
		index = closeAt + openLength;
	}
	return spans;
}

/**
 * What pressing the backtick key over a selection should do.
 *
 * A single-line selection gets inline code. A multi-line selection cannot be an
 * inline span, so it is wrapped in a fenced block covering the selected lines,
 * which is the markdown that means "this block is code".
 */
export function buildBacktickWrapEdit(text: string, from: number, to: number): MarkdownWrapEdit | null {
	if (to <= from) {
		return null;
	}
	const selected = text.slice(from, to);
	if (!selected.includes("\n")) {
		return {
			changes: [{ from, to, insert: `\`${selected}\`` }],
			selection: { anchor: from + 1, head: to + 1 },
		};
	}
	const lines = splitLineRanges(text);
	// A selection that ends on a line start belongs to the line above it.
	const lastOffset = text[to - 1] === "\n" ? to - 1 : to;
	const first = lines[findLineIndex(lines, from)];
	const last = lines[findLineIndex(lines, lastOffset)];
	if (!first || !last || last.end < first.start) {
		return null;
	}
	const fence = "```";
	return {
		changes: [
			{ from: first.start, to: first.start, insert: `${fence}\n` },
			{ from: last.end, to: last.end, insert: `\n${fence}` },
		],
		selection: { anchor: from + fence.length + 1, head: to + fence.length + 1 },
	};
}
