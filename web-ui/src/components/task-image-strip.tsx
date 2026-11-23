import { Copy, Trash2, X } from "lucide-react";
import type { ReactElement } from "react";
import { cn } from "@/components/ui/cn";
import { ContextMenuArea, type ContextMenuSectionSpec } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { TaskImage } from "@/types";
import { copyTextToClipboard } from "@/utils/clipboard";

interface TaskImageStripProps {
	images: TaskImage[];
	onRemoveImage?: (imageId: string) => void;
	className?: string;
	label?: string | null;
}

function buildImageMenuSections(image: TaskImage, onRemoveImage?: (imageId: string) => void): ContextMenuSectionSpec[] {
	const sections: ContextMenuSectionSpec[] = [];
	if (onRemoveImage) {
		sections.push({
			id: "remove",
			items: [
				{
					id: "remove",
					label: "Remove image",
					icon: Trash2,
					danger: true,
					onSelect: () => onRemoveImage(image.id),
				},
			],
		});
	}
	sections.push({
		id: "copy",
		items: [
			{
				id: "copy-name",
				label: "Copy file name",
				icon: Copy,
				disabled: !image.name,
				onSelect: () => {
					if (image.name) {
						void copyTextToClipboard(image.name, "File name copied");
					}
				},
			},
		],
	});
	return sections;
}

export function TaskImageStrip({
	images,
	onRemoveImage,
	className,
	label = null,
}: TaskImageStripProps): ReactElement | null {
	if (images.length === 0) {
		return null;
	}

	return (
		<div className={className}>
			{label ? (
				<div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-text-tertiary">{label}</div>
			) : null}
			<div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
				{images.map((image) => (
					<ContextMenuArea key={image.id} sections={buildImageMenuSections(image, onRemoveImage)}>
						<div
							className={cn(
								"group inline-flex max-w-65 min-w-0 items-center gap-1.5 rounded-md border border-border-bright bg-surface-2 px-1.5 py-1",
								onRemoveImage && "hover:border-border-focus",
							)}
						>
							<img
								src={`data:${image.mimeType};base64,${image.data}`}
								alt={image.name ?? "attached image"}
								className="h-5 w-5 rounded object-cover"
							/>
							<span className="min-w-0 max-w-32 truncate text-[11px] text-text-secondary">
								{image.name ?? "Image"}
							</span>
							{onRemoveImage ? (
								<Tooltip content="Remove image" side="bottom">
									<button
										type="button"
										onClick={() => onRemoveImage(image.id)}
										aria-label={`Remove ${image.name ?? "image"}`}
										className="shrink-0 cursor-pointer rounded-sm p-0 text-text-tertiary hover:text-status-red focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
									>
										<X size={12} />
									</button>
								</Tooltip>
							) : null}
						</div>
					</ContextMenuArea>
				))}
			</div>
		</div>
	);
}
