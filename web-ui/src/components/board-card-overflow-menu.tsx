import { MoreVertical } from "lucide-react";
import type { MouseEvent } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { DropdownMenuArea } from "@/components/ui/dropdown-menu";
import { getPopulatedMenuSections, type MenuSectionSpec } from "@/components/ui/menu-sections";
import { useIsMobile } from "@/hooks/use-is-mobile";

/**
 * The card's overflow menu. It renders exactly the sections of the card's
 * right-click context menu: on touch the card's long-press belongs to the drag
 * sensor, so the context menu is unreachable and this button is the only way to
 * reach those actions.
 */
export function BoardCardOverflowMenu({ sections }: { sections: MenuSectionSpec[] }): React.ReactElement | null {
	const isMobile = useIsMobile();

	// Rendering the control without a menu would leave a dead button on the card.
	if (getPopulatedMenuSections(sections).length === 0) {
		return null;
	}

	// The card shell opens the task on click (and the drag sensor watches it), so
	// the overflow control must keep its pointer events to itself.
	const stopCardEvent = (event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		event.stopPropagation();
	};

	return (
		<DropdownMenuArea sections={sections}>
			<Button
				variant="ghost"
				size="sm"
				icon={<MoreVertical size={14} />}
				aria-label="Task actions"
				onMouseDown={stopCardEvent}
				onClick={stopCardEvent}
				className={cn(
					"shrink-0",
					isMobile
						? "h-9 w-9"
						: "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100",
				)}
			/>
		</DropdownMenuArea>
	);
}
