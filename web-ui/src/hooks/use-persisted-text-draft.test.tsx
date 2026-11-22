import type { Dispatch, SetStateAction } from "react";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usePersistedTextDraft } from "@/hooks/use-persisted-text-draft";
import { createTextDraftKey, readTextDraft, writeTextDraft } from "@/storage/text-drafts";

interface HookSnapshot {
	draft: string;
	setDraft: Dispatch<SetStateAction<string>>;
}

function HookHarness({
	scopeKey,
	onSnapshot,
}: {
	scopeKey: string;
	onSnapshot: (snapshot: HookSnapshot) => void;
}): null {
	const [draft, setDraft] = usePersistedTextDraft(scopeKey);

	useEffect(() => {
		onSnapshot({ draft, setDraft });
	}, [draft, onSnapshot, setDraft]);

	return null;
}

const SCOPE_A = createTextDraftKey({ kind: "agent-chat", workspaceId: "ws-1", taskId: "task-1" });
const SCOPE_B = createTextDraftKey({ kind: "agent-chat", workspaceId: "ws-1", taskId: "task-2" });

function requireSnapshot(snapshot: HookSnapshot | null): HookSnapshot {
	if (!snapshot) {
		throw new Error("Expected hook snapshot.");
	}
	return snapshot;
}

describe("usePersistedTextDraft", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		localStorage.clear();
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
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
		localStorage.clear();
	});

	it("restores a draft after the component remounts", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const handleSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};

		await act(async () => {
			root.render(<HookHarness scopeKey={SCOPE_A} onSnapshot={handleSnapshot} />);
			await Promise.resolve();
		});

		await act(async () => {
			requireSnapshot(latestSnapshot).setDraft("Investigate the flaky test");
			await Promise.resolve();
		});

		expect(readTextDraft(SCOPE_A)).toBe("Investigate the flaky test");

		await act(async () => {
			root.unmount();
		});
		root = createRoot(container);

		await act(async () => {
			root.render(<HookHarness scopeKey={SCOPE_A} onSnapshot={handleSnapshot} />);
			await Promise.resolve();
		});

		expect(requireSnapshot(latestSnapshot).draft).toBe("Investigate the flaky test");
	});

	it("swaps drafts when the scope key changes", async () => {
		writeTextDraft(SCOPE_A, "draft for task one");
		writeTextDraft(SCOPE_B, "draft for task two");
		let latestSnapshot: HookSnapshot | null = null;
		const handleSnapshot = (snapshot: HookSnapshot) => {
			latestSnapshot = snapshot;
		};

		await act(async () => {
			root.render(<HookHarness scopeKey={SCOPE_A} onSnapshot={handleSnapshot} />);
			await Promise.resolve();
		});

		expect(requireSnapshot(latestSnapshot).draft).toBe("draft for task one");

		await act(async () => {
			root.render(<HookHarness scopeKey={SCOPE_B} onSnapshot={handleSnapshot} />);
			await Promise.resolve();
		});

		expect(requireSnapshot(latestSnapshot).draft).toBe("draft for task two");

		await act(async () => {
			requireSnapshot(latestSnapshot).setDraft("updated task two draft");
			await Promise.resolve();
		});

		expect(readTextDraft(SCOPE_A)).toBe("draft for task one");
		expect(readTextDraft(SCOPE_B)).toBe("updated task two draft");
	});
});
