// Builds the view model for the native Cline chat panel.
// Keep panel-specific UI state here so the panel component can stay mostly
// declarative and shared across detail and sidebar surfaces.
import { useCallback, useEffect, useState } from "react";

import type { ClineChatActionResult } from "@/hooks/use-cline-chat-runtime-actions";
import { type ClineChatMessage, useClineChatSession } from "@/hooks/use-cline-chat-session";
import { usePersistedTextDraft } from "@/hooks/use-persisted-text-draft";
import type { RuntimeTaskImage, RuntimeTaskSessionMode, RuntimeTaskSessionSummary } from "@/runtime/types";
import { createTextDraftKey } from "@/storage/text-drafts";
import { useTaskWorkspaceSnapshotValue } from "@/stores/workspace-metadata-store";

interface UseClineChatPanelControllerInput {
	taskId: string;
	workspaceId?: string | null;
	summary: RuntimeTaskSessionSummary | null;
	taskColumnId?: string;
	onSendMessage?: (
		taskId: string,
		text: string,
		options?: { mode?: RuntimeTaskSessionMode; images?: RuntimeTaskImage[] },
	) => Promise<ClineChatActionResult>;
	onCancelTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onResumeTurn?: (taskId: string) => Promise<{ ok: boolean; message?: string }>;
	onLoadMessages?: (taskId: string) => Promise<ClineChatMessage[] | null>;
	incomingMessages?: ClineChatMessage[] | null;
	incomingMessage?: ClineChatMessage | null;
	onCommit?: () => void;
	onOpenPr?: () => void;
	onMoveToTrash?: () => void;
	onCancelAutomaticAction?: () => void;
	cancelAutomaticActionLabel?: string | null;
	showMoveToTrash?: boolean;
}

interface UseClineChatPanelControllerResult {
	draft: string;
	setDraft: (draft: string) => void;
	messages: ClineChatMessage[];
	error: string | null;
	isSending: boolean;
	isCanceling: boolean;
	isResuming: boolean;
	canSend: boolean;
	canCancel: boolean;
	canResumeTurn: boolean;
	showReviewActions: boolean;
	showAgentProgressIndicator: boolean;
	showActionFooter: boolean;
	showCancelAutomaticAction: boolean;
	handleSendText: (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleSendDraft: (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]) => Promise<boolean>;
	handleCancelTurn: () => void;
	handleResumeTurn: () => void;
}

function isResumableSummary(summary: RuntimeTaskSessionSummary | null): boolean {
	if (!summary) {
		return false;
	}
	if (summary.state === "interrupted") {
		return true;
	}
	return summary.state === "awaiting_review" && summary.reviewReason === "error";
}

function isCreditLimitSummary(summary: RuntimeTaskSessionSummary | null): boolean {
	return summary?.latestHookActivity?.notificationType === "credit_limit";
}

export function useClineChatPanelController({
	taskId,
	workspaceId = null,
	summary,
	taskColumnId = "in_progress",
	onSendMessage,
	onCancelTurn,
	onResumeTurn,
	onLoadMessages,
	incomingMessages = null,
	incomingMessage = null,
	onCommit,
	onOpenPr,
	onMoveToTrash,
	onCancelAutomaticAction,
	cancelAutomaticActionLabel,
	showMoveToTrash = false,
}: UseClineChatPanelControllerInput): UseClineChatPanelControllerResult {
	const draftScopeKey = createTextDraftKey({ kind: "agent-chat", workspaceId, taskId });
	const [draft, setDraft] = usePersistedTextDraft(draftScopeKey);
	const reviewWorkspaceSnapshot = useTaskWorkspaceSnapshotValue(taskId);
	const { messages, isSending, isCanceling, error, sendMessage, cancelTurn } = useClineChatSession({
		taskId,
		onSendMessage,
		onCancelTurn,
		onLoadMessages,
		incomingMessages,
		incomingMessage,
	});
	const [isResuming, setIsResuming] = useState(false);
	const [resumeError, setResumeError] = useState<string | null>(null);
	useEffect(() => {
		setResumeError(null);
		setIsResuming(false);
	}, [taskId]);
	const canSend = Boolean(onSendMessage) && !isSending && !isCanceling;
	const canCancel = Boolean(onCancelTurn) && summary?.state === "running" && !isCanceling;
	// Resume is only meaningful for a dead turn, and never for credit-limit and
	// auth failures, which cannot succeed by retrying the same turn.
	const canResumeTurn =
		Boolean(onResumeTurn) && !isResuming && isResumableSummary(summary) && !isCreditLimitSummary(summary);
	const showReviewActions =
		taskColumnId === "review" &&
		(reviewWorkspaceSnapshot?.changedFiles ?? 0) > 0 &&
		Boolean(onCommit) &&
		Boolean(onOpenPr);
	const showAgentProgressIndicator = summary?.state === "running";
	const showActionFooter = showMoveToTrash && Boolean(onMoveToTrash);
	const showCancelAutomaticAction = Boolean(cancelAutomaticActionLabel && onCancelAutomaticAction);

	const handleSendText = useCallback(
		async (text: string, mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			return sendMessage(
				text,
				mode || images?.length
					? {
							...(mode ? { mode } : {}),
							...(images?.length ? { images } : {}),
						}
					: undefined,
			);
		},
		[sendMessage],
	);

	const handleSendDraft = useCallback(
		async (mode?: RuntimeTaskSessionMode, images?: RuntimeTaskImage[]): Promise<boolean> => {
			const sent = await handleSendText(draft, mode, images);
			if (sent) {
				setDraft("");
			}
			return sent;
		},
		[draft, handleSendText],
	);

	const handleCancelTurn = useCallback(() => {
		void cancelTurn();
	}, [cancelTurn]);

	const handleResumeTurn = useCallback(() => {
		if (!onResumeTurn || !canResumeTurn) {
			return;
		}
		setResumeError(null);
		setIsResuming(true);
		void onResumeTurn(taskId)
			.then((result) => {
				if (!result.ok) {
					setResumeError(result.message ?? "Could not resume the interrupted turn.");
				}
			})
			.catch((resumeErrorValue: unknown) => {
				setResumeError(
					resumeErrorValue instanceof Error ? resumeErrorValue.message : "Could not resume the interrupted turn.",
				);
			})
			.finally(() => {
				setIsResuming(false);
			});
	}, [canResumeTurn, onResumeTurn, taskId]);

	return {
		draft,
		setDraft,
		messages,
		error: resumeError ?? error,
		isSending,
		isCanceling,
		isResuming,
		canSend,
		canCancel,
		canResumeTurn,
		showReviewActions,
		showAgentProgressIndicator,
		showActionFooter,
		showCancelAutomaticAction,
		handleSendText,
		handleSendDraft,
		handleCancelTurn,
		handleResumeTurn,
	};
}
