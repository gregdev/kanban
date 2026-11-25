import { AlertCircle } from "lucide-react";
import type { ReactElement } from "react";

import { Spinner } from "@/components/ui/spinner";

export type RuntimeDisconnectedVariant = "fullscreen" | "overlay";

export function RuntimeDisconnectedFallback({
	variant = "fullscreen",
}: {
	variant?: RuntimeDisconnectedVariant;
} = {}): ReactElement {
	if (variant === "overlay") {
		// A transient tunnel or runtime drop should never replace the app shell:
		// unmounting it would discard in-progress prompts and terminal state.
		return (
			<div
				role="status"
				aria-live="polite"
				className="pointer-events-none fixed inset-x-0 top-0 z-[100] flex justify-center p-3"
			>
				<div className="flex items-center gap-2 rounded-md border border-status-orange/40 bg-surface-1/95 px-3 py-2 text-xs text-text-secondary shadow-lg backdrop-blur">
					<Spinner size={14} className="text-status-orange" />
					<span>Connection to Kanban dropped. Reconnecting...</span>
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-[100svh] items-center justify-center bg-surface-0 p-6">
			<div className="flex flex-col items-center justify-center gap-3 py-12 text-text-tertiary">
				<AlertCircle size={48} />
				<h3 className="font-semibold text-text-primary">Disconnected from Kanban</h3>
				<p className="text-text-secondary">Run kanban again in your terminal, then reload this tab.</p>
			</div>
		</div>
	);
}
