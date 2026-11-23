import { EditorView } from "@codemirror/view";
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { applyComposerTextInput, PromptCodeEditor } from "@/components/prompt-composer/prompt-code-editor";

interface HarnessState {
	value: string;
	cursors: number[];
}

function EditorHarness({
	initialValue = "",
	onChange,
	disabled,
	onKeyDown,
	placeholder = "Describe the task",
	records,
}: {
	initialValue?: string;
	onChange?: (value: string) => void;
	disabled?: boolean;
	onKeyDown?: (event: KeyboardEvent, view: EditorView) => boolean;
	placeholder?: string;
	records: HarnessState;
}): ReactElement {
	const [value, setValue] = React.useState(initialValue);
	return (
		<PromptCodeEditor
			value={value}
			ariaLabel="Prompt"
			placeholder={placeholder}
			disabled={disabled}
			onKeyDown={onKeyDown}
			onChange={(next) => {
				records.value = next;
				onChange?.(next);
				setValue(next);
			}}
			onSelectionChange={(cursor) => {
				records.cursors.push(cursor);
			}}
		/>
	);
}

const KEY_CODES: Record<string, number> = { Enter: 13, Backspace: 8, ArrowUp: 38, ArrowDown: 40, Escape: 27 };

describe("PromptCodeEditor", () => {
	let container: HTMLDivElement;
	let root: Root;
	let records: HarnessState;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		records = { value: "", cursors: [] };
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	function render(panel: ReactElement): void {
		act(() => {
			root.render(panel);
		});
	}

	function view(): EditorView {
		const editor = container.querySelector<HTMLElement>(".cm-editor");
		if (!editor) {
			throw new Error("Expected a CodeMirror editor");
		}
		const found = EditorView.findFromDOM(editor);
		if (!found) {
			throw new Error("Expected an attached EditorView");
		}
		return found;
	}

	function type(text: string): void {
		act(() => {
			const current = view();
			current.dispatch({
				changes: { from: 0, to: current.state.doc.length, insert: text },
				selection: { anchor: text.length },
			});
		});
	}

	function press(key: string, init: KeyboardEventInit = {}): void {
		const content = container.querySelector(".cm-content");
		if (!content) {
			throw new Error("Expected editor content");
		}
		act(() => {
			content.dispatchEvent(
				new KeyboardEvent("keydown", {
					key,
					keyCode: KEY_CODES[key] ?? 0,
					bubbles: true,
					cancelable: true,
					...init,
				}),
			);
		});
	}

	it("renders a placeholder and reports edits", () => {
		render(<EditorHarness records={records} />);
		expect(container.textContent).toContain("Describe the task");

		act(() => {
			const current = view();
			current.dispatch({ changes: { from: 0, insert: "hello" }, selection: { anchor: 5 } });
		});

		expect(records.value).toBe("hello");
		expect(view().state.doc.toString()).toBe("hello");
		expect(container.textContent).not.toContain("Describe the task");
	});

	it("accepts value changes pushed from the parent", () => {
		render(<EditorHarness records={records} initialValue="first" />);
		expect(view().state.doc.toString()).toBe("first");

		act(() => {
			root.render(
				<div>
					<PromptCodeEditor value="second" ariaLabel="Prompt" onChange={() => {}} />
				</div>,
			);
		});

		expect(view().state.doc.toString()).toBe("second");
	});

	it("closes a fence when the opener is followed by a newline", () => {
		render(<EditorHarness records={records} />);
		type("```");

		press("Enter", { shiftKey: true });

		expect(view().state.doc.toString()).toBe("```\n\n```\n");
		// The caret lands on the empty line inside the block.
		expect(view().state.selection.main.head).toBe(4);
	});

	it("keeps the fence language and delimiter length", () => {
		render(<EditorHarness records={records} />);
		type("````ts");
		press("Enter", { shiftKey: true });
		expect(view().state.doc.toString()).toBe("````ts\n\n````\n");
	});

	it("inserts a plain newline when the line does not open a fence", () => {
		render(<EditorHarness records={records} />);
		type("hello");
		press("Enter", { shiftKey: true });
		expect(view().state.doc.toString()).toBe("hello\n");
	});

	it("renders a fenced block as a panel with the delimiters hidden", () => {
		render(<EditorHarness records={records} initialValue={"before\n```ts\nconst a = 1;\n```\nafter"} />);

		// Both delimiter rows collapse into caps; the code row carries the panel edges.
		expect(container.querySelectorAll(".cm-code-cap").length).toBe(2);
		expect(container.querySelectorAll(".cm-code-line").length).toBe(1);
		expect(container.querySelectorAll(".cm-code-block-top").length).toBe(1);
		expect(container.querySelectorAll(".cm-code-block-bottom").length).toBe(1);
		expect(container.querySelector(".cm-code-fence")).toBeNull();
		// The fence language stays visible as the top cap's label.
		expect(container.querySelectorAll(".cm-code-cap-labeled").length).toBe(1);
		expect(container.textContent).toContain("const a = 1;");
		expect(container.textContent).toContain("ts");
		expect(container.textContent).not.toContain("```");
	});

	it("reveals the delimiters when the selection touches the fence", () => {
		render(<EditorHarness records={records} initialValue={"before\n```ts\nconst a = 1;\n```\nafter"} />);
		const openerStart = "before\n".length;

		act(() => {
			view().dispatch({ selection: { anchor: openerStart } });
		});

		expect(container.querySelectorAll(".cm-code-fence").length).toBe(1);
		expect(container.querySelectorAll(".cm-code-cap").length).toBe(1);
		expect(container.textContent).toContain("```ts");
	});

	it("styles inline code and hides its backticks", () => {
		render(<EditorHarness records={records} initialValue="use `foo` here" />);

		expect(container.querySelectorAll(".cm-inline-code").length).toBe(1);
		expect(container.textContent).toContain("use foo here");
		expect(container.textContent).not.toContain("`");
	});

	it("reveals inline code backticks while the caret is inside the span", () => {
		render(<EditorHarness records={records} initialValue="use `foo` here" />);

		act(() => {
			view().dispatch({ selection: { anchor: 6 } });
		});

		expect(container.textContent).toContain("`foo`");
	});

	it("pairs a fence as soon as the third backtick is typed", () => {
		render(<EditorHarness records={records} />);
		type("``");

		act(() => {
			const current = view();
			const caret = current.state.selection.main.head;
			applyComposerTextInput(current, caret, caret, "`");
		});

		expect(view().state.doc.toString()).toBe("```\n\n```\n");
		// The caret stays after the opener so a language can still be typed.
		expect(view().state.selection.main.head).toBe(3);
		expect(records.value).toBe("```\n\n```\n");
	});

	it("wraps a selection in inline code when a backtick is typed", () => {
		render(<EditorHarness records={records} initialValue="hello world" />);
		act(() => {
			view().dispatch({ selection: { anchor: 6, head: 11 } });
		});

		act(() => {
			applyComposerTextInput(view(), 6, 11, "`");
		});

		expect(view().state.doc.toString()).toBe("hello `world`");
		const selection = view().state.selection.main;
		expect(view().state.sliceDoc(selection.from, selection.to)).toBe("world");
	});

	it("wraps a multi-line selection in a fenced block", () => {
		render(<EditorHarness records={records} initialValue={"a\nb\nc"} />);
		act(() => {
			view().dispatch({ selection: { anchor: 0, head: 3 } });
		});

		act(() => {
			applyComposerTextInput(view(), 0, 3, "`");
		});

		expect(view().state.doc.toString()).toBe("```\na\nb\n```\nc");
	});

	it("steps into an auto-paired block on Enter instead of adding a closer", () => {
		render(<EditorHarness records={records} initialValue={"```\n\n```\n"} />);
		act(() => {
			view().dispatch({ selection: { anchor: 3 } });
		});

		press("Enter");

		expect(view().state.doc.toString()).toBe("```\n\n```\n");
		expect(view().state.selection.main.head).toBe(4);
	});

	it("drops an auto-paired block when backspace removes the last delimiter character", () => {
		render(<EditorHarness records={records} initialValue={"```\n\n```\n"} />);
		act(() => {
			view().dispatch({ selection: { anchor: 3 } });
		});

		press("Backspace");

		expect(view().state.doc.toString()).toBe("``\n");
		expect(view().state.selection.main.head).toBe(2);
	});

	it("leaves the block on arrow down from the empty content line", () => {
		render(<EditorHarness records={records} />);
		type("```");
		press("Enter", { shiftKey: true });
		expect(view().state.selection.main.head).toBe(4);

		press("ArrowDown");

		// Position just past the closing fence, on the trailing empty line.
		expect(view().state.selection.main.head).toBe(9);
	});

	it("re-enters the block on arrow up from below the closing fence", () => {
		render(<EditorHarness records={records} initialValue={"```\nconst a = 1;\n```\nafter"} />);
		const text = "```\nconst a = 1;\n```\nafter";
		act(() => {
			view().dispatch({ selection: { anchor: text.indexOf("after") } });
		});

		press("ArrowUp");

		expect(view().state.selection.main.head).toBe(text.indexOf("const a = 1;") + "const a = 1;".length);
	});

	it("lets the host claim a key before the editor acts on it", () => {
		const onKeyDown = vi.fn(() => true);
		render(<EditorHarness records={records} onKeyDown={onKeyDown} />);
		type("send me");

		press("Enter");

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(view().state.doc.toString()).toBe("send me");
	});

	it("falls through to the newline keymap when the host declines a key", () => {
		const onKeyDown = vi.fn(() => false);
		render(<EditorHarness records={records} onKeyDown={onKeyDown} />);
		type("line");

		press("Enter");

		expect(onKeyDown).toHaveBeenCalledTimes(1);
		expect(view().state.doc.toString()).toBe("line\n");
	});
});
