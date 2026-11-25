import { clampBetween } from "@/resize/resize-persistence";
import {
	loadResizePreference,
	persistResizePreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey, readLocalStorageItem, removeLocalStorageItem } from "@/storage/local-storage-store";

export interface TerminalTypography {
	fontSize: number;
	letterSpacing: number;
	lineHeight: number;
}

export const TERMINAL_FONT_SIZE_MIN = 10;
export const TERMINAL_FONT_SIZE_MAX = 20;
export const TERMINAL_FONT_SIZE_STEP = 1;
export const TERMINAL_LINE_HEIGHT_MIN = 1;
export const TERMINAL_LINE_HEIGHT_MAX = 1.6;
export const TERMINAL_LINE_HEIGHT_STEP = 0.05;
export const TERMINAL_LETTER_SPACING_MIN = 0;
export const TERMINAL_LETTER_SPACING_MAX = 2;
export const TERMINAL_LETTER_SPACING_STEP = 0.5;

// These are the values the terminal has always rendered with. Keep them
// byte-identical so a user who never opens Settings sees no change.
export const DEFAULT_TERMINAL_TYPOGRAPHY: TerminalTypography = {
	fontSize: 13,
	letterSpacing: 0,
	lineHeight: 1,
};

function normalizeToStep({
	fallback,
	max,
	min,
	step,
	value,
}: {
	fallback: number;
	max: number;
	min: number;
	step: number;
	value: number;
}): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}
	const steppedValue = min + Math.round((value - min) / step) * step;
	// Rolling to two decimals keeps `1 + 7 * 0.05` from being persisted as
	// 1.3500000000000001, and keeps the stored string identical to the value
	// xterm measures cells with.
	return Number(clampBetween(steppedValue, min, max).toFixed(2));
}

export function normalizeTerminalFontSize(value: number): number {
	return normalizeToStep({
		fallback: DEFAULT_TERMINAL_TYPOGRAPHY.fontSize,
		max: TERMINAL_FONT_SIZE_MAX,
		min: TERMINAL_FONT_SIZE_MIN,
		step: TERMINAL_FONT_SIZE_STEP,
		value,
	});
}

export function normalizeTerminalLineHeight(value: number): number {
	return normalizeToStep({
		fallback: DEFAULT_TERMINAL_TYPOGRAPHY.lineHeight,
		max: TERMINAL_LINE_HEIGHT_MAX,
		min: TERMINAL_LINE_HEIGHT_MIN,
		step: TERMINAL_LINE_HEIGHT_STEP,
		value,
	});
}

export function normalizeTerminalLetterSpacing(value: number): number {
	return normalizeToStep({
		fallback: DEFAULT_TERMINAL_TYPOGRAPHY.letterSpacing,
		max: TERMINAL_LETTER_SPACING_MAX,
		min: TERMINAL_LETTER_SPACING_MIN,
		step: TERMINAL_LETTER_SPACING_STEP,
		value,
	});
}

export function normalizeTerminalTypography(typography: TerminalTypography): TerminalTypography {
	return {
		fontSize: normalizeTerminalFontSize(typography.fontSize),
		letterSpacing: normalizeTerminalLetterSpacing(typography.letterSpacing),
		lineHeight: normalizeTerminalLineHeight(typography.lineHeight),
	};
}

export function isDefaultTerminalTypography(typography: TerminalTypography): boolean {
	return (
		typography.fontSize === DEFAULT_TERMINAL_TYPOGRAPHY.fontSize &&
		typography.letterSpacing === DEFAULT_TERMINAL_TYPOGRAPHY.letterSpacing &&
		typography.lineHeight === DEFAULT_TERMINAL_TYPOGRAPHY.lineHeight
	);
}

const TERMINAL_FONT_SIZE_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.TerminalFontSize,
	defaultValue: DEFAULT_TERMINAL_TYPOGRAPHY.fontSize,
	normalize: normalizeTerminalFontSize,
};

const TERMINAL_LINE_HEIGHT_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.TerminalLineHeight,
	defaultValue: DEFAULT_TERMINAL_TYPOGRAPHY.lineHeight,
	normalize: normalizeTerminalLineHeight,
};

const TERMINAL_LETTER_SPACING_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.TerminalLetterSpacing,
	defaultValue: DEFAULT_TERMINAL_TYPOGRAPHY.letterSpacing,
	normalize: normalizeTerminalLetterSpacing,
};

const TYPOGRAPHY_STORAGE_KEYS = [
	LocalStorageKey.TerminalFontSize,
	LocalStorageKey.TerminalLineHeight,
	LocalStorageKey.TerminalLetterSpacing,
] as const;

const TYPOGRAPHY_STORAGE_KEY_SET = new Set<string>(TYPOGRAPHY_STORAGE_KEYS);
export type TerminalTypographyListener = (typography: TerminalTypography) => void;
const typographyStoreListeners = new Set<TerminalTypographyListener>();

// `getSnapshot` has to be referentially stable between changes, so cache the
// resolved value keyed by the raw stored strings. Writing through the setters
// (or another tab's `storage` event) changes that snapshot.
let cachedStorageSnapshot: string | null = null;
let cachedTypography: TerminalTypography = DEFAULT_TERMINAL_TYPOGRAPHY;
let storageSyncInstalled = false;

function readStorageSnapshot(): string {
	return TYPOGRAPHY_STORAGE_KEYS.map((key) => readLocalStorageItem(key) ?? "").join("|");
}

function notifyTypographyStoreListeners(): void {
	const typography = getTerminalTypography();
	for (const listener of typographyStoreListeners) {
		listener(typography);
	}
}

function installTypographyStorageSyncListener(): void {
	if (storageSyncInstalled || typeof window === "undefined") {
		return;
	}
	storageSyncInstalled = true;
	window.addEventListener("storage", (event) => {
		if (event.key !== null && !TYPOGRAPHY_STORAGE_KEY_SET.has(event.key)) {
			return;
		}
		notifyTypographyStoreListeners();
	});
}

export function loadTerminalTypography(): TerminalTypography {
	return normalizeTerminalTypography({
		fontSize: loadResizePreference(TERMINAL_FONT_SIZE_PREFERENCE),
		letterSpacing: loadResizePreference(TERMINAL_LETTER_SPACING_PREFERENCE),
		lineHeight: loadResizePreference(TERMINAL_LINE_HEIGHT_PREFERENCE),
	});
}

export function getTerminalTypography(): TerminalTypography {
	const storageSnapshot = readStorageSnapshot();
	if (storageSnapshot === cachedStorageSnapshot) {
		return cachedTypography;
	}
	cachedStorageSnapshot = storageSnapshot;
	cachedTypography = loadTerminalTypography();
	return cachedTypography;
}

export function subscribeTerminalTypography(listener: TerminalTypographyListener): () => void {
	installTypographyStorageSyncListener();
	typographyStoreListeners.add(listener);
	return () => {
		typographyStoreListeners.delete(listener);
	};
}

function commitTerminalTypography(nextTypography: TerminalTypography): TerminalTypography {
	const normalizedTypography = normalizeTerminalTypography(nextTypography);
	const currentTypography = getTerminalTypography();
	if (
		normalizedTypography.fontSize === currentTypography.fontSize &&
		normalizedTypography.letterSpacing === currentTypography.letterSpacing &&
		normalizedTypography.lineHeight === currentTypography.lineHeight
	) {
		return currentTypography;
	}
	persistResizePreference(TERMINAL_FONT_SIZE_PREFERENCE, normalizedTypography.fontSize);
	persistResizePreference(TERMINAL_LINE_HEIGHT_PREFERENCE, normalizedTypography.lineHeight);
	persistResizePreference(TERMINAL_LETTER_SPACING_PREFERENCE, normalizedTypography.letterSpacing);
	cachedTypography = normalizedTypography;
	cachedStorageSnapshot = readStorageSnapshot();
	notifyTypographyStoreListeners();
	return normalizedTypography;
}

export function setTerminalFontSize(fontSize: number): number {
	return commitTerminalTypography({ ...getTerminalTypography(), fontSize }).fontSize;
}

export function setTerminalLineHeight(lineHeight: number): number {
	return commitTerminalTypography({ ...getTerminalTypography(), lineHeight }).lineHeight;
}

export function setTerminalLetterSpacing(letterSpacing: number): number {
	return commitTerminalTypography({ ...getTerminalTypography(), letterSpacing }).letterSpacing;
}

export function resetTerminalTypography(): TerminalTypography {
	for (const key of TYPOGRAPHY_STORAGE_KEYS) {
		removeLocalStorageItem(key);
	}
	cachedStorageSnapshot = readStorageSnapshot();
	cachedTypography = DEFAULT_TERMINAL_TYPOGRAPHY;
	notifyTypographyStoreListeners();
	return cachedTypography;
}
