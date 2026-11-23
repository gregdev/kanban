import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { Range } from "@codemirror/state";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { Decoration, EditorView, keymap, placeholder as cmPlaceholder, ViewPlugin } from "@codemirror/view";
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
	analyzeFenceLines,
	computeFenceAutoClose,
	findFenceNavigationTarget,
} from "@/components/prompt-composer/fence-analysis";
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

function buildFenceDecorations(view: EditorView): DecorationSet {
	const states = analyzeFenceLines(view.state.doc.toString());
	const decorations: Range<Decoration>[] = [];
	for (let index = 0; index < states.length; index += 1) {
		const state = states[index];
		if (!state?.inFence) {
			continue;
		}
		const line = view.state.doc.line(index + 1);
		decorations.push(
			Decoration.line({ class: state.isFenceMarker ? "cm-code-fence" : "cm-code-line" }).range(line.from),
		);
	}
	return Decoration.set(decorations, true);
}

/** Styles every line inside a fenced code block, so code is mono and never wraps. */
const fenceHighlighting = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;

		constructor(view: EditorView) {
			this.decorations = buildFenceDecorations(view);
		}

		update(update: ViewUpdate): void {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildFenceDecorations(update.view);
			}
		}
	},
	{ decorations: (plugin) => plugin.decorations },
);

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
		const autoClose = computeFenceAutoClose(view.state.doc.toString(), position);
		if (!autoClose) {
			return false;
		}
		view.dispatch({
			changes: { from: position, insert: autoClose.insert },
			selection: { anchor: position + autoClose.caretOffset },
			userEvent: "input",
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
					keymap.of([
						{ key: "Enter", run: runNewline },
						{ key: "Shift-Enter", run: runNewline },
						{ key: "ArrowDown", run: runFenceNavigation("down") },
						{ key: "ArrowUp", run: runFenceNavigation("up") },
					]),
				),
				keymap.of([...historyKeymap, ...defaultKeymap]),
				history(),
				EditorView.lineWrapping,
				fenceHighlighting,
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
