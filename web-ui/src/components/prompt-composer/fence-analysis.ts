/**
 * Fenced code block analysis for the prompt composer.
 *
 * The composer is a plain markdown-ish text field, so we only need to know two
 * things about the text: which lines belong to a fenced code block (so they can
 * be styled as a block and opt out of word wrapping), and where the caret should
 * move when the user leaves a block with the arrow keys.
 *
 * This deliberately implements the small, well-defined subset of CommonMark that
 * matters here (backtick and tilde fences, up to three leading spaces, matching
 * closing delimiter of at least the opening length) rather than pulling in a full
 * markdown parser.
 */

export interface FenceLineState {
	/** The line is a fence delimiter (opening or closing). */
	isFenceMarker: boolean;
	/** The line opens a fenced code block. */
	isOpeningMarker: boolean;
	/** The line closes a fenced code block. */
	isClosingMarker: boolean;
	/** The line belongs to a fenced code block, delimiters included. */
	inFence: boolean;
}

export interface FenceDelimiter {
	char: "`" | "~";
	length: number;
	info: string;
}

export interface FenceLineRange {
	/** Offset of the first character of the line. */
	start: number;
	/** Offset of the newline that ends the line, or the end of the text. */
	end: number;
	text: string;
}

export interface FenceAutoCloseEdit {
	/** Text to insert at the caret. */
	insert: string;
	/** Caret position relative to the insertion point, after inserting. */
	caretOffset: number;
}

export interface FenceNavigationTarget {
	/** Caret position to move to. */
	target: number;
	/** Text to insert at the end of the document before moving, if any. */
	insert: string;
}

const NOT_IN_FENCE: FenceLineState = {
	isFenceMarker: false,
	isOpeningMarker: false,
	isClosingMarker: false,
	inFence: false,
};

const FENCE_DELIMITER_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function parseFenceDelimiter(line: string): FenceDelimiter | null {
	const match = FENCE_DELIMITER_PATTERN.exec(line);
	if (!match) {
		return null;
	}
	const marker = match[1];
	if (!marker) {
		return null;
	}
	const char = marker[0] === "~" ? "~" : "`";
	const info = match[2] ?? "";
	// A backtick fence's info string may not contain backticks, otherwise the
	// line is ordinary inline code (or a closing fence for something else).
	if (char === "`" && info.includes("`")) {
		return null;
	}
	return { char, length: marker.length, info };
}

export function splitLineRanges(text: string): FenceLineRange[] {
	const ranges: FenceLineRange[] = [];
	let start = 0;
	while (start <= text.length) {
		const newlineIndex = text.indexOf("\n", start);
		const end = newlineIndex === -1 ? text.length : newlineIndex;
		ranges.push({ start, end, text: text.slice(start, end) });
		if (newlineIndex === -1) {
			break;
		}
		start = newlineIndex + 1;
	}
	return ranges;
}

export function analyzeFenceLines(text: string): FenceLineState[] {
	const lines = text.split("\n");
	const states: FenceLineState[] = [];
	let openFence: FenceDelimiter | null = null;

	for (const line of lines) {
		const delimiter = parseFenceDelimiter(line);
		if (openFence) {
			const closesFence =
				delimiter !== null &&
				delimiter.char === openFence.char &&
				delimiter.length >= openFence.length &&
				delimiter.info.trim().length === 0;
			if (closesFence) {
				states.push({ isFenceMarker: true, isOpeningMarker: false, isClosingMarker: true, inFence: true });
				openFence = null;
			} else {
				states.push({ ...NOT_IN_FENCE, inFence: true });
			}
			continue;
		}
		if (delimiter) {
			states.push({ isFenceMarker: true, isOpeningMarker: true, isClosingMarker: false, inFence: true });
			openFence = delimiter;
			continue;
		}
		states.push({ ...NOT_IN_FENCE });
	}

	return states;
}

function findLineIndex(lines: readonly FenceLineRange[], position: number): number {
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line && position <= line.end) {
			return index;
		}
	}
	return Math.max(0, lines.length - 1);
}

/**
 * A caret at the very end of a document without a trailing newline sits one past
 * the last line's end, which would otherwise look like "not on any line".
 */
function normalizeCaretPosition(text: string, lines: readonly FenceLineRange[], position: number): number {
	const clamped = Math.max(0, Math.min(position, text.length));
	const lastLine = lines[lines.length - 1];
	if (lastLine && clamped >= lastLine.end) {
		return lastLine.end;
	}
	return clamped;
}

/**
 * When the caret sits at the end of an unmatched fence opener, return the edit
 * that closes the block and leaves an empty line for its contents.
 */
export function computeFenceAutoClose(text: string, position: number): FenceAutoCloseEdit | null {
	const lines = splitLineRanges(text);
	const caret = normalizeCaretPosition(text, lines, position);
	const lineIndex = findLineIndex(lines, caret);
	const line = lines[lineIndex];
	if (!line || caret !== line.end) {
		return null;
	}
	const delimiter = parseFenceDelimiter(line.text);
	if (!delimiter) {
		return null;
	}
	const state = analyzeFenceLines(text)[lineIndex];
	if (!state?.isOpeningMarker) {
		return null;
	}
	const closing = delimiter.char.repeat(delimiter.length);
	return { insert: `\n\n${closing}\n`, caretOffset: 1 };
}

/**
 * ArrowDown from an empty line inside a fence (or from the closing fence) leaves
 * the block instead of walking through it. ArrowUp mirrors that movement.
 */
export function findFenceNavigationTarget(
	text: string,
	position: number,
	direction: "down" | "up",
): FenceNavigationTarget | null {
	const lines = splitLineRanges(text);
	const caret = normalizeCaretPosition(text, lines, position);
	const lineIndex = findLineIndex(lines, caret);
	const line = lines[lineIndex];
	if (!line) {
		return null;
	}
	const states = analyzeFenceLines(text);
	const state = states[lineIndex];

	if (direction === "down") {
		if (caret !== line.end || !state?.inFence) {
			return null;
		}
		const closingIndex = states.findIndex((entry, index) => index >= lineIndex && entry.isClosingMarker);
		if (closingIndex === -1) {
			return null;
		}
		// Leaving from the closing fence itself, or from an empty line right above it.
		const leavingFromClosingFence = lineIndex === closingIndex;
		const leavingFromEmptyLineAbove = lineIndex === closingIndex - 1 && line.text.trim().length === 0;
		if (!leavingFromClosingFence && !leavingFromEmptyLineAbove) {
			return null;
		}
		const nextLine = lines[closingIndex + 1];
		if (nextLine) {
			return { target: nextLine.start, insert: "" };
		}
		return { target: text.length + 1, insert: "\n" };
	}

	if (caret !== line.start) {
		return null;
	}
	const closingIndex = states.findIndex((entry, index) => index === lineIndex - 1 && entry.isClosingMarker);
	if (closingIndex === -1) {
		return null;
	}
	const lastContentLine = lines[closingIndex - 1];
	if (!lastContentLine) {
		return null;
	}
	return { target: lastContentLine.end, insert: "" };
}
