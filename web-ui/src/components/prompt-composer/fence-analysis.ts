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

/**
 * What pressing Enter on an opening fence line should do: either close the block
 * (inserting the closing delimiter) or step into an already-closed empty block.
 */
export interface FenceNewlinePlan {
	/** Text to insert at the caret. */
	insert: string;
	/** Caret position relative to the insertion point, after inserting. */
	caretOffset: number;
}

/**
 * The edit that keeps an auto-paired fence consistent with what the user typed.
 * `replace` is set instead of a pure insertion when the opener's delimiter grew
 * or shrank, so the closing delimiter has to be rewritten to stay valid.
 */
export interface FencePairEdit {
	/** Text appended immediately after the typed fence character. */
	insert: string;
	/** Caret position relative to the end of the typed character, after the edit. */
	caretOffset: number;
	/** Closing fence to rewrite in the same transaction. */
	replace?: { from: number; to: number; insert: string };
}

/** The auto-paired shape: an opening delimiter, a blank line, then a delimiter. */
export interface FencePairClose {
	/** Line index of the closing delimiter. */
	lineIndex: number;
	/** Offset of the first character of the closing delimiter line. */
	from: number;
	/** Offset of the end of the closing delimiter line. */
	to: number;
	delimiter: FenceDelimiter;
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

export function findLineIndex(lines: readonly FenceLineRange[], position: number): number {
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
 * The closing delimiter that pairs with the opener on `openerLineIndex`, when the
 * line right after the opener is still blank. That is the exact shape the editor
 * inserts when it auto-pairs a fence, and the shape the caret enters on Enter.
 */
export function findPairedClosingFence(text: string, openerLineIndex: number): FencePairClose | null {
	const lines = splitLineRanges(text);
	const content = lines[openerLineIndex + 1];
	const closer = lines[openerLineIndex + 2];
	if (!content || !closer || content.text.trim().length > 0) {
		return null;
	}
	const openerDelimiter = parseFenceDelimiter(lines[openerLineIndex]?.text ?? "");
	const closerDelimiter = parseFenceDelimiter(closer.text);
	if (!openerDelimiter || !closerDelimiter) {
		return null;
	}
	if (closerDelimiter.char !== openerDelimiter.char || closerDelimiter.info.trim().length > 0) {
		return null;
	}
	return { lineIndex: openerLineIndex + 2, from: closer.start, to: closer.end, delimiter: closerDelimiter };
}

/** Index of the line that closes the fence opened at `openerLineIndex`, if any. */
export function findClosingLineIndex(states: readonly FenceLineState[], openerLineIndex: number): number | null {
	for (let index = openerLineIndex + 1; index < states.length; index += 1) {
		if (states[index]?.isClosingMarker) {
			return index;
		}
	}
	return null;
}

/**
 * What Enter on an opening fence line should do.
 *
 * - An unmatched opener still gets its closing delimiter plus a blank content line.
 * - An opener that already has a blank content line and its closing delimiter (the
 *   auto-paired shape) only has to move the caret into the block.
 * - An opener whose block already holds code falls through to a plain newline.
 */
export function planFenceNewline(text: string, position: number): FenceNewlinePlan | null {
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
	const states = analyzeFenceLines(text);
	if (!states[lineIndex]?.isOpeningMarker) {
		return null;
	}
	const closingIndex = findClosingLineIndex(states, lineIndex);
	if (closingIndex === null) {
		const closing = delimiter.char.repeat(delimiter.length);
		return { insert: `\n\n${closing}\n`, caretOffset: 1 };
	}
	const hasContent = lines.slice(lineIndex + 1, closingIndex).some((entry) => entry.text.trim().length > 0);
	return hasContent ? null : { insert: "", caretOffset: 1 };
}

/**
 * After a fence character was typed, decide whether the editor should also pair
 * (or re-size) the closing delimiter.
 *
 * `text` is the document *including* the typed characters, `typedFrom` is where
 * they landed and `typedLength` how many there were. A pair is only created when
 * that keystroke is what turned the line into a delimiter, so typing a backtick
 * inside an existing fence (which closes it) never spawns a second one.
 */
export function computeFenceAutoPair(text: string, typedFrom: number, typedLength: number): FencePairEdit | null {
	const lines = splitLineRanges(text);
	const caret = typedFrom + typedLength;
	const lineIndex = findLineIndex(lines, caret);
	const line = lines[lineIndex];
	if (!line || caret !== line.end) {
		return null;
	}
	const after = parseFenceDelimiter(line.text);
	if (!after) {
		return null;
	}
	const offsetInLine = typedFrom - line.start;
	const beforeText = line.text.slice(0, offsetInLine) + line.text.slice(offsetInLine + typedLength);
	const before = parseFenceDelimiter(beforeText);
	const state = analyzeFenceLines(text)[lineIndex];
	if (!state?.isOpeningMarker) {
		return null;
	}
	const paired = findPairedClosingFence(text, lineIndex);
	const marker = after.char.repeat(after.length);
	if (!before) {
		// The typed run completed the opening delimiter: pair it immediately.
		return paired ? null : { insert: `\n\n${marker}\n`, caretOffset: 0 };
	}
	if (paired && paired.delimiter.length !== after.length) {
		// The opener's run grew or shrank: keep the paired closer the same length.
		return { insert: "", caretOffset: 0, replace: { from: paired.from, to: paired.to, insert: marker } };
	}
	return null;
}

/**
 * Backspace at the end of an opener's delimiter must keep the auto-paired closer
 * in step: shorten it, and drop the whole pair once the opener stops being a
 * fence (an orphan closing delimiter would restyle the rest of the draft).
 */
export function computeFencePairBackspaceChange(
	text: string,
	position: number,
): { from: number; to: number; insert: string } | null {
	const lines = splitLineRanges(text);
	const lineIndex = findLineIndex(lines, position);
	const line = lines[lineIndex];
	if (!line || position !== line.end) {
		return null;
	}
	const delimiter = parseFenceDelimiter(line.text);
	if (!delimiter || delimiter.info.length > 0) {
		return null;
	}
	if (!analyzeFenceLines(text)[lineIndex]?.isOpeningMarker) {
		return null;
	}
	const paired = findPairedClosingFence(text, lineIndex);
	if (!paired) {
		return null;
	}
	const nextLength = delimiter.length - 1;
	if (nextLength >= 3) {
		return { from: paired.from, to: paired.to, insert: delimiter.char.repeat(nextLength) };
	}
	return { from: line.end, to: paired.to, insert: "" };
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
