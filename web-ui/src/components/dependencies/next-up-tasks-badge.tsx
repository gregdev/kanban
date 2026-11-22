import { CornerDownRight, Play } from "lucide-react";

import { cn } from "@/components/ui/cn";
import { Tooltip } from "@/components/ui/tooltip";
import type { BoardCard as BoardCardModel, BoardColumnId } from "@/types";
import { getTaskDisplayTitle } from "@/utils/task-prompt";

const MAX_LISTED_TASKS = 6;

/**
 * Compact "Up next" chip for a task that gates one or more linked backlog
 * tasks. Hovering or focusing the chip reveals the exact tasks that will start
 * once this task is marked done.
 */
export function NextUpTasksBadge({
	tasks,
	gatingColumnId,
	className,
}: {
	tasks: BoardCardModel[];
	gatingColumnId: BoardColumnId;
	className?: string;
}): React.ReactElement | null {
	const primaryTask = tasks[0];
	if (!primaryTask) {
		return null;
	}

	const listedTasks = tasks.slice(0, MAX_LISTED_TASKS);
	const hiddenTaskCount = tasks.length - listedTasks.length;
	const isSingleTask = tasks.length === 1;
	const label = isSingleTask ? getTaskDisplayTitle(primaryTask) : `${tasks.length} tasks`;

	return (
		<Tooltip
			side="top"
			content={
				<div className="flex max-w-[280px] flex-col gap-1.5">
					<span className="text-text-secondary">
						{gatingColumnId === "review"
							? "Starts automatically when this task is marked done"
							: "Starts after this task finishes and is marked done"}
					</span>
					<ul className="m-0 flex list-none flex-col gap-1 p-0">
						{listedTasks.map((task) => (
							<li key={task.id} className="flex items-start gap-1.5">
								<Play size={10} className="mt-[3px] shrink-0 text-status-green" />
								<span className="min-w-0 break-words">{getTaskDisplayTitle(task)}</span>
							</li>
						))}
					</ul>
					{hiddenTaskCount > 0 ? <span className="text-text-tertiary">and {hiddenTaskCount} more</span> : null}
				</div>
			}
		>
			<span
				tabIndex={0}
				className={cn(
					"inline-flex max-w-full cursor-default items-center gap-1 rounded-md border border-status-green/30 bg-status-green/10 px-1.5 py-0.5 text-xs text-status-green",
					"focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
					className,
				)}
			>
				<CornerDownRight size={12} className="shrink-0" />
				<span className="shrink-0 font-medium">Up next</span>
				<span aria-hidden className="shrink-0 text-status-green/60">
					·
				</span>
				<span className="min-w-0 truncate text-text-primary">{label}</span>
			</span>
		</Tooltip>
	);
}
