import { type DragEvent, useCallback, useState } from "react";

import { collectImageFilesFromDataTransfer, extractImagesFromDataTransfer } from "@/components/task-image-input-utils";
import type { TaskImage } from "@/types";

export interface UseComposerImageAttachmentsOptions {
	images: readonly TaskImage[];
	/** When omitted, image attachments are disabled and drops/pastes are ignored. */
	onImagesChange?: (images: TaskImage[]) => void;
}

export interface ComposerImageAttachments {
	isDragOver: boolean;
	appendImages: (images: readonly TaskImage[]) => void;
	removeImage: (imageId: string) => void;
	handleDragEnter: (event: DragEvent<HTMLElement>) => void;
	handleDragOver: (event: DragEvent<HTMLElement>) => void;
	handleDragLeave: (event: DragEvent<HTMLElement>) => void;
	handleDrop: (event: DragEvent<HTMLElement>) => void;
	/**
	 * Intercepts a paste that carries image files. Returns true when the paste was
	 * consumed (the caller should not insert the pasted text).
	 */
	handlePaste: (data: DataTransfer | null) => boolean;
}

function carriesFiles(data: DataTransfer | null): boolean {
	return Boolean(data && Array.from(data.types).includes("Files"));
}

/**
 * Paste, drop and removal of attached images, shared by every prompt composer
 * (agent chat, new task, inline card).
 */
export function useComposerImageAttachments({
	images,
	onImagesChange,
}: UseComposerImageAttachmentsOptions): ComposerImageAttachments {
	const [isDragOver, setIsDragOver] = useState(false);

	const appendImages = useCallback(
		(nextImages: readonly TaskImage[]) => {
			if (!onImagesChange || nextImages.length === 0) {
				return;
			}
			onImagesChange([...images, ...nextImages]);
		},
		[images, onImagesChange],
	);

	const removeImage = useCallback(
		(imageId: string) => {
			onImagesChange?.(images.filter((image) => image.id !== imageId));
		},
		[images, onImagesChange],
	);

	const handlePaste = useCallback(
		(data: DataTransfer | null): boolean => {
			if (!onImagesChange || !carriesFiles(data) || !data) {
				return false;
			}
			const imageFiles = collectImageFilesFromDataTransfer(data);
			if (imageFiles.length === 0) {
				return false;
			}
			void (async () => {
				appendImages(await extractImagesFromDataTransfer(data));
			})();
			return true;
		},
		[appendImages, onImagesChange],
	);

	const handleDragEnter = useCallback(
		(event: DragEvent<HTMLElement>) => {
			if (!onImagesChange || !carriesFiles(event.dataTransfer)) {
				return;
			}
			event.preventDefault();
			setIsDragOver(true);
		},
		[onImagesChange],
	);

	const handleDragOver = useCallback(
		(event: DragEvent<HTMLElement>) => {
			if (!onImagesChange || !carriesFiles(event.dataTransfer)) {
				return;
			}
			event.preventDefault();
			setIsDragOver(true);
		},
		[onImagesChange],
	);

	const handleDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
		// Only clear the state when actually leaving the drop zone rather than
		// moving between children inside it.
		if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
			return;
		}
		setIsDragOver(false);
	}, []);

	const handleDrop = useCallback(
		(event: DragEvent<HTMLElement>) => {
			setIsDragOver(false);
			if (!onImagesChange || !carriesFiles(event.dataTransfer)) {
				return;
			}
			event.preventDefault();
			void (async () => {
				appendImages(await extractImagesFromDataTransfer(event.dataTransfer));
			})();
		},
		[appendImages, onImagesChange],
	);

	return {
		isDragOver,
		appendImages,
		removeImage,
		handleDragEnter,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	};
}
