import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocalStorageKey } from "@/storage/local-storage-store";
import {
	DEFAULT_TERMINAL_TYPOGRAPHY,
	getTerminalTypography,
	isDefaultTerminalTypography,
	loadTerminalTypography,
	resetTerminalTypography,
	setTerminalFontSize,
	setTerminalLetterSpacing,
	setTerminalLineHeight,
	subscribeTerminalTypography,
} from "@/terminal/terminal-typography";

describe("terminal typography preferences", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	it("defaults to the historical terminal metrics", () => {
		expect(loadTerminalTypography()).toEqual({ fontSize: 13, lineHeight: 1, letterSpacing: 0 });
		expect(getTerminalTypography()).toEqual(DEFAULT_TERMINAL_TYPOGRAPHY);
		expect(isDefaultTerminalTypography(getTerminalTypography())).toBe(true);
	});

	it("persists each value and resolves it again from storage", () => {
		expect(setTerminalFontSize(16)).toBe(16);
		expect(setTerminalLineHeight(1.35)).toBe(1.35);
		expect(setTerminalLetterSpacing(1)).toBe(1);

		expect(localStorage.getItem(LocalStorageKey.TerminalFontSize)).toBe("16");
		expect(localStorage.getItem(LocalStorageKey.TerminalLineHeight)).toBe("1.35");
		expect(localStorage.getItem(LocalStorageKey.TerminalLetterSpacing)).toBe("1");
		expect(loadTerminalTypography()).toEqual({ fontSize: 16, lineHeight: 1.35, letterSpacing: 1 });
		expect(getTerminalTypography()).toEqual({ fontSize: 16, lineHeight: 1.35, letterSpacing: 1 });
		expect(isDefaultTerminalTypography(getTerminalTypography())).toBe(false);
	});

	it("clamps and quantizes writes to the control range and step", () => {
		expect(setTerminalFontSize(99)).toBe(20);
		expect(setTerminalFontSize(3)).toBe(10);
		expect(setTerminalFontSize(13.4)).toBe(13);
		expect(setTerminalLineHeight(2.4)).toBe(1.6);
		expect(setTerminalLineHeight(0.2)).toBe(1);
		expect(setTerminalLineHeight(1.33)).toBe(1.35);
		expect(setTerminalLetterSpacing(-1)).toBe(0);
		expect(setTerminalLetterSpacing(9)).toBe(2);
		expect(setTerminalLetterSpacing(0.75)).toBe(1);
	});

	it("ignores invalid stored values", () => {
		localStorage.setItem(LocalStorageKey.TerminalFontSize, "not-a-number");
		localStorage.setItem(LocalStorageKey.TerminalLineHeight, "Infinity");
		localStorage.setItem(LocalStorageKey.TerminalLetterSpacing, "");

		expect(loadTerminalTypography()).toEqual(DEFAULT_TERMINAL_TYPOGRAPHY);
		expect(getTerminalTypography()).toEqual(DEFAULT_TERMINAL_TYPOGRAPHY);
	});

	it("ignores non-finite writes", () => {
		expect(setTerminalFontSize(Number.NaN)).toBe(DEFAULT_TERMINAL_TYPOGRAPHY.fontSize);
		expect(setTerminalLineHeight(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TERMINAL_TYPOGRAPHY.lineHeight);
		expect(localStorage.getItem(LocalStorageKey.TerminalFontSize)).toBeNull();
	});

	it("notifies subscribers once per real change and resets to defaults", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeTerminalTypography(listener);

		setTerminalFontSize(18);
		expect(listener).toHaveBeenCalledTimes(1);

		setTerminalFontSize(18);
		expect(listener).toHaveBeenCalledTimes(1);

		resetTerminalTypography();
		expect(listener).toHaveBeenCalledTimes(2);
		expect(getTerminalTypography()).toEqual(DEFAULT_TERMINAL_TYPOGRAPHY);
		expect(localStorage.getItem(LocalStorageKey.TerminalFontSize)).toBeNull();
		expect(localStorage.getItem(LocalStorageKey.TerminalLineHeight)).toBeNull();
		expect(localStorage.getItem(LocalStorageKey.TerminalLetterSpacing)).toBeNull();

		unsubscribe();
		setTerminalFontSize(15);
		expect(listener).toHaveBeenCalledTimes(2);
	});
});
