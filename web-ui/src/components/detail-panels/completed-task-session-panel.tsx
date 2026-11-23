// Read-only summary of a task that already moved to Done.
// Terminal-backed agents do not retain their scrollback after the session stops,
// so this panel surfaces the last known session state instead of an empty xterm.
import { CircleCheck, RotateCcw } from "lucide-react";
import type { ReactElement } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";

const STATE_LABELS: Record<RuntimeTaskSessionSummary["state"], string> = {
	idle: "Idle",
	running: "Running",
	awaiting_review: "Ready for review",
	interrupted: "Interrupted",
	failed: "Failed",
};

const STATE_BADGE_CLASSES: Record<RuntimeTaskSessionSummary["state"], string> = {
	idle: "bg-surface-3 text-text-secondary",
	running: "bg-status-green/15 text-status-green",
	awaiting_review: "bg-status-orange/15 text-status-orange",
	interrupted: "bg-status-red/15 text-status-red",
	failed: "bg-status-red/15 text-status-red",
};

function readFinalMessage(summary: RuntimeTaskSessionSummary | null): string | null {
	if (!summary) {
		return null;
	}
	const hookActivity = summary.latestHookActivity;
	const finalMessage = hookActivity?.finalMessage?.trim();
	if (finalMessage) {
		return finalMessage;
	}
	const activityText = hookActivity?.activityText?.trim();
	if (activityText) {
		return activityText;
	}
	const warningMessage = summary.warningMessage?.trim();
	return warningMessage ? warningMessage : null;
}

export function CompletedTaskSessionPanel({
	summary,
	onRestore,
	isRestoreLoading = false,
}: {
	summary: RuntimeTaskSessionSummary | null;
	onRestore?: () => void;
	isRestoreLoading?: boolean;
}): ReactElement {
	const state = summary?.state ?? "idle";
	const finalMessage = readFinalMessage(summary);

	return (
		<div className="flex min-h-0 min-w-0 flex-1 flex-col">
			<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
				<div className="flex items-center gap-2">
					<CircleCheck size={16} className="text-status-green" />
					<span className="text-sm font-medium text-text-primary">Task completed</span>
					<span
						className={cn(
							"inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
							STATE_BADGE_CLASSES[state],
						)}
					>
						{STATE_LABELS[state]}
					</span>
				</div>
				<p className="m-0 text-xs leading-[1.5] text-text-secondary">
					Kanban removed this task's worktree when it moved to Done. Terminal output is not kept after the agent
					session stops, so only the last known session state is available here.
				</p>
				{finalMessage ? (
					<div>
						<h3 className="m-0 mb-1 text-xs font-semibold text-text-secondary">Last update</h3>
						<pre className="m-0 max-h-[320px] overflow-auto rounded-md bg-surface-0 p-3 font-mono text-xs leading-[1.5] text-text-primary whitespace-pre-wrap">
							{finalMessage}
						</pre>
					</div>
				) : null}
			</div>
			{onRestore ? (
				<div className="border-t border-border p-3">
					<Button
						variant="default"
						fill
						icon={<RotateCcw size={14} />}
						disabled={isRestoreLoading}
						onClick={onRestore}
					>
						Restore in new worktree
					</Button>
				</div>
			) : null}
		</div>
	);
}
