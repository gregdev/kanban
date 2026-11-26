import * as RadixDropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

import {
	getPopulatedMenuSections,
	type MenuItemSpec,
	MenuItemContent,
	menuItemClassName,
	MENU_SEPARATOR_CLASSNAME,
	type MenuSectionSpec,
	MenuSections,
} from "@/components/ui/menu-sections";

/**
 * Wraps a single trigger element in a click menu built from the same declarative
 * sections as `ContextMenuArea`. Touch users cannot reach a long-press context
 * menu when the surface they pressed also owns the long-press gesture, so a
 * visible trigger is the reliable way to expose those actions. When no section
 * has items the trigger is left untouched (no menu, no dead control).
 */
export function DropdownMenuArea({
	sections,
	children,
}: {
	sections: MenuSectionSpec[];
	children: ReactNode;
}): React.ReactElement {
	if (getPopulatedMenuSections(sections).length === 0) {
		return <>{children}</>;
	}

	return (
		<RadixDropdownMenu.Root>
			<RadixDropdownMenu.Trigger asChild>{children}</RadixDropdownMenu.Trigger>
			<RadixDropdownMenu.Portal>
				<RadixDropdownMenu.Content
					side="bottom"
					align="end"
					sideOffset={4}
					className="z-50 min-w-45 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg"
					style={{ animation: "kb-tooltip-show 100ms ease" }}
				>
					<MenuSections sections={sections} Item={DropdownMenuActionItem} Separator={DropdownMenuSeparator} />
				</RadixDropdownMenu.Content>
			</RadixDropdownMenu.Portal>
		</RadixDropdownMenu.Root>
	);
}

function DropdownMenuActionItem({ item }: { item: MenuItemSpec }): React.ReactElement {
	return (
		<RadixDropdownMenu.Item
			disabled={item.disabled}
			className={menuItemClassName(item.danger ? "danger" : "default")}
			onSelect={item.onSelect}
		>
			<MenuItemContent item={item} />
		</RadixDropdownMenu.Item>
	);
}

function DropdownMenuSeparator(): React.ReactElement {
	return <RadixDropdownMenu.Separator className={MENU_SEPARATOR_CLASSNAME} />;
}
