import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import {
	type CSSProperties,
	forwardRef,
	type ReactElement,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";

import {
	computeFenceAutoPair,
	computeFencePairBackspaceChange,
	findFenceNavigationTarget,
	planFenceNewline,
} from "@/components/prompt-composer/fence-analysis";
import { buildBacktickWrapEdit } from "@/components/prompt-composer/inline-code-analysis";
import { markdownHighlighting } from "@/components/prompt-composer/markdown-decorations";
import { cn } from "@/components/ui/cn";

export interface PromptCodeEditorHandle {
	focus: () => void;
	/** Replace the whole document and place the caret at `cursor`. */
	setContent: (value: string, cursor: number) => void;
	getContent: () => string;
	getCursor: () => number;
}

export interface PromptCodeEditorProps {
	/** Current document text. The editor is controlled: render this back on change. */
	value: string;
	/** Called with the full document text whenever it changes. */
	onChange: (value: string) => void;
	/** Called with the caret offset whenever the selection or document changes. */
	onSelectionChange?: (cursorIndex: number) => void;
	/**
	 * Host key handling, consulted before the editor's own keymap. Return `true` to
	 * claim the key (the editor then prevents the default and does nothing else).
	 */
	onKeyDown?: (event: KeyboardEvent, view: EditorView) => boolean;
	/** Host paste handling, consulted before CodeMirror inserts the pasted text. */
	onPaste?: (event: ClipboardEvent, view: EditorView) => boolean;
	placeholder?: string;
	ariaLabel: string;
	disabled?: boolean;
	autoFocus?: boolean;
	className?: string;
	minHeight?: number;
	maxHeight?: number;
}

const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();

const FENCE_CHARACTERS = new Set(["`", "~"]);

/** True when `text` is a run of one fence character, e.g. "`" or "~~~". */
function isFenceRun(text: string): boolean {
	const char = text[0];
	return (
		text.length > 0 &&
		char !== undefined &&
		FENCE_CHARACTERS.has(char) &&
		text.split("").every((entry) => entry === char)
	);
}

/**
 * Typed-character policy for the composer:
 *
 * - a backtick over a selection wraps it in inline code, or in a fenced block when
 *   the selection spans lines;
 * - a fence character that completes an opening delimiter (``` or ~~~) also inserts
 *   the matching closing fence, so no Shift-Enter is needed. The caret stays after
 *   the typed delimiter, which keeps ```ts working as an info string.
 *
 * Exported so tests can exercise the policy without synthesising DOM input events.
 */
export function applyComposerTextInput(view: EditorView, from: number, to: number, text: string): boolean {
	const state = view.state;
	if (state.readOnly || !isFenceRun(text)) {
		return false;
	}
	const docText = state.doc.toString();
	if (from !== to) {
		if (text !== "`") {
			return false;
		}
		const edit = buildBacktickWrapEdit(docText, from, to);
		if (!edit) {
			return false;
		}
		view.dispatch({
			changes: edit.changes,
			selection: edit.selection,
			userEvent: "input.type",
			scrollIntoView: true,
		});
		return true;
	}
	const nextText = docText.slice(0, from) + text + docText.slice(from);
	const pair = computeFenceAutoPair(nextText, from, text.length);
	if (!pair) {
		return false;
	}
	const changes = pair.replace
		? [
				{ from, insert: text },
				{ from: pair.replace.from, to: pair.replace.to, insert: pair.replace.insert },
			]
		: [{ from, insert: text + pair.insert }];
	view.dispatch({
		changes,
		selection: { anchor: from + text.length + pair.caretOffset },
		userEvent: "input.type",
		scrollIntoView: true,
	});
	return true;
}

export const PromptCodeEditor = forwardRef<PromptCodeEditorHandle, PromptCodeEditorProps>(function PromptCodeEditor(
	{
		value,
		onChange,
		onSelectionChange,
		onKeyDown,
		onPaste,
		placeholder,
		ariaLabel,
		disabled = false,
		autoFocus = false,
		className,
		minHeight,
		maxHeight,
	}: PromptCodeEditorProps,
	ref,
): ReactElement {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);

	// Handlers are read from refs so the editor never has to be recreated when a
	// parent re-render produces new callback identities.
	const onChangeRef = useRef(onChange);
	const onSelectionChangeRef = useRef(onSelectionChange);
	const onKeyDownRef = useRef(onKeyDown);
	const onPasteRef = useRef(onPaste);

	useLayoutEffect(() => {
		onChangeRef.current = onChange;
		onSelectionChangeRef.current = onSelectionChange;
		onKeyDownRef.current = onKeyDown;
		onPasteRef.current = onPaste;
	});

	const runNewline = useCallback((view: EditorView): boolean => {
		const selection = view.state.selection;
		if (!selection.main.empty) {
			return false;
		}
		const position = selection.main.head;
		const plan = planFenceNewline(view.state.doc.toString(), position);
		if (!plan) {
			return false;
		}
		view.dispatch({
			changes: { from: position, insert: plan.insert },
			selection: { anchor: position + plan.caretOffset },
			userEvent: "input",
			scrollIntoView: true,
		});
		return true;
	}, []);

	/**
	 * Backspace on an auto-paired fence also shortens (or removes) the closing
	 * delimiter, so the block cannot be left half-open. Falls through to the default
	 * deletion everywhere else.
	 */
	const runFencePairBackspace = useCallback((view: EditorView): boolean => {
		const selection = view.state.selection;
		if (selection.ranges.length !== 1 || !selection.main.empty) {
			return false;
		}
		const position = selection.main.head;
		if (position === 0) {
			return false;
		}
		const change = computeFencePairBackspaceChange(view.state.doc.toString(), position);
		if (!change) {
			return false;
		}
		view.dispatch({
			changes: [{ from: position - 1, to: position, insert: "" }, change],
			selection: { anchor: position - 1 },
			userEvent: "delete.backward",
			scrollIntoView: true,
		});
		return true;
	}, []);

	const runFenceNavigation = useCallback((direction: "down" | "up") => {
		return (view: EditorView): boolean => {
			const selection = view.state.selection;
			if (!selection.main.empty) {
				return false;
			}
			const text = view.state.doc.toString();
			const target = findFenceNavigationTarget(text, selection.main.head, direction);
			if (!target) {
				return false;
			}
			view.dispatch({
				changes: target.insert ? { from: text.length, insert: target.insert } : undefined,
				selection: { anchor: target.target },
				scrollIntoView: true,
			});
			return true;
		};
	}, []);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) {
			return;
		}

		const state = EditorState.create({
			doc: value,
			extensions: [
				Prec.highest(
					EditorView.domEventHandlers({
						keydown: (event, view) => {
							if (view.composing || event.isComposing) {
								return false;
							}
							return onKeyDownRef.current?.(event, view) ?? false;
						},
						paste: (event, view) => onPasteRef.current?.(event, view) ?? false,
					}),
				),
				Prec.high(
					EditorView.inputHandler.of((editorView, from, to, text) => {
						if (editorView.composing) {
							return false;
						}
						return applyComposerTextInput(editorView, from, to, text);
					}),
				),
				Prec.high(
					keymap.of([
						{ key: "Enter", run: runNewline },
						{ key: "Shift-Enter", run: runNewline },
						{ key: "Backspace", run: runFencePairBackspace },
						{ key: "ArrowDown", run: runFenceNavigation("down") },
						{ key: "ArrowUp", run: runFenceNavigation("up") },
					]),
				),
				keymap.of([...historyKeymap, ...defaultKeymap]),
				history(),
				EditorView.lineWrapping,
				markdownHighlighting,
				EditorView.updateListener.of((update) => {
					if (update.docChanged) {
						onChangeRef.current(update.state.doc.toString());
					}
					if (update.docChanged || update.selectionSet) {
						onSelectionChangeRef.current?.(update.state.selection.main.head);
					}
				}),
				placeholderCompartment.of(cmPlaceholder(placeholder ?? "")),
				editableCompartment.of(createEditableExtensions(disabled, ariaLabel)),
			],
		});

		const view = new EditorView({ state, parent: host });
		viewRef.current = view;
		// Defer the initial focus by a frame: dialogs move focus into their content
		// after mount, so focusing synchronously would lose the race.
		const focusFrame = autoFocus ? window.requestAnimationFrame(() => view.focus()) : null;

		return () => {
			if (focusFrame !== null) {
				window.cancelAnimationFrame(focusFrame);
			}
			viewRef.current = null;
			view.destroy();
		};
		// The view is created once; live values are pushed through the effects below.
	}, []);

	// Push externally-driven value changes into the document without looping on the
	// change the editor itself just reported.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) {
			return;
		}
		if (view.state.doc.toString() === value) {
			return;
		}
		view.dispatch({
			changes: { from: 0, to: view.state.doc.length, insert: value },
			selection: { anchor: value.length },
		});
	}, [value]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) {
			return;
		}
		view.dispatch({
			effects: editableCompartment.reconfigure(createEditableExtensions(disabled, ariaLabel)),
		});
	}, [ariaLabel, disabled]);

	useEffect(() => {
		const view = viewRef.current;
		if (!view) {
			return;
		}
		view.dispatch({
			effects: placeholderCompartment.reconfigure(cmPlaceholder(placeholder ?? "")),
		});
	}, [placeholder]);

	useImperativeHandle(
		ref,
		() => ({
			focus: () => viewRef.current?.focus(),
			setContent: (nextValue: string, cursor: number) => {
				const view = viewRef.current;
				if (!view) {
					return;
				}
				view.dispatch({
					changes: { from: 0, to: view.state.doc.length, insert: nextValue },
					selection: { anchor: Math.max(0, Math.min(cursor, nextValue.length)) },
					userEvent: "input.complete",
					scrollIntoView: true,
				});
				view.focus();
			},
			getContent: () => viewRef.current?.state.doc.toString() ?? "",
			getCursor: () => viewRef.current?.state.selection.main.head ?? 0,
		}),
		[],
	);

	const style =
		minHeight === undefined && maxHeight === undefined
			? undefined
			: ({
					"--kb-prompt-editor-min-height": minHeight === undefined ? undefined : `${minHeight}px`,
					"--kb-prompt-editor-max-height": maxHeight === undefined ? undefined : `${maxHeight}px`,
				} as CSSProperties);

	return (
		<div
			ref={hostRef}
			className={cn("kb-prompt-editor", disabled && "kb-prompt-editor-disabled", className)}
			style={style}
		/>
	);
});

function createEditableExtensions(disabled: boolean, ariaLabel: string) {
	return [
		EditorView.editable.of(!disabled),
		EditorState.readOnly.of(disabled),
		EditorView.contentAttributes.of({
			"aria-label": ariaLabel,
			"aria-multiline": "true",
			role: "textbox",
		}),
	];
}
