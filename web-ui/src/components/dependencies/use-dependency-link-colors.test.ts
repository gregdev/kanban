import { describe, expect, it } from "vitest";

import { reconcileDependencyLinkColorIndices } from "@/components/dependencies/use-dependency-link-colors";

describe("reconcileDependencyLinkColorIndices", () => {
	it("assigns a distinct palette index to every link in first-seen order", () => {
		const assignmentById = new Map<string, number>();

		reconcileDependencyLinkColorIndices(assignmentById, ["link-a", "link-b", "link-c"]);

		expect([...assignmentById.entries()]).toEqual([
			["link-a", 0],
			["link-b", 1],
			["link-c", 2],
		]);
	});

	it("keeps existing colors when a new link appears", () => {
		const assignmentById = new Map<string, number>();
		reconcileDependencyLinkColorIndices(assignmentById, ["link-a", "link-b"]);

		reconcileDependencyLinkColorIndices(assignmentById, ["link-b", "link-a", "link-c"]);

		expect(assignmentById.get("link-a")).toBe(0);
		expect(assignmentById.get("link-b")).toBe(1);
		expect(assignmentById.get("link-c")).toBe(2);
	});

	it("frees the color of a removed link for the next new link", () => {
		const assignmentById = new Map<string, number>();
		reconcileDependencyLinkColorIndices(assignmentById, ["link-a", "link-b", "link-c"]);

		reconcileDependencyLinkColorIndices(assignmentById, ["link-a", "link-c"]);
		reconcileDependencyLinkColorIndices(assignmentById, ["link-a", "link-c", "link-d"]);

		expect(assignmentById.get("link-a")).toBe(0);
		expect(assignmentById.get("link-c")).toBe(2);
		expect(assignmentById.get("link-d")).toBe(1);
	});
});
