import * as RadixContextMenu from "@radix-ui/react-context-menu";
import type { ComponentPropsWithoutRef, ElementRef, ReactNode } from "react";
import { forwardRef } from "react";

import { cn } from "@/components/ui/cn";
import {
	getPopulatedMenuSections,
	type MenuItemSpec,
	type MenuItemVariant,
	MenuItemContent,
	menuItemClassName,
	MENU_SEPARATOR_CLASSNAME,
	type MenuSectionSpec,
	MenuSections,
} from "@/components/ui/menu-sections";

export const ContextMenu = RadixContextMenu.Root;
export const ContextMenuTrigger = RadixContextMenu.Trigger;

type ContextMenuContentElement = ElementRef<typeof RadixContextMenu.Content>;

export const ContextMenuContent = forwardRef<
	ContextMenuContentElement,
	ComponentPropsWithoutRef<typeof RadixContextMenu.Content>
>(function ContextMenuContent({ className, style, ...props }, ref) {
	return (
		<RadixContextMenu.Portal>
			<RadixContextMenu.Content
				ref={ref}
				className={cn("z-50 min-w-45 rounded-md border border-border-bright bg-surface-1 p-1 shadow-lg", className)}
				style={{ animation: "kb-tooltip-show 100ms ease", ...style }}
				{...props}
			/>
		</RadixContextMenu.Portal>
	);
});

export type ContextMenuItemVariant = MenuItemVariant;

/**
 * The shared menu spec types live in `@/components/ui/menu-sections` because
 * several surfaces render the same actions. They are re-exported here so
 * right-click-only call sites keep importing from the surface they use.
 */
export type ContextMenuItemSpec = MenuItemSpec;
export type ContextMenuSectionSpec = MenuSectionSpec;

type ContextMenuItemElement = ElementRef<typeof RadixContextMenu.Item>;

export const ContextMenuItem = forwardRef<
	ContextMenuItemElement,
	ComponentPropsWithoutRef<typeof RadixContextMenu.Item> & { variant?: ContextMenuItemVariant }
>(function ContextMenuItem({ className, variant = "default", ...props }, ref) {
	return <RadixContextMenu.Item ref={ref} className={menuItemClassName(variant, className)} {...props} />;
});

type ContextMenuSeparatorElement = ElementRef<typeof RadixContextMenu.Separator>;

export const ContextMenuSeparator = forwardRef<
	ContextMenuSeparatorElement,
	ComponentPropsWithoutRef<typeof RadixContextMenu.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
	return <RadixContextMenu.Separator ref={ref} className={cn(MENU_SEPARATOR_CLASSNAME, className)} {...props} />;
});

/**
 * Wraps a single trigger element in a right-click menu built from declarative
 * sections. Sections render in order with a separator between them, and empty
 * sections are dropped so callers can compose conditional action lists without
 * checking emptiness first. When no section has items the trigger is left
 * untouched (no menu, native behaviour preserved).
 */
export function ContextMenuArea({
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
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent
				onCloseAutoFocus={(event) => {
					event.preventDefault();
				}}
			>
				<MenuSections sections={sections} Item={ContextMenuActionItem} Separator={ContextMenuSeparator} />
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ContextMenuActionItem({ item }: { item: MenuItemSpec }): React.ReactElement {
	return (
		<ContextMenuItem disabled={item.disabled} variant={item.danger ? "danger" : "default"} onSelect={item.onSelect}>
			<MenuItemContent item={item} />
		</ContextMenuItem>
	);
}
