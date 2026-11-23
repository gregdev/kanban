import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalStorageKey } from "@/storage/local-storage-store";
import { createTextDraftKey, readTextDraft, writeTextDraft } from "@/storage/text-drafts";

const DRAFT_KEY = createTextDraftKey({ kind: "agent-chat", workspaceId: "ws-1", taskId: "task-1" });

describe("text drafts", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		localStorage.clear();
	});

	it("round-trips a draft by scope key", () => {
		expect(readTextDraft(DRAFT_KEY)).toBe("");

		writeTextDraft(DRAFT_KEY, "Investigate the flaky test");

		expect(readTextDraft(DRAFT_KEY)).toBe("Investigate the flaky test");
		expect(readTextDraft(createTextDraftKey({ kind: "agent-chat", workspaceId: "ws-1", taskId: "task-2" }))).toBe("");
	});

	it("removes the stored entry when the draft is cleared", () => {
		writeTextDraft(DRAFT_KEY, "hello");
		writeTextDraft(DRAFT_KEY, "");

		expect(localStorage.getItem(LocalStorageKey.TextDrafts)).toBeNull();
		expect(readTextDraft(DRAFT_KEY)).toBe("");
	});

	it("ignores corrupt payloads and malformed entries", () => {
		localStorage.setItem(LocalStorageKey.TextDrafts, "not-json");
		expect(readTextDraft(DRAFT_KEY)).toBe("");

		localStorage.setItem(
			LocalStorageKey.TextDrafts,
			JSON.stringify({
				[DRAFT_KEY]: { text: "valid", updatedAt: 10 },
				badText: { text: 42, updatedAt: 10 },
				badTimestamp: { text: "nope" },
				empty: { text: "", updatedAt: 10 },
			}),
		);

		expect(readTextDraft(DRAFT_KEY)).toBe("valid");
		expect(readTextDraft("badText")).toBe("");
		expect(readTextDraft("badTimestamp")).toBe("");
		expect(readTextDraft("empty")).toBe("");
	});

	it("caps the number of retained drafts", () => {
		for (let index = 0; index < 130; index += 1) {
			writeTextDraft(`draft-${index}`, `text-${index}`);
		}

		const storedDrafts = JSON.parse(localStorage.getItem(LocalStorageKey.TextDrafts) ?? "{}") as Record<
			string,
			unknown
		>;
		expect(Object.keys(storedDrafts)).toHaveLength(100);
	});
});
