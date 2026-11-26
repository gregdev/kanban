import { act, useEffect } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useDependencyLinking } from "@/components/dependencies/use-dependency-linking";

interface UseDependencyLinkingOptions {
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
}

let latestResult: ReturnType<typeof useDependencyLinking> | null = null;

function Harness(options: UseDependencyLinkingOptions): React.ReactElement {
	const linking = useDependencyLinking(options);
	useEffect(() => {
		latestResult = linking;
	});
	return <div />;
}

function getResult(): ReturnType<typeof useDependencyLinking> {
	if (!latestResult) {
		throw new Error("Expected the hook to have rendered.");
	}
	return latestResult;
}

describe("useDependencyLinking", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		latestResult = null;
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
		document.body.classList.remove("kb-dependency-link-mode");
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	async function render(options: UseDependencyLinkingOptions): Promise<void> {
		await act(async () => {
			root.render(<Harness {...options} />);
		});
	}

	it("arms a link from the menu and completes it when another task is selected", async () => {
		const onCreateDependency = vi.fn();
		await render({ onCreateDependency });

		await act(async () => {
			getResult().onDependencyLinkStart("task-a");
		});

		expect(getResult().draft?.armed).toBe(true);
		expect(getResult().draft?.sourceTaskId).toBe("task-a");
		expect(document.body.classList.contains("kb-dependency-link-mode")).toBe(true);

		await act(async () => {
			getResult().onDependencyLinkSelect("task-b");
		});

		expect(onCreateDependency).toHaveBeenCalledWith("task-a", "task-b");
		expect(getResult().draft).toBeNull();
		expect(document.body.classList.contains("kb-dependency-link-mode")).toBe(false);
	});

	it("passes invalid targets through so the caller can explain the failure", async () => {
		const onCreateDependency = vi.fn();
		await render({
			canLinkTasks: (fromTaskId, toTaskId) => fromTaskId === "backlog-task" && toTaskId === "review-task",
			onCreateDependency,
		});

		await act(async () => {
			getResult().onDependencyLinkStart("review-task");
		});
		await act(async () => {
			getResult().onDependencyLinkSelect("other-review-task");
		});

		expect(onCreateDependency).toHaveBeenCalledWith("review-task", "other-review-task");
		expect(getResult().draft).toBeNull();
	});

	it("cancels when the source card is selected again", async () => {
		const onCreateDependency = vi.fn();
		await render({ onCreateDependency });

		await act(async () => {
			getResult().onDependencyLinkStart("task-a");
		});
		await act(async () => {
			getResult().onDependencyLinkSelect("task-a");
		});

		expect(onCreateDependency).not.toHaveBeenCalled();
		expect(getResult().draft).toBeNull();
	});

	it("cancels an armed link on Escape", async () => {
		const onCreateDependency = vi.fn();
		await render({ onCreateDependency });

		await act(async () => {
			getResult().onDependencyLinkStart("task-a");
		});
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});

		expect(getResult().draft).toBeNull();
		expect(onCreateDependency).not.toHaveBeenCalled();
	});

	it("cancels an armed link when clicking outside every card", async () => {
		await render({});

		await act(async () => {
			getResult().onDependencyLinkStart("task-a");
		});
		await act(async () => {
			document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(getResult().draft).toBeNull();
	});

	it("ignores card selections while a modifier drag is in progress", async () => {
		const onCreateDependency = vi.fn();
		await render({ onCreateDependency });

		const pointerDownEvent = {
			metaKey: true,
			ctrlKey: false,
			clientX: 10,
			clientY: 10,
		} as ReactMouseEvent<HTMLElement>;

		await act(async () => {
			getResult().onDependencyPointerDown("task-a", pointerDownEvent);
		});

		expect(getResult().draft?.armed).toBe(false);
		expect(getResult().draft).not.toBeNull();

		await act(async () => {
			getResult().onDependencyLinkSelect("task-b");
		});

		expect(onCreateDependency).not.toHaveBeenCalled();
		expect(getResult().draft).not.toBeNull();
	});
});
