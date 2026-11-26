import type { MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export interface DependencyLinkDraft {
	sourceTaskId: string;
	targetTaskId: string | null;
	pointerClientX: number;
	pointerClientY: number;
	/**
	 * Armed drafts come from the card menu ("Link to Task") instead of a held
	 * modifier key. They stay active until the user picks a task, presses
	 * Escape, or clicks outside the board, and they complete on a plain
	 * click/tap rather than on the mouseup that ends a modifier drag.
	 */
	armed: boolean;
}

const CARD_GAP_CAPTURE_PX = 16;

function getNearestCardTaskIdInColumn(columnElement: HTMLElement, clientY: number): string | null {
	const cards = Array.from(columnElement.querySelectorAll<HTMLElement>("[data-task-id]"));
	if (cards.length === 0) {
		return null;
	}

	let nearestBelow: { taskId: string; distance: number } | null = null;
	let nearestAbove: { taskId: string; distance: number } | null = null;

	for (const card of cards) {
		const taskId = card.dataset.taskId;
		if (!taskId) {
			continue;
		}
		const rect = card.getBoundingClientRect();
		if (clientY >= rect.top && clientY <= rect.bottom) {
			return taskId;
		}
		if (clientY < rect.top) {
			const distance = rect.top - clientY;
			if (!nearestBelow || distance < nearestBelow.distance) {
				nearestBelow = { taskId, distance };
			}
			continue;
		}
		const distance = clientY - rect.bottom;
		if (!nearestAbove || distance < nearestAbove.distance) {
			nearestAbove = { taskId, distance };
		}
	}

	if (nearestBelow && nearestBelow.distance <= CARD_GAP_CAPTURE_PX) {
		return nearestBelow.taskId;
	}
	if (nearestAbove && nearestAbove.distance <= CARD_GAP_CAPTURE_PX) {
		return nearestAbove.taskId;
	}

	return null;
}

function getTaskIdFromPoint(clientX: number, clientY: number): string | null {
	if (typeof document === "undefined") {
		return null;
	}
	const elementsAtPoint = document.elementsFromPoint(clientX, clientY);
	let columnElement: HTMLElement | null = null;
	for (const element of elementsAtPoint) {
		const card = element.closest("[data-task-id]");
		if (card instanceof HTMLElement) {
			return card.dataset.taskId ?? null;
		}
		if (!columnElement) {
			const column = element.closest("[data-column-id]");
			if (column instanceof HTMLElement) {
				columnElement = column;
			}
		}
	}

	if (columnElement) {
		return getNearestCardTaskIdInColumn(columnElement, clientY);
	}
	return null;
}

function getTaskCenterPoint(taskId: string): { clientX: number; clientY: number } | null {
	if (typeof document === "undefined") {
		return null;
	}
	for (const element of document.querySelectorAll<HTMLElement>("[data-task-id]")) {
		if (element.dataset.taskId !== taskId) {
			continue;
		}
		const rect = element.getBoundingClientRect();
		return {
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2,
		};
	}
	return null;
}

export function useDependencyLinking({
	canLinkTasks,
	onCreateDependency,
}: {
	canLinkTasks?: (fromTaskId: string, toTaskId: string) => boolean;
	onCreateDependency?: (fromTaskId: string, toTaskId: string) => void;
}): {
	draft: DependencyLinkDraft | null;
	onDependencyPointerDown: (taskId: string, event: ReactMouseEvent<HTMLElement>) => void;
	onDependencyPointerEnter: (taskId: string) => void;
	/** Starts a click/tap link from the card menu without holding a modifier. */
	onDependencyLinkStart: (taskId: string) => void;
	/** Completes the armed link when another card is clicked or tapped. */
	onDependencyLinkSelect: (taskId: string) => void;
} {
	const [draft, setDraft] = useState<DependencyLinkDraft | null>(null);
	const draftRef = useRef<DependencyLinkDraft | null>(null);
	const modifierPressedRef = useRef(false);

	const getValidTargetTaskId = useCallback(
		(sourceTaskId: string, targetTaskId: string | null): string | null => {
			if (!targetTaskId || targetTaskId === sourceTaskId) {
				return null;
			}
			if (canLinkTasks && !canLinkTasks(sourceTaskId, targetTaskId)) {
				return null;
			}
			return targetTaskId;
		},
		[canLinkTasks],
	);

	const completeDependencyLink = useCallback(
		(taskId: string | null): boolean => {
			const current = draftRef.current;
			const validTaskId = current ? getValidTargetTaskId(current.sourceTaskId, taskId) : null;
			if (!current || !validTaskId) {
				return false;
			}
			onCreateDependency?.(current.sourceTaskId, validTaskId);
			draftRef.current = null;
			setDraft(null);
			return true;
		},
		[getValidTargetTaskId, onCreateDependency],
	);

	const cancelDependencyLink = useCallback(() => {
		draftRef.current = null;
		setDraft(null);
	}, []);

	// Menu-driven linking ("Link to Task") parks a draft on the source card and
	// waits for a click/tap on the target instead of tracking a held modifier.
	const handleDependencyLinkStart = useCallback((taskId: string) => {
		const center = getTaskCenterPoint(taskId);
		const nextDraft: DependencyLinkDraft = {
			sourceTaskId: taskId,
			targetTaskId: null,
			pointerClientX: center?.clientX ?? 0,
			pointerClientY: center?.clientY ?? 0,
			armed: true,
		};
		draftRef.current = nextDraft;
		setDraft(nextDraft);
	}, []);

	const handleDependencyLinkSelect = useCallback(
		(taskId: string) => {
			const current = draftRef.current;
			if (!current?.armed) {
				return;
			}
			// Tapping the source again is the natural cancel gesture. Every other
			// target is handed to onCreateDependency unfiltered so an invalid pair
			// surfaces the same reason a CLI link failure would.
			if (taskId !== current.sourceTaskId) {
				onCreateDependency?.(current.sourceTaskId, taskId);
			}
			cancelDependencyLink();
		},
		[cancelDependencyLink, onCreateDependency],
	);

	useEffect(() => {
		draftRef.current = draft;
	}, [draft]);

	useEffect(() => {
		const handleKeyStateChange = (event: KeyboardEvent) => {
			modifierPressedRef.current = event.metaKey || event.ctrlKey;
		};
		const handleWindowBlur = () => {
			modifierPressedRef.current = false;
			draftRef.current = null;
			setDraft(null);
		};
		window.addEventListener("keydown", handleKeyStateChange);
		window.addEventListener("keyup", handleKeyStateChange);
		window.addEventListener("blur", handleWindowBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyStateChange);
			window.removeEventListener("keyup", handleKeyStateChange);
			window.removeEventListener("blur", handleWindowBlur);
		};
	}, []);

	const isLinking = draft !== null;

	useEffect(() => {
		if (!isLinking) {
			if (typeof document !== "undefined") {
				document.body.classList.remove("kb-dependency-link-mode");
			}
			return;
		}

		document.body.classList.add("kb-dependency-link-mode");

		const handleMouseMove = (event: MouseEvent) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const targetTaskId = getValidTargetTaskId(
					current.sourceTaskId,
					getTaskIdFromPoint(event.clientX, event.clientY),
				);
				const nextDraft = {
					...current,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
					targetTaskId,
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		};

		const handleMouseUp = (event: MouseEvent) => {
			const current = draftRef.current;
			if (!current) {
				return;
			}
			const resolvedTargetTaskId = getValidTargetTaskId(
				current.sourceTaskId,
				getTaskIdFromPoint(event.clientX, event.clientY) ?? current.targetTaskId,
			);
			// Armed drafts only end through an explicit target click, Escape, or a
			// click outside the board, so the mouseup that ends a tap is ignored.
			if (current.armed) {
				const armedDraft = {
					...current,
					targetTaskId: resolvedTargetTaskId ?? null,
					pointerClientX: event.clientX,
					pointerClientY: event.clientY,
				};
				draftRef.current = armedDraft;
				setDraft(armedDraft);
				return;
			}
			if (modifierPressedRef.current && completeDependencyLink(resolvedTargetTaskId ?? null)) {
				return;
			}
			if (!modifierPressedRef.current) {
				draftRef.current = null;
				setDraft(null);
				return;
			}
			const nextDraft = {
				...current,
				targetTaskId: resolvedTargetTaskId ?? null,
				pointerClientX: event.clientX,
				pointerClientY: event.clientY,
			};
			draftRef.current = nextDraft;
			setDraft(nextDraft);
		};

		const handleModifierRelease = (event: KeyboardEvent) => {
			if (event.metaKey || event.ctrlKey) {
				return;
			}
			modifierPressedRef.current = false;
			const current = draftRef.current;
			if (!current || current.armed) {
				return;
			}
			const resolvedTargetTaskId = getValidTargetTaskId(
				current.sourceTaskId,
				current.targetTaskId ?? getTaskIdFromPoint(current.pointerClientX, current.pointerClientY),
			);
			if (completeDependencyLink(resolvedTargetTaskId)) {
				return;
			}
			draftRef.current = null;
			setDraft(null);
		};

		const handleEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !draftRef.current?.armed) {
				return;
			}
			event.preventDefault();
			cancelDependencyLink();
		};

		const handleClickAway = (event: MouseEvent) => {
			if (!draftRef.current?.armed) {
				return;
			}
			const target = event.target;
			// Card clicks reach handleDependencyLinkSelect first; anything else
			// (empty column space, the navbar, dialogs) cancels the armed link.
			if (target instanceof Element && target.closest("[data-task-id]")) {
				return;
			}
			cancelDependencyLink();
		};

		window.addEventListener("mousemove", handleMouseMove);
		window.addEventListener("mouseup", handleMouseUp);
		window.addEventListener("keyup", handleModifierRelease);
		window.addEventListener("keydown", handleEscape);
		window.addEventListener("click", handleClickAway);
		return () => {
			document.body.classList.remove("kb-dependency-link-mode");
			window.removeEventListener("mousemove", handleMouseMove);
			window.removeEventListener("mouseup", handleMouseUp);
			window.removeEventListener("keyup", handleModifierRelease);
			window.removeEventListener("keydown", handleEscape);
			window.removeEventListener("click", handleClickAway);
		};
	}, [cancelDependencyLink, completeDependencyLink, getValidTargetTaskId, isLinking]);

	const handleDependencyPointerDown = useCallback((taskId: string, event: ReactMouseEvent<HTMLElement>) => {
		modifierPressedRef.current = event.metaKey || event.ctrlKey;
		setDraft((current) => {
			if (current?.sourceTaskId === taskId) {
				draftRef.current = null;
				return null;
			}
			const nextDraft = {
				sourceTaskId: taskId,
				targetTaskId: null,
				pointerClientX: event.clientX,
				pointerClientY: event.clientY,
				armed: false,
			};
			draftRef.current = nextDraft;
			return nextDraft;
		});
	}, []);

	const handleDependencyPointerEnter = useCallback(
		(taskId: string) => {
			setDraft((current) => {
				if (!current) {
					return current;
				}
				const nextDraft = {
					...current,
					targetTaskId: getValidTargetTaskId(current.sourceTaskId, taskId),
				};
				draftRef.current = nextDraft;
				return nextDraft;
			});
		},
		[getValidTargetTaskId],
	);

	return {
		draft,
		onDependencyPointerDown: handleDependencyPointerDown,
		onDependencyPointerEnter: handleDependencyPointerEnter,
		onDependencyLinkStart: handleDependencyLinkStart,
		onDependencyLinkSelect: handleDependencyLinkSelect,
	};
}
