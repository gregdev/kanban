import { Play, Trash2 } from "lucide-react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenuArea } from "@/components/ui/context-menu";

describe("ContextMenuArea", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
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
		vi.restoreAllMocks();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("opens on right click and runs the selected action", async () => {
		const onStart = vi.fn();
		const onMoveToDone = vi.fn();

		await act(async () => {
			root.render(
				<ContextMenuArea
					sections={[
						{
							id: "actions",
							items: [
								{ id: "start", label: "Start task", icon: Play, onSelect: onStart },
								{ id: "done", label: "Move to Done", icon: Trash2, danger: true, onSelect: onMoveToDone },
							],
						},
					]}
				>
					<div data-testid="card">Card</div>
				</ContextMenuArea>,
			);
		});

		const card = container.querySelector('[data-testid="card"]');
		expect(card).toBeInstanceOf(HTMLElement);
		expect(document.body.querySelector('[role="menu"]')).toBeNull();

		await act(async () => {
			card?.dispatchEvent(
				new MouseEvent("contextmenu", {
					bubbles: true,
					cancelable: true,
					clientX: 10,
					clientY: 10,
				}),
			);
		});

		const menuItems = Array.from(document.body.querySelectorAll('[role="menuitem"]'));
		const startItem = menuItems.find((item) => item.textContent?.trim() === "Start task");
		expect(startItem).toBeInstanceOf(HTMLElement);

		await act(async () => {
			(startItem as HTMLElement).click();
		});

		expect(onStart).toHaveBeenCalledTimes(1);
		expect(onMoveToDone).not.toHaveBeenCalled();
	});

	it("leaves children untouched when there are no items", async () => {
		await act(async () => {
			root.render(
				<ContextMenuArea sections={[]}>
					<div data-testid="card">Card</div>
				</ContextMenuArea>,
			);
		});

		expect(container.querySelector('[data-testid="card"]')).toBeInstanceOf(HTMLElement);
		expect(container.querySelector("[data-state]")).toBeNull();
	});
});
