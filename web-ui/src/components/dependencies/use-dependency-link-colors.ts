import { useMemo, useRef } from "react";

import { DISTINCT_LINE_COLORS } from "@/components/shared/distinct-line-colors";

export interface DependencyLinkColor {
	/** Index into `DISTINCT_LINE_COLORS`; also used to pick the matching arrow marker. */
	index: number;
	/** CSS color value for the link's stroke and arrow head. */
	value: string;
}

/**
 * Reconciles the sticky dependency-id -> palette-index assignments.
 *
 * Existing assignments are kept so adding a link never recolors the links that
 * are already on screen. Assignments for links that are no longer rendered are
 * dropped so their color becomes available again.
 */
export function reconcileDependencyLinkColorIndices(assignmentById: Map<string, number>, ids: readonly string[]): void {
	const liveIds = new Set(ids);
	for (const assignedId of assignmentById.keys()) {
		if (!liveIds.has(assignedId)) {
			assignmentById.delete(assignedId);
		}
	}

	const usedIndices = new Set(assignmentById.values());
	let nextIndex = 0;
	for (const id of ids) {
		if (assignmentById.has(id)) {
			continue;
		}
		while (usedIndices.has(nextIndex)) {
			nextIndex += 1;
		}
		assignmentById.set(id, nextIndex);
		usedIndices.add(nextIndex);
		nextIndex += 1;
	}
}

/**
 * Assigns each rendered dependency link its own color so parallel links are
 * visually distinguishable. Colors wrap around once the palette is exhausted.
 */
export function useDependencyLinkColors(dependencyIds: readonly string[]): Map<string, DependencyLinkColor> {
	const assignmentByIdRef = useRef(new Map<string, number>());

	return useMemo(() => {
		reconcileDependencyLinkColorIndices(assignmentByIdRef.current, dependencyIds);
		const colors = new Map<string, DependencyLinkColor>();
		for (const dependencyId of dependencyIds) {
			const assignment = assignmentByIdRef.current.get(dependencyId) ?? 0;
			const index = assignment % DISTINCT_LINE_COLORS.length;
			colors.set(dependencyId, {
				index,
				value: DISTINCT_LINE_COLORS[index] ?? DISTINCT_LINE_COLORS[0]!,
			});
		}
		return colors;
	}, [dependencyIds]);
}
