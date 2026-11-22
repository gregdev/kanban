import { Bell } from "lucide-react";

import { cn } from "@/components/ui/cn";

const NEEDS_INPUT_DESCRIPTION = "The agent is paused and waiting for your answer.";

/**
 * Prominent chip marking a review card whose agent is waiting on the user.
 * Uses a native title tooltip so it is safe to render anywhere (including
 * outside the app-level TooltipProvider, e.g. in unit tests).
 */
export function NeedsInputBadge({ hint, className }: { hint?: string | null; className?: string }): React.ReactElement {
	const trimmedHint = hint?.trim();
	const description = trimmedHint ? `${NEEDS_INPUT_DESCRIPTION}\n\n${trimmedHint}` : NEEDS_INPUT_DESCRIPTION;
	return (
		<span
			title={description}
			className={cn(
				"inline-flex max-w-full items-center gap-1 rounded-md border border-status-gold/40 bg-status-gold/10 px-1.5 py-0.5 text-xs font-medium text-status-gold",
				className,
			)}
		>
			<Bell size={12} className="shrink-0" />
			<span className="shrink-0">Needs input</span>
			{trimmedHint ? <span className="sr-only">: {trimmedHint}</span> : null}
		</span>
	);
}

/** Compact count of tasks in a column that are waiting on the user. */
export function NeedsInputCountBadge({ count }: { count: number }): React.ReactElement | null {
	if (count <= 0) {
		return null;
	}
	const label = count === 1 ? "1 task needs your input" : `${count} tasks need your input`;
	return (
		<span
			title={label}
			className="inline-flex items-center gap-1 rounded-md border border-status-gold/40 bg-status-gold/10 px-1.5 py-0.5 text-[11px] font-medium text-status-gold"
		>
			<Bell size={11} className="shrink-0" />
			<span aria-hidden className="tabular-nums">
				{count}
			</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}
