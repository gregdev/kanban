import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NextUpTasksBadge } from "@/components/dependencies/next-up-tasks-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BoardCard } from "@/types";

function createTask(id: string, title: string): BoardCard {
	return {
		id,
		title,
		prompt: title,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("NextUpTasksBadge", () => {
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

	it("names the single task that will run next", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<NextUpTasksBadge tasks={[createTask("task-b", "Fix login bug")]} gatingColumnId="review" />
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("Up next");
		expect(container.textContent).toContain("Fix login bug");
	});

	it("summarizes multiple queued tasks by count", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<NextUpTasksBadge
						tasks={[createTask("task-b", "Fix login bug"), createTask("task-c", "Add tests")]}
						gatingColumnId="review"
					/>
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toContain("Up next");
		expect(container.textContent).toContain("2 tasks");
		expect(container.textContent).not.toContain("Fix login bug");
	});

	it("renders nothing when no tasks are queued", async () => {
		await act(async () => {
			root.render(
				<TooltipProvider>
					<NextUpTasksBadge tasks={[]} gatingColumnId="review" />
				</TooltipProvider>,
			);
		});

		expect(container.textContent).toBe("");
	});
});
