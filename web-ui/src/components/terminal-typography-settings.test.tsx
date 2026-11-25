import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TerminalTypographySettings } from "@/components/terminal-typography-settings";
import { LocalStorageKey } from "@/storage/local-storage-store";
import { getTerminalTypography, resetTerminalTypography, setTerminalFontSize } from "@/terminal/terminal-typography";

function getInput(container: HTMLElement, id: string): HTMLInputElement {
	const input = container.querySelector<HTMLInputElement>(`#${id}`);
	if (!input) {
		throw new Error(`Expected input #${id} to exist.`);
	}
	return input;
}

function getPreview(container: HTMLElement): HTMLElement {
	const preview = container.querySelector<HTMLElement>('[aria-label="Terminal typography preview"]');
	if (!preview) {
		throw new Error("Expected the typography preview to exist.");
	}
	return preview;
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === text,
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Expected a button labelled "${text}" to exist.`);
	}
	return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
	const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	valueSetter?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("TerminalTypographySettings", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
		resetTerminalTypography();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		localStorage.clear();
		resetTerminalTypography();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("shows the historical defaults", async () => {
		await act(async () => {
			root.render(<TerminalTypographySettings />);
		});

		expect(getInput(container, "terminal-font-size").value).toBe("13");
		expect(getInput(container, "terminal-line-height").value).toBe("1");
		expect(getInput(container, "terminal-letter-spacing").value).toBe("0");
		expect(findButtonByText(container, "Reset").disabled).toBe(true);
	});

	it("persists a font size change and reflects it in the preview", async () => {
		await act(async () => {
			root.render(<TerminalTypographySettings />);
		});

		await act(async () => {
			setInputValue(getInput(container, "terminal-font-size"), "16");
		});

		expect(localStorage.getItem(LocalStorageKey.TerminalFontSize)).toBe("16");
		expect(getTerminalTypography().fontSize).toBe(16);
		expect(getPreview(container).style.fontSize).toBe("16px");
		expect(findButtonByText(container, "Reset").disabled).toBe(false);
	});

	it("clamps an out-of-range value when the field is committed", async () => {
		await act(async () => {
			root.render(<TerminalTypographySettings />);
		});

		const fontSizeInput = getInput(container, "terminal-font-size");
		await act(async () => {
			fontSizeInput.focus();
			setInputValue(fontSizeInput, "40");
		});
		// Out-of-range intermediate values are not persisted while typing.
		expect(getTerminalTypography().fontSize).toBe(13);

		await act(async () => {
			fontSizeInput.blur();
		});
		expect(fontSizeInput.value).toBe("20");
		expect(getTerminalTypography().fontSize).toBe(20);
	});

	it("reverts a cleared field to the current value on blur", async () => {
		setTerminalFontSize(16);
		await act(async () => {
			root.render(<TerminalTypographySettings />);
		});

		const fontSizeInput = getInput(container, "terminal-font-size");
		await act(async () => {
			fontSizeInput.focus();
			setInputValue(fontSizeInput, "");
		});
		await act(async () => {
			fontSizeInput.blur();
		});

		expect(fontSizeInput.value).toBe("16");
		expect(getTerminalTypography().fontSize).toBe(16);
	});

	it("resets back to the defaults", async () => {
		setTerminalFontSize(18);
		await act(async () => {
			root.render(<TerminalTypographySettings />);
		});
		expect(getInput(container, "terminal-font-size").value).toBe("18");

		await act(async () => {
			findButtonByText(container, "Reset").click();
		});

		expect(getInput(container, "terminal-font-size").value).toBe("13");
		expect(localStorage.getItem(LocalStorageKey.TerminalFontSize)).toBeNull();
		expect(findButtonByText(container, "Reset").disabled).toBe(true);
	});
});
