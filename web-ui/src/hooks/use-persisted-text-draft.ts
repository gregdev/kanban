// Text draft state that survives remounts and page reloads.
// The scope key decides which stored draft a composer should restore, so
// switching tasks or projects loads that surface's last unsent text.
import type { Dispatch, SetStateAction } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { readTextDraft, writeTextDraft } from "@/storage/text-drafts";

export function usePersistedTextDraft(scopeKey: string): [string, Dispatch<SetStateAction<string>>] {
	const [draft, setDraftState] = useState(() => readTextDraft(scopeKey));
	const scopeKeyRef = useRef(scopeKey);
	const draftRef = useRef(draft);

	useLayoutEffect(() => {
		if (scopeKeyRef.current === scopeKey) {
			return;
		}
		scopeKeyRef.current = scopeKey;
		const nextDraft = readTextDraft(scopeKey);
		draftRef.current = nextDraft;
		setDraftState(nextDraft);
	}, [scopeKey]);

	const setDraft = useCallback<Dispatch<SetStateAction<string>>>(
		(nextDraft) => {
			const resolvedDraft = typeof nextDraft === "function" ? nextDraft(draftRef.current) : nextDraft;
			if (resolvedDraft === draftRef.current) {
				return;
			}
			draftRef.current = resolvedDraft;
			writeTextDraft(scopeKey, resolvedDraft);
			setDraftState(resolvedDraft);
		},
		[scopeKey],
	);

	return [draft, setDraft];
}
