import { ImagePlus, Paperclip } from "lucide-react";
import type { ChangeEvent, ReactElement } from "react";
import { useCallback, useRef, useState } from "react";

import { type InlineCompletionItem, InlineCompletionPicker } from "@/components/inline-completion-picker";
import { PromptCodeEditor, type PromptCodeEditorHandle } from "@/components/prompt-composer/prompt-code-editor";
import { useComposerCompletion } from "@/components/prompt-composer/use-composer-completion";
import { useComposerImageAttachments } from "@/components/prompt-composer/use-composer-image-attachments";
import { ACCEPTED_TASK_IMAGE_INPUT_ACCEPT, fileToTaskImage } from "@/components/task-image-input-utils";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { TaskImage } from "@/types";

const TEXTAREA_MAX_HEIGHT = 200;
const TEXTAREA_MIN_HEIGHT = 80;

interface TaskPromptComposerProps {
	id?: string;
	value: string;
	onValueChange: (value: string) => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	onSubmit?: () => void;
	onSubmitAndStart?: () => void;
	onEscape?: () => void;
	placeholder?: string;
	disabled?: boolean;
	enabled?: boolean;
	autoFocus?: boolean;
	workspaceId?: string | null;
	showAttachImageButton?: boolean;
}

export function TaskPromptComposer({
	id,
	value,
	onValueChange,
	images = [],
	onImagesChange,
	onSubmit,
	onSubmitAndStart,
	onEscape,
	placeholder,
	disabled,
	enabled = true,
	autoFocus = false,
	workspaceId = null,
	showAttachImageButton = true,
}: TaskPromptComposerProps): ReactElement {
	const editorRef = useRef<PromptCodeEditorHandle | null>(null);
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const [cursorIndex, setCursorIndex] = useState(0);
	const attachments = useComposerImageAttachments({ images, onImagesChange });
	const isEditorDisabled = Boolean(disabled);

	const applyCompletion = useCallback(
		(result: { value: string; cursor: number }) => {
			const editor = editorRef.current;
			if (!editor) {
				onValueChange(result.value);
				return;
			}
			editor.setContent(result.value, result.cursor);
		},
		[onValueChange],
	);

	const completion = useComposerCompletion({
		value,
		cursorIndex,
		workspaceId,
		enabled,
		onApplyCompletion: applyCompletion,
	});

	const completionItems: InlineCompletionItem[] = completion.suggestions.map((suggestion) => ({
		id: suggestion.id,
		label: suggestion.id,
	}));

	const handleEditorKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				if (event.shiftKey && onSubmitAndStart) {
					onSubmitAndStart();
					return true;
				}
				onSubmit?.();
				return true;
			}
			if (completion.handleCompletionKeyDown(event)) {
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				onEscape?.();
				return true;
			}
			return false;
		},
		[completion, onEscape, onSubmit, onSubmitAndStart],
	);

	const handleAttachClick = useCallback(() => {
		fileInputRef.current?.click();
	}, []);

	const handleFileInputChange = useCallback(
		(event: ChangeEvent<HTMLInputElement>) => {
			if (!onImagesChange || !event.currentTarget.files) {
				return;
			}
			const files = Array.from(event.currentTarget.files);
			void (async () => {
				const newImages: TaskImage[] = [];
				for (const file of files) {
					const image = await fileToTaskImage(file);
					if (image) {
						newImages.push(image);
					}
				}
				attachments.appendImages(newImages);
				event.currentTarget.value = "";
			})();
		},
		[attachments, onImagesChange],
	);

	return (
		<div id={id}>
			<div
				className="relative"
				onDrop={attachments.handleDrop}
				onDragOver={attachments.handleDragOver}
				onDragEnter={attachments.handleDragEnter}
				onDragLeave={attachments.handleDragLeave}
			>
				<InlineCompletionPicker
					open={completion.showPicker}
					items={completionItems}
					selectedIndex={completion.selectedIndex}
					onSelectItem={(item) => completion.selectItem(item.id)}
					onHoverItem={completion.setSelectedIndex}
					isLoading={completion.isLoading}
					loadingMessage={completion.loadingMessage}
					emptyMessage={completion.emptyMessage}
				>
					<div
						className={cn(
							"rounded-md border bg-surface-3 p-3 text-[13px] text-text-primary focus-within:border-border-focus",
							attachments.isDragOver ? "border-accent border-dashed" : "border-border-bright",
						)}
					>
						<PromptCodeEditor
							ref={editorRef}
							value={value}
							onChange={onValueChange}
							onSelectionChange={setCursorIndex}
							onKeyDown={handleEditorKeyDown}
							onPaste={(event) => attachments.handlePaste(event.clipboardData)}
							placeholder={placeholder ?? "Describe the task"}
							ariaLabel={placeholder ?? "Describe the task"}
							disabled={isEditorDisabled}
							autoFocus={autoFocus}
							minHeight={TEXTAREA_MIN_HEIGHT}
							maxHeight={TEXTAREA_MAX_HEIGHT}
						/>
					</div>
				</InlineCompletionPicker>
				{attachments.isDragOver ? (
					<div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-md bg-accent/5">
						<div className="flex items-center gap-1.5 text-[12px] text-accent font-medium">
							<ImagePlus size={14} />
							<span>Drop image here</span>
						</div>
					</div>
				) : null}
			</div>

			{images.length > 0 ? (
				<TaskImageStrip images={images} onRemoveImage={attachments.removeImage} className="mt-1.5" />
			) : null}

			{onImagesChange && showAttachImageButton ? (
				<>
					<input
						ref={fileInputRef}
						type="file"
						accept={ACCEPTED_TASK_IMAGE_INPUT_ACCEPT}
						multiple
						className="hidden"
						onChange={handleFileInputChange}
					/>
					<div className={images.length > 0 ? "mt-1" : "mt-1.5"}>
						<Button
							variant="ghost"
							size="sm"
							icon={<Paperclip size={14} />}
							onClick={handleAttachClick}
							disabled={isEditorDisabled || !enabled}
						>
							Attach image
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}
