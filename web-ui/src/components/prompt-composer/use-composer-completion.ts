import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
	type ActiveClineComposerToken,
	applyClineComposerCompletion,
	buildMentionInsertText,
	buildSlashCommandInsertText,
	type ClineComposerCompletionSuggestion,
	detectActiveClineComposerToken,
} from "@/components/detail-panels/cline-chat-composer-completion";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type { RuntimeSlashCommand } from "@/runtime/types";
import { useDebouncedEffect } from "@/utils/react-use";

const DEFAULT_MENTION_LIMIT = 8;
const DEFAULT_SLASH_LIMIT = 8;
const COMPLETION_QUERY_DEBOUNCE_MS = 120;

/**
 * The subset of a keyboard event the completion picker cares about. Both React
 * synthetic events and native DOM events satisfy this structurally.
 */
export interface ComposerCompletionKeyEvent {
	key: string;
	shiftKey: boolean;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	preventDefault: () => void;
}

export interface UseComposerCompletionOptions {
	value: string;
	cursorIndex: number;
	workspaceId: string | null;
	/** When false the picker is suppressed and no lookups run. */
	enabled?: boolean;
	/** Enables `/command` suggestions in addition to `@file` mentions. */
	enableSlashCommands?: boolean;
	mentionLimit?: number;
	slashLimit?: number;
	/** Receives the rewritten draft plus the caret offset that should follow it. */
	onApplyCompletion: (result: { value: string; cursor: number }) => void;
}

export interface ComposerCompletionState {
	activeToken: ActiveClineComposerToken | null;
	suggestions: readonly ClineComposerCompletionSuggestion[];
	/** True when there is an active token and the user has not dismissed the picker. */
	showPicker: boolean;
	selectedIndex: number;
	isLoading: boolean;
	loadingMessage: string;
	emptyMessage: string | null;
	setSelectedIndex: (index: number) => void;
	selectItem: (id: string) => void;
	/** Dismiss the picker for the current token, or reopen it. */
	setPickerOpen: (open: boolean) => void;
	/**
	 * Arrow-key navigation and acceptance for the open picker. Returns true when
	 * the key was consumed.
	 */
	handleCompletionKeyDown: (event: ComposerCompletionKeyEvent) => boolean;
}

/**
 * Mention and slash-command completion shared by every prompt composer.
 *
 * The two composers differ only in presentation (which fields they show in the
 * picker) and in whether slash commands are available, so all of the token
 * detection, lookup, debouncing and key handling lives here.
 */
export function useComposerCompletion({
	value,
	cursorIndex,
	workspaceId,
	enabled = true,
	enableSlashCommands = false,
	mentionLimit = DEFAULT_MENTION_LIMIT,
	slashLimit = DEFAULT_SLASH_LIMIT,
	onApplyCompletion,
}: UseComposerCompletionOptions): ComposerCompletionState {
	const mentionRequestIdRef = useRef(0);
	const slashRequestIdRef = useRef(0);
	const slashCacheRef = useRef(new Map<string, RuntimeSlashCommand[]>());
	const [mentionSuggestions, setMentionSuggestions] = useState<ClineComposerCompletionSuggestion[]>([]);
	const [slashSuggestions, setSlashSuggestions] = useState<ClineComposerCompletionSuggestion[]>([]);
	const [isMentionLoading, setIsMentionLoading] = useState(false);
	const [isSlashLoading, setIsSlashLoading] = useState(false);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [isPickerOpen, setIsPickerOpen] = useState(true);

	const activeToken = useMemo(() => {
		if (!enabled) {
			return null;
		}
		const token = detectActiveClineComposerToken(value, cursorIndex);
		if (token && token.kind === "slash" && !enableSlashCommands) {
			return null;
		}
		return token;
	}, [cursorIndex, enableSlashCommands, enabled, value]);

	const suggestions = useMemo(
		() => (activeToken?.kind === "mention" ? mentionSuggestions : slashSuggestions),
		[activeToken, mentionSuggestions, slashSuggestions],
	);

	const showPicker = Boolean(activeToken && isPickerOpen);
	const isLoading = activeToken?.kind === "mention" ? isMentionLoading : isSlashLoading;
	const loadingMessage = activeToken?.kind === "mention" ? "Loading files..." : "Loading commands...";
	const emptyMessage = useMemo(() => {
		if (!activeToken) {
			return null;
		}
		if (activeToken.kind === "mention") {
			return workspaceId ? "No matching files." : "Select a workspace to mention files.";
		}
		return "No matching commands.";
	}, [activeToken, workspaceId]);

	// A new token starts a fresh list at the top with the picker open.
	useEffect(() => {
		setSelectedIndex(0);
		setIsPickerOpen(true);
	}, [activeToken?.kind, activeToken?.query, activeToken?.start]);

	useEffect(() => {
		setSelectedIndex((current) => (current < suggestions.length ? current : 0));
	}, [suggestions.length]);

	// Drop stale results as soon as the token stops matching a lookup.
	useEffect(() => {
		if (activeToken?.kind !== "mention") {
			mentionRequestIdRef.current += 1;
			setMentionSuggestions([]);
			setIsMentionLoading(false);
		}
		if (activeToken?.kind !== "slash") {
			slashRequestIdRef.current += 1;
			setSlashSuggestions([]);
			setIsSlashLoading(false);
		}
	}, [activeToken]);

	useDebouncedEffect(
		() => {
			if (!activeToken || activeToken.kind !== "mention" || !workspaceId) {
				return;
			}
			const requestId = ++mentionRequestIdRef.current;
			setIsMentionLoading(true);
			void (async () => {
				try {
					const payload = await getRuntimeTrpcClient(workspaceId).workspace.searchFiles.query({
						query: activeToken.query,
						limit: mentionLimit,
					});
					if (requestId !== mentionRequestIdRef.current) {
						return;
					}
					setMentionSuggestions(
						payload.files.map((file) => ({
							id: file.path,
							kind: "mention",
							label: file.name,
							detail: file.path,
							insertText: buildMentionInsertText(file.path),
						})),
					);
				} catch {
					if (requestId === mentionRequestIdRef.current) {
						setMentionSuggestions([]);
					}
				} finally {
					if (requestId === mentionRequestIdRef.current) {
						setIsMentionLoading(false);
					}
				}
			})();
		},
		COMPLETION_QUERY_DEBOUNCE_MS,
		[activeToken, mentionLimit, workspaceId],
	);

	useDebouncedEffect(
		() => {
			if (!enableSlashCommands || !activeToken || activeToken.kind !== "slash") {
				return;
			}
			const cacheKey = workspaceId ?? "__global__";
			const requestId = ++slashRequestIdRef.current;
			const applyCommands = (commands: RuntimeSlashCommand[]) => {
				const query = activeToken.query.trim().toLowerCase();
				const filtered = commands
					.filter((command) => {
						if (query.length === 0) {
							return true;
						}
						const description = command.description?.toLowerCase() ?? "";
						return command.name.toLowerCase().includes(query) || description.includes(query);
					})
					.slice(0, slashLimit)
					.map((command) => ({
						id: command.name,
						kind: "slash" as const,
						label: `/${command.name}`,
						detail: command.description,
						insertText: buildSlashCommandInsertText(command.name),
					}));
				setSlashSuggestions(filtered);
			};

			const cached = slashCacheRef.current.get(cacheKey);
			if (cached) {
				applyCommands(cached);
				return;
			}

			setIsSlashLoading(true);
			void (async () => {
				try {
					const payload = await getRuntimeTrpcClient(workspaceId).runtime.getClineSlashCommands.query();
					if (requestId !== slashRequestIdRef.current) {
						return;
					}
					slashCacheRef.current.set(cacheKey, payload.commands);
					applyCommands(payload.commands);
				} catch {
					if (requestId === slashRequestIdRef.current) {
						setSlashSuggestions([]);
					}
				} finally {
					if (requestId === slashRequestIdRef.current) {
						setIsSlashLoading(false);
					}
				}
			})();
		},
		COMPLETION_QUERY_DEBOUNCE_MS,
		[activeToken, enableSlashCommands, slashLimit, workspaceId],
	);

	const applySuggestion = useCallback(
		(suggestion: ClineComposerCompletionSuggestion) => {
			if (!activeToken) {
				return;
			}
			onApplyCompletion(applyClineComposerCompletion(value, activeToken, suggestion.insertText));
		},
		[activeToken, onApplyCompletion, value],
	);

	const selectItem = useCallback(
		(id: string) => {
			const suggestion = suggestions.find((entry) => entry.id === id);
			if (suggestion) {
				applySuggestion(suggestion);
			}
		},
		[applySuggestion, suggestions],
	);

	const handleCompletionKeyDown = useCallback(
		(event: ComposerCompletionKeyEvent) => {
			if (!showPicker || suggestions.length === 0) {
				return false;
			}
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				const direction = event.key === "ArrowDown" ? 1 : -1;
				setSelectedIndex((current) => {
					const next = current + direction;
					if (next < 0) {
						return suggestions.length - 1;
					}
					if (next >= suggestions.length) {
						return 0;
					}
					return next;
				});
				return true;
			}
			if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
				event.preventDefault();
				const selected = suggestions[selectedIndex] ?? suggestions[0];
				if (selected) {
					applySuggestion(selected);
				}
				return true;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setIsPickerOpen(false);
				return true;
			}
			return false;
		},
		[applySuggestion, selectedIndex, showPicker, suggestions],
	);

	return {
		activeToken,
		suggestions,
		showPicker,
		selectedIndex,
		isLoading,
		loadingMessage,
		emptyMessage,
		setSelectedIndex,
		selectItem,
		setPickerOpen: setIsPickerOpen,
		handleCompletionKeyDown,
	};
}
