import {
	LocalStorageKey,
	readLocalStorageItem,
	removeLocalStorageItem,
	writeLocalStorageItem,
} from "@/storage/local-storage-store";

// Drafts are persisted so a dropped runtime connection, page reload, or PWA
// wake-up does not discard a prompt the user was part-way through writing.
// The map is capped so abandoned drafts cannot grow without bound.
const MAX_STORED_TEXT_DRAFTS = 100;

export type TextDraftKind = "agent-chat" | "new-task";

export interface TextDraftScope {
	kind: TextDraftKind;
	workspaceId?: string | null;
	taskId?: string | null;
}

interface StoredTextDraft {
	text: string;
	updatedAt: number;
}

type StoredTextDraftMap = Record<string, StoredTextDraft>;

// Drafts are written on every keystroke, so cache the parsed map and only
// re-parse when another tab (or a test) changed the raw value underneath us.
let cachedDraftsRaw: string | null = null;
let cachedDrafts: StoredTextDraftMap = {};

export function createTextDraftKey(scope: TextDraftScope): string {
	return [scope.kind, scope.workspaceId ?? "", scope.taskId ?? ""].join(":");
}

function parseStoredTextDrafts(raw: string | null): StoredTextDraftMap {
	if (!raw) {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	const drafts: StoredTextDraftMap = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (typeof value !== "object" || value === null) {
			continue;
		}
		const candidate = value as { text?: unknown; updatedAt?: unknown };
		if (typeof candidate.text !== "string" || typeof candidate.updatedAt !== "number") {
			continue;
		}
		if (candidate.text.length === 0) {
			continue;
		}
		drafts[key] = { text: candidate.text, updatedAt: candidate.updatedAt };
	}
	return drafts;
}

function readStoredTextDrafts(): StoredTextDraftMap {
	const raw = readLocalStorageItem(LocalStorageKey.TextDrafts);
	if (raw === cachedDraftsRaw) {
		return { ...cachedDrafts };
	}
	cachedDraftsRaw = raw;
	cachedDrafts = parseStoredTextDrafts(raw);
	return { ...cachedDrafts };
}

function writeStoredTextDrafts(drafts: StoredTextDraftMap): void {
	const entries = Object.entries(drafts);
	if (entries.length === 0) {
		removeLocalStorageItem(LocalStorageKey.TextDrafts);
		cachedDraftsRaw = null;
		cachedDrafts = {};
		return;
	}
	const prunedDrafts = Object.fromEntries(
		entries.sort(([, left], [, right]) => right.updatedAt - left.updatedAt).slice(0, MAX_STORED_TEXT_DRAFTS),
	);
	const raw = JSON.stringify(prunedDrafts);
	writeLocalStorageItem(LocalStorageKey.TextDrafts, raw);
	cachedDraftsRaw = raw;
	cachedDrafts = prunedDrafts;
}

export function readTextDraft(scopeKey: string): string {
	return readStoredTextDrafts()[scopeKey]?.text ?? "";
}

export function writeTextDraft(scopeKey: string, text: string): void {
	const drafts = readStoredTextDrafts();
	if (text.length === 0) {
		if (!(scopeKey in drafts)) {
			return;
		}
		delete drafts[scopeKey];
		writeStoredTextDrafts(drafts);
		return;
	}
	drafts[scopeKey] = { text, updatedAt: Date.now() };
	writeStoredTextDrafts(drafts);
}
