import type { EditorState, Range } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";

import {
	analyzeFenceLines,
	type FenceLineState,
	parseFenceDelimiter,
	splitLineRanges,
} from "@/components/prompt-composer/fence-analysis";
import { findInlineCodeSpans } from "@/components/prompt-composer/inline-code-analysis";

/**
 * Live-preview decorations for the prompt composer.
 *
 * Fenced blocks render as a bordered panel: the delimiter rows collapse into thin
 * caps (`cm-code-cap`) and the fence language, when there is one, stays visible as
 * a label in the top cap. Inline code is marked (`cm-inline-code`) with its
 * backticks hidden.
 *
 * An opening delimiter stays collapsed even while the caret sits on its row: the
 * auto-pair leaves the caret right after the ``` so the info string can be typed,
 * and revealing the row there would put the backticks straight back on screen.
 * Selecting part of the delimiter (`isDelimiterRevealed`) reveals it for editing.
 * A collapsed opener doubles as the panel's header strip (CSS keeps that cap at a
 * readable line height), so the info string and the caret always have somewhere to
 * live. Everything else is revealed for whatever the selection touches, so the
 * user can still reach the syntax. That is also why this rebuilds on `selectionSet`
 * and not just `docChanged`.
 *
 * Note: the collapsed rows are CSS-thin normal lines, not block replacements.
 * CodeMirror forbids plugins from providing block decorations ("Block decorations
 * may not be specified via plugins"), and a block decoration would be needed to
 * actually remove the row from the layout.
 */

interface FenceBlock {
	opener: number;
	closer: number | null;
}

const lineDecorationCache = new Map<string, Decoration>();
const hiddenText = Decoration.replace({});
const inlineCodeMark = Decoration.mark({ class: "cm-inline-code" });

function lineDecoration(classes: string): Decoration {
	let decoration = lineDecorationCache.get(classes);
	if (!decoration) {
		decoration = Decoration.line({ class: classes });
		lineDecorationCache.set(classes, decoration);
	}
	return decoration;
}

/** True when any selection range touches `[from, to]`, i.e. the syntax is being edited. */
function isRevealed(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/**
 * True when the syntax in `[from, to]` is being edited, for delimiters that should
 * stay hidden while the caret merely sits on their row.
 *
 * A non-empty selection reveals the delimiters as soon as it covers part of them.
 * An empty caret only counts while it is *inside* the run. That is what keeps a
 * fenced block collapsed the moment it is typed: the auto-pair leaves the caret
 * right after the opening delimiter (position `to`), so treating that boundary as
 * "touching" would pop the three backticks straight back into view.
 */
function isDelimiterRevealed(state: EditorState, from: number, to: number): boolean {
	return state.selection.ranges.some((range) =>
		range.empty ? range.head >= from && range.head < to : range.from < to && range.to > from,
	);
}

function collectFenceBlocks(states: readonly FenceLineState[]): FenceBlock[] {
	const blocks: FenceBlock[] = [];
	for (let index = 0; index < states.length; index += 1) {
		if (!states[index]?.isOpeningMarker) {
			continue;
		}
		let closer: number | null = null;
		for (let cursor = index + 1; cursor < states.length; cursor += 1) {
			if (states[cursor]?.isClosingMarker) {
				closer = cursor;
				break;
			}
		}
		blocks.push({ opener: index, closer });
	}
	return blocks;
}

export function buildMarkdownDecorations(view: EditorView): DecorationSet {
	const state = view.state;
	const text = state.doc.toString();
	const lines = splitLineRanges(text);
	const fenceStates = analyzeFenceLines(text);
	const decorations: Range<Decoration>[] = [];

	for (const block of collectFenceBlocks(fenceStates)) {
		// An unclosed fence runs to the end of the draft, so its last line closes the box.
		const bottom = block.closer ?? lines.length - 1;
		for (let index = block.opener; index <= bottom; index += 1) {
			const line = lines[index];
			const fenceState = fenceStates[index];
			if (!line || !fenceState) {
				continue;
			}
			const classes = ["cm-code-block"];
			if (index === block.opener) {
				classes.push("cm-code-block-top");
			}
			if (index === bottom) {
				classes.push("cm-code-block-bottom");
			}
			if (!fenceState.isFenceMarker) {
				classes.push("cm-code-line");
				decorations.push(lineDecoration(classes.join(" ")).range(line.start));
				continue;
			}
			const delimiter = parseFenceDelimiter(line.text);
			if (!delimiter) {
				classes.push("cm-code-fence");
				decorations.push(lineDecoration(classes.join(" ")).range(line.start));
				continue;
			}
			// Everything before the info string is the delimiter run (plus any
			// indentation); the info string itself stays visible as a label.
			const hiddenTo = fenceState.isOpeningMarker ? line.end - delimiter.info.length : line.end;
			const revealed = fenceState.isOpeningMarker
				? isDelimiterRevealed(state, line.start, hiddenTo)
				: isRevealed(state, line.start, line.end);
			if (revealed) {
				classes.push("cm-code-fence");
				decorations.push(lineDecoration(classes.join(" ")).range(line.start));
				continue;
			}
			classes.push("cm-code-cap");
			const info = fenceState.isOpeningMarker ? delimiter.info.trim() : "";
			if (info.length > 0) {
				classes.push("cm-code-cap-labeled");
			}
			decorations.push(lineDecoration(classes.join(" ")).range(line.start));
			if (hiddenTo > line.start) {
				decorations.push(hiddenText.range(line.start, hiddenTo));
			}
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line || fenceStates[index]?.inFence) {
			continue;
		}
		for (const span of findInlineCodeSpans(line.text, line.start)) {
			decorations.push(inlineCodeMark.range(span.contentFrom, span.contentTo));
			if (isRevealed(state, span.from, span.to)) {
				continue;
			}
			decorations.push(hiddenText.range(span.from, span.contentFrom));
			decorations.push(hiddenText.range(span.contentTo, span.to));
		}
	}

	return Decoration.set(decorations, true);
}

export const markdownHighlighting = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildMarkdownDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.selectionSet || update.viewportChanged) {
				this.decorations = buildMarkdownDecorations(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);
