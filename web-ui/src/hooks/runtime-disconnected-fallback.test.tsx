import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeDisconnectedFallback } from "@/hooks/runtime-disconnected-fallback";

describe("RuntimeDisconnectedFallback", () => {
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
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders the blocking screen by default", async () => {
		await act(async () => {
			root.render(<RuntimeDisconnectedFallback />);
		});

		expect(container.textContent).toContain("Disconnected from Kanban");
		expect(container.textContent).toContain("Run kanban again in your terminal");
	});

	it("renders a non-blocking reconnecting banner for the overlay variant", async () => {
		await act(async () => {
			root.render(<RuntimeDisconnectedFallback variant="overlay" />);
		});

		const status = container.querySelector('[role="status"]');
		expect(status).toBeInstanceOf(HTMLDivElement);
		expect(status?.className).toContain("pointer-events-none");
		expect(container.textContent).toContain("Connection to Kanban dropped");
		expect(container.textContent).toContain("Reconnecting...");
	});
});
