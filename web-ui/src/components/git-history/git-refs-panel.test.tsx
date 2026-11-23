import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GitRefsPanel } from "@/components/git-history/git-refs-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { RuntimeGitRef } from "@/runtime/types";

const REFS: RuntimeGitRef[] = [
	{ name: "main", type: "branch", hash: "aaaa1111", isHead: true },
	{ name: "feature/login", type: "branch", hash: "bbbb2222", isHead: false },
	{ name: "origin/main", type: "remote", hash: "cccc3333", isHead: false },
];

function renderRefsPanel(onCheckoutRef: (branch: string) => void): { root: Root; container: HTMLDivElement } {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	act(() => {
		root.render(
			<TooltipProvider>
				<GitRefsPanel
					refs={REFS}
					selectedRefName={null}
					isLoading={false}
					panelWidth={240}
					workingCopyChanges={null}
					onSelectRef={() => {}}
					onCheckoutRef={onCheckoutRef}
				/>
			</TooltipProvider>,
		);
	});
	return { root, container };
}

function findRowButton(container: HTMLElement, label: string): HTMLButtonElement {
	const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`Could not find a ref row for ${label}`);
	}
	return button;
}

async function openContextMenu(element: HTMLElement): Promise<string[]> {
	await act(async () => {
		element.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
		);
	});
	return Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.trim() ?? "");
}

describe("GitRefsPanel context menu", () => {
	let previousActEnvironment: boolean | undefined;
	let root: Root | null = null;
	let container: HTMLDivElement | null = null;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		if (root) {
			act(() => {
				root?.unmount();
			});
		}
		container?.remove();
		root = null;
		container = null;
		vi.restoreAllMocks();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("offers checkout and copy actions for a local branch", async () => {
		const onCheckoutRef = vi.fn();
		const rendered = renderRefsPanel(onCheckoutRef);
		root = rendered.root;
		container = rendered.container;

		const labels = await openContextMenu(findRowButton(rendered.container, "feature/login"));

		expect(labels).toContain("Checkout branch");
		expect(labels).toContain("Copy branch name");
		expect(labels).toContain("Copy commit SHA");
	});

	it("omits checkout for the current HEAD branch", async () => {
		const rendered = renderRefsPanel(vi.fn());
		root = rendered.root;
		container = rendered.container;

		const labels = await openContextMenu(findRowButton(rendered.container, "main"));

		expect(labels).not.toContain("Checkout branch");
		expect(labels).toContain("Copy branch name");
	});

	it("runs checkout when the menu action is selected", async () => {
		const onCheckoutRef = vi.fn();
		const rendered = renderRefsPanel(onCheckoutRef);
		root = rendered.root;
		container = rendered.container;

		await openContextMenu(findRowButton(rendered.container, "feature/login"));
		const checkoutItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent?.trim() === "Checkout branch",
		);
		expect(checkoutItem).toBeInstanceOf(HTMLElement);

		await act(async () => {
			(checkoutItem as HTMLElement).click();
		});

		expect(onCheckoutRef).toHaveBeenCalledWith("feature/login");
	});

	it("labels remote rows separately and never offers checkout", async () => {
		const rendered = renderRefsPanel(vi.fn());
		root = rendered.root;
		container = rendered.container;

		const labels = await openContextMenu(findRowButton(rendered.container, "origin/main"));

		expect(labels).not.toContain("Checkout branch");
		expect(labels).toContain("Copy remote branch name");
	});
});
