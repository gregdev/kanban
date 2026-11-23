import * as RadixContextMenu from "@radix-ui/react-context-menu";
import type { LucideIcon } from "lucide-react";
import type { ComponentPropsWithoutRef, ElementRef, ReactNode } from "react";
import { forwardRef, Fragment } from "react";

import { cn } from "@/components/ui/cn";

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

export type ContextMenuItemVariant = "default" | "danger";

type ContextMenuItemElement = ElementRef<typeof RadixContextMenu.Item>;

export const ContextMenuItem = forwardRef<
	ContextMenuItemElement,
	ComponentPropsWithoutRef<typeof RadixContextMenu.Item> & { variant?: ContextMenuItemVariant }
>(function ContextMenuItem({ className, variant = "default", ...props }, ref) {
	return (
		<RadixContextMenu.Item
			ref={ref}
			className={cn(
				"flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none",
				"data-disabled:cursor-default data-disabled:opacity-50",
				"data-highlighted:bg-surface-3",
				variant === "danger" ? "text-status-red" : "text-text-primary",
				className,
			)}
			{...props}
		/>
	);
});

type ContextMenuSeparatorElement = ElementRef<typeof RadixContextMenu.Separator>;

export const ContextMenuSeparator = forwardRef<
	ContextMenuSeparatorElement,
	ComponentPropsWithoutRef<typeof RadixContextMenu.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
	return <RadixContextMenu.Separator ref={ref} className={cn("my-1 h-px bg-border", className)} {...props} />;
});

export interface ContextMenuItemSpec {
	id: string;
	label: string;
	icon?: LucideIcon;
	disabled?: boolean;
	danger?: boolean;
	onSelect: () => void;
}

export interface ContextMenuSectionSpec {
	id: string;
	items: ContextMenuItemSpec[];
}

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
	sections: ContextMenuSectionSpec[];
	children: ReactNode;
}): React.ReactElement {
	const populatedSections = sections.filter((section) => section.items.length > 0);
	if (populatedSections.length === 0) {
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
				{populatedSections.map((section, sectionIndex) => (
					<Fragment key={section.id}>
						{sectionIndex > 0 ? <ContextMenuSeparator /> : null}
						{section.items.map((item) => (
							<ContextMenuActionItem key={item.id} item={item} />
						))}
					</Fragment>
				))}
			</ContextMenuContent>
		</ContextMenu>
	);
}

function ContextMenuActionItem({ item }: { item: ContextMenuItemSpec }): React.ReactElement {
	const Icon = item.icon;
	return (
		<ContextMenuItem
			disabled={item.disabled}
			variant={item.danger ? "danger" : "default"}
			onSelect={() => {
				item.onSelect();
			}}
		>
			{Icon ? <Icon size={14} className="shrink-0" aria-hidden /> : null}
			<span className="truncate">{item.label}</span>
		</ContextMenuItem>
	);
}
