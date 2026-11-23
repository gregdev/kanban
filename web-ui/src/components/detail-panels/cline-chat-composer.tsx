import { AlertTriangle, ArrowBigUp, Command, SendHorizontal, Square } from "lucide-react";
import { type ReactElement, useCallback, useEffect, useRef, useState } from "react";

import { ClineChatModelSelector } from "@/components/detail-panels/cline-chat-model-selector";
import { type InlineCompletionItem, InlineCompletionPicker } from "@/components/inline-completion-picker";
import { PromptCodeEditor, type PromptCodeEditorHandle } from "@/components/prompt-composer/prompt-code-editor";
import { useComposerCompletion } from "@/components/prompt-composer/use-composer-completion";
import { useComposerImageAttachments } from "@/components/prompt-composer/use-composer-image-attachments";
import type { SearchSelectOption } from "@/components/search-select-dropdown";
import { TaskImageStrip } from "@/components/task-image-strip";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip } from "@/components/ui/tooltip";
import type { RuntimeClineReasoningEffort, RuntimeTaskSessionMode } from "@/runtime/types";
import type { TaskImage } from "@/types";
import { isMacPlatform } from "@/utils/platform";

const CLINE_CHAT_COMPOSER_MAX_HEIGHT = 160;
const CLINE_CHAT_COMPOSER_MIN_HEIGHT = 24;

export function ClineChatComposer({
	taskId,
	draft,
	onDraftChange,
	images = [],
	onImagesChange,
	placeholder,
	mode,
	onModeChange,
	showModeToggle = true,
	canSend,
	canCancel,
	onSend,
	onCancel,
	modelOptions,
	recommendedModelIds = [],
	pinSelectedModelToTop = true,
	selectedModelId,
	selectedModelButtonText,
	onSelectModel,
	reasoningEnabledModelIds = [],
	selectedReasoningEffort,
	onSelectReasoningEffort,
	isModelLoading = false,
	isModelSaving = false,
	modelPickerDisabled = false,
	isSending = false,
	warningMessage = null,
	attachmentWarningMessage = null,
	workspaceId = null,
}: {
	taskId: string;
	draft: string;
	onDraftChange: (draft: string) => void;
	images?: TaskImage[];
	onImagesChange?: (images: TaskImage[]) => void;
	placeholder: string;
	mode: RuntimeTaskSessionMode;
	onModeChange: (mode: RuntimeTaskSessionMode) => void;
	showModeToggle?: boolean;
	canSend: boolean;
	canCancel: boolean;
	onSend: () => void | Promise<void>;
	onCancel: () => void;
	modelOptions: readonly SearchSelectOption[];
	recommendedModelIds?: readonly string[];
	pinSelectedModelToTop?: boolean;
	selectedModelId: string;
	selectedModelButtonText: string;
	onSelectModel: (value: string) => void;
	reasoningEnabledModelIds?: readonly string[];
	selectedReasoningEffort: RuntimeClineReasoningEffort | "";
	onSelectReasoningEffort: (value: RuntimeClineReasoningEffort | "") => void;
	isModelLoading?: boolean;
	isModelSaving?: boolean;
	modelPickerDisabled?: boolean;
	isSending?: boolean;
	warningMessage?: string | null;
	attachmentWarningMessage?: string | null;
	workspaceId?: string | null;
}): ReactElement {
	const editorRef = useRef<PromptCodeEditorHandle | null>(null);
	const [cursorIndex, setCursorIndex] = useState(() => draft.length);
	const canSubmit = canSend && !isModelSaving && (draft.trim().length > 0 || images.length > 0);
	const attachments = useComposerImageAttachments({ images, onImagesChange });

	const applyCompletion = useCallback(
		(result: { value: string; cursor: number }) => {
			const editor = editorRef.current;
			if (!editor) {
				onDraftChange(result.value);
				return;
			}
			editor.setContent(result.value, result.cursor);
		},
		[onDraftChange],
	);

	const completion = useComposerCompletion({
		value: draft,
		cursorIndex,
		workspaceId,
		enableSlashCommands: true,
		onApplyCompletion: applyCompletion,
	});

	const completionItems: InlineCompletionItem[] = completion.suggestions.map((suggestion) => ({
		id: suggestion.id,
		label: suggestion.label,
		detail: suggestion.detail,
	}));

	useEffect(() => {
		if (!canSend) {
			return;
		}
		// Skip auto-focus on mobile to prevent iOS Safari viewport shift
		if (window.matchMedia("(max-width: 768px)").matches) {
			return;
		}
		editorRef.current?.focus();
	}, [canSend, taskId]);

	useEffect(() => {
		setCursorIndex((current) => Math.min(current, draft.length));
	}, [draft.length]);

	const handleEditorKeyDown = useCallback(
		(event: KeyboardEvent) => {
			if (completion.handleCompletionKeyDown(event)) {
				return true;
			}
			if (
				showModeToggle &&
				(event.metaKey || event.ctrlKey) &&
				event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "a"
			) {
				event.preventDefault();
				onModeChange(mode === "plan" ? "act" : "plan");
				return true;
			}
			if (event.key === "Escape") {
				if (!canCancel) {
					return false;
				}
				event.preventDefault();
				onCancel();
				return true;
			}
			if (event.key !== "Enter" || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
				return false;
			}
			if (!canSubmit) {
				return false;
			}
			event.preventDefault();
			void onSend();
			return true;
		},
		[canCancel, canSubmit, completion, mode, onCancel, onModeChange, onSend, showModeToggle],
	);

	return (
		<div
			className={cn(
				"rounded-xl border border-border bg-surface-2 px-3 py-2 focus-within:border-border-focus",
				attachments.isDragOver && "border-border-focus bg-surface-3/50",
			)}
			onDragEnter={attachments.handleDragEnter}
			onDragOver={attachments.handleDragOver}
			onDragLeave={attachments.handleDragLeave}
			onDrop={attachments.handleDrop}
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
				side="top"
			>
				<div className="min-w-0">
					<PromptCodeEditor
						ref={editorRef}
						value={draft}
						onChange={onDraftChange}
						onSelectionChange={setCursorIndex}
						onKeyDown={handleEditorKeyDown}
						onPaste={(event) => attachments.handlePaste(event.clipboardData)}
						placeholder={placeholder}
						ariaLabel={placeholder}
						disabled={!canSend}
						minHeight={CLINE_CHAT_COMPOSER_MIN_HEIGHT}
						maxHeight={CLINE_CHAT_COMPOSER_MAX_HEIGHT}
						className="text-sm leading-5 text-text-primary"
					/>
				</div>
			</InlineCompletionPicker>
			{images.length > 0 ? (
				<TaskImageStrip images={images} onRemoveImage={attachments.removeImage} className="mt-2" />
			) : null}
			<div className="mt-2 flex min-w-0 items-center gap-2">
				<div className="min-w-0 shrink overflow-hidden">
					<ClineChatModelSelector
						modelOptions={modelOptions}
						recommendedModelIds={recommendedModelIds}
						pinSelectedModelToTop={pinSelectedModelToTop}
						selectedModelId={selectedModelId}
						selectedModelButtonText={selectedModelButtonText}
						onSelectModel={onSelectModel}
						reasoningEnabledModelIds={reasoningEnabledModelIds}
						selectedReasoningEffort={selectedReasoningEffort}
						onSelectReasoningEffort={onSelectReasoningEffort}
						disabled={modelPickerDisabled}
						isModelLoading={isModelLoading}
						isModelSaving={isModelSaving}
					/>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-2">
					{showModeToggle ? (
						<Tooltip
							side="top"
							content={
								<span className="inline-flex items-center gap-1.5 whitespace-nowrap">
									<span>Toggle</span>
									<span className="inline-flex items-center gap-0.5 whitespace-nowrap">
										<span>(</span>
										{isMacPlatform ? <Command size={11} /> : <span>Ctrl</span>}
										<span>+</span>
										<ArrowBigUp size={11} />
										<span>+ A)</span>
									</span>
								</span>
							}
						>
							<div
								className="inline-flex h-7 shrink-0 items-center rounded-md border border-border-bright bg-surface-3 p-0.5"
								role="tablist"
								aria-label="Cline mode"
							>
								<button
									type="button"
									role="tab"
									aria-selected={mode === "plan"}
									className={cn(
										"h-5 rounded-sm px-2 text-[11px] font-medium hover:cursor-pointer",
										mode === "plan"
											? "bg-surface-1 text-text-primary"
											: "text-text-secondary hover:bg-surface-4 hover:text-text-primary",
									)}
									onClick={() => onModeChange("plan")}
								>
									Plan
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={mode === "act"}
									className={cn(
										"h-5 rounded-sm px-2 text-[11px] font-medium hover:cursor-pointer",
										mode === "act"
											? "bg-surface-1 text-text-primary"
											: "text-text-secondary hover:bg-surface-4 hover:text-text-primary",
									)}
									onClick={() => onModeChange("act")}
								>
									Act
								</button>
							</div>
						</Tooltip>
					) : null}
					{canCancel ? (
						<Tooltip side="top" content={<span className="whitespace-nowrap">Stop the agent (Esc)</span>}>
							<Button
								variant="danger"
								size="sm"
								className="h-7 w-7 rounded-full p-0"
								aria-label="Stop agent"
								onClick={onCancel}
								icon={<Square size={12} fill="currentColor" />}
							/>
						</Tooltip>
					) : null}
					<Tooltip
						side="top"
						content={
							<span className="whitespace-nowrap">
								{canCancel ? "Queue message — read after this turn" : "Send message"}
							</span>
						}
					>
						<Button
							variant="default"
							size="sm"
							className="h-7 w-7 rounded-full border-border-bright bg-surface-4 p-0 text-text-primary hover:bg-surface-3"
							aria-label={canCancel ? "Queue message" : "Send message"}
							disabled={!canSubmit}
							onClick={() => {
								void onSend();
							}}
							icon={isSending ? <Spinner size={12} /> : <SendHorizontal size={14} />}
						/>
					</Tooltip>
				</div>
			</div>
			{warningMessage ? (
				<div className="mt-2 flex items-start gap-1.5 text-xs text-status-orange" title={warningMessage}>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" />
					<p
						className="m-0 min-w-0"
						style={{
							display: "-webkit-box",
							WebkitBoxOrient: "vertical",
							WebkitLineClamp: 2,
							overflow: "hidden",
						}}
					>
						{warningMessage}
					</p>
				</div>
			) : null}
			{attachmentWarningMessage ? (
				<div className="mt-2 flex items-start gap-1.5 text-xs text-status-orange" title={attachmentWarningMessage}>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" />
					<p className="m-0 min-w-0">{attachmentWarningMessage}</p>
				</div>
			) : null}
		</div>
	);
}
