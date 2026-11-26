import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";
import { Fragment } from "react";

import { cn } from "@/components/ui/cn";

export type MenuItemVariant = "default" | "danger";

export interface MenuItemSpec {
	id: string;
	label: string;
	icon?: LucideIcon;
	disabled?: boolean;
	danger?: boolean;
	onSelect: () => void;
}

export interface MenuSectionSpec {
	id: string;
	items: MenuItemSpec[];
}

/**
 * Item styling shared by every menu surface. A card exposes one action list to
 * both its right-click menu and its dropdown menu, so the class names live here
 * instead of in either surface and the two cannot drift apart.
 */
export function menuItemClassName(variant: MenuItemVariant = "default", className?: string): string {
	return cn(
		"flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none",
		"data-disabled:cursor-default data-disabled:opacity-50",
		"data-highlighted:bg-surface-3",
		variant === "danger" ? "text-status-red" : "text-text-primary",
		className,
	);
}

export const MENU_SEPARATOR_CLASSNAME = "my-1 h-px bg-border";

/**
 * Drops empty sections so callers can compose conditional action lists without
 * checking emptiness first.
 */
export function getPopulatedMenuSections(sections: MenuSectionSpec[]): MenuSectionSpec[] {
	return sections.filter((section) => section.items.length > 0);
}

export function MenuItemContent({ item }: { item: MenuItemSpec }): React.ReactElement {
	const Icon = item.icon;
	return (
		<>
			{Icon ? <Icon size={14} className="shrink-0" aria-hidden /> : null}
			<span className="truncate">{item.label}</span>
		</>
	);
}

/**
 * Renders declarative sections in order with a separator between them. `Item`
 * supplies the primitive-specific menu item (context menu vs dropdown menu) and
 * `Separator` the primitive-specific separator, so both surfaces consume a
 * single action list definition.
 */
export function MenuSections({
	sections,
	Item,
	Separator,
}: {
	sections: MenuSectionSpec[];
	Item: ComponentType<{ item: MenuItemSpec }>;
	Separator?: ComponentType;
}): React.ReactElement {
	return (
		<>
			{getPopulatedMenuSections(sections).map((section, sectionIndex) => (
				<Fragment key={section.id}>
					{sectionIndex > 0 && Separator ? <Separator /> : null}
					{section.items.map((item) => (
						<Item key={item.id} item={item} />
					))}
				</Fragment>
			))}
		</>
	);
}
