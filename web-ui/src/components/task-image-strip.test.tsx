import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskImageStrip } from "@/components/task-image-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskImage } from "@/types";

const IMAGE: TaskImage = {
	id: "image-1",
	name: "diagram.png",
	mimeType: "image/png",
	data: "aGVsbG8=",
};

describe("TaskImageStrip", () => {
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

	it("does not remove the image when the chip body is clicked", async () => {
		const onRemoveImage = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskImageStrip images={[IMAGE]} onRemoveImage={onRemoveImage} />
				</TooltipProvider>,
			);
		});

		const chip = container.querySelector("img")?.closest("div");
		expect(chip).toBeInstanceOf(HTMLElement);

		await act(async () => {
			(chip as HTMLElement).click();
		});

		expect(onRemoveImage).not.toHaveBeenCalled();
	});

	it("removes the image from the explicit remove button", async () => {
		const onRemoveImage = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskImageStrip images={[IMAGE]} onRemoveImage={onRemoveImage} />
				</TooltipProvider>,
			);
		});

		const removeButton = Array.from(container.querySelectorAll("button")).find(
			(button) => button.getAttribute("aria-label") === "Remove diagram.png",
		);
		expect(removeButton).toBeInstanceOf(HTMLButtonElement);

		await act(async () => {
			removeButton?.click();
		});

		expect(onRemoveImage).toHaveBeenCalledWith("image-1");
	});

	it("offers removal from the right-click menu", async () => {
		const onRemoveImage = vi.fn();
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskImageStrip images={[IMAGE]} onRemoveImage={onRemoveImage} />
				</TooltipProvider>,
			);
		});

		const chip = container.querySelector("img")?.closest("div");
		await act(async () => {
			chip?.dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
			);
		});

		const menuItem = Array.from(document.body.querySelectorAll('[role="menuitem"]')).find(
			(item) => item.textContent?.trim() === "Remove image",
		);
		expect(menuItem).toBeInstanceOf(HTMLElement);

		await act(async () => {
			(menuItem as HTMLElement).click();
		});

		expect(onRemoveImage).toHaveBeenCalledWith("image-1");
	});

	it("renders a read-only chip without a remove button when no handler is given", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<TaskImageStrip images={[IMAGE]} />
				</TooltipProvider>,
			);
		});

		expect(container.querySelector("button")).toBeNull();
		expect(container.textContent).toContain("diagram.png");
	});
});
