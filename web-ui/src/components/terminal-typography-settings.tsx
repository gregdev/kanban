import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
	isDefaultTerminalTypography,
	resetTerminalTypography,
	setTerminalFontSize,
	setTerminalLetterSpacing,
	setTerminalLineHeight,
	TERMINAL_FONT_SIZE_MAX,
	TERMINAL_FONT_SIZE_MIN,
	TERMINAL_FONT_SIZE_STEP,
	TERMINAL_LETTER_SPACING_MAX,
	TERMINAL_LETTER_SPACING_MIN,
	TERMINAL_LETTER_SPACING_STEP,
	TERMINAL_LINE_HEIGHT_MAX,
	TERMINAL_LINE_HEIGHT_MIN,
	TERMINAL_LINE_HEIGHT_STEP,
} from "@/terminal/terminal-typography";
import { useTerminalTypography } from "@/terminal/use-terminal-typography";

const TYPOGRAPHY_PREVIEW_TEXT = ["$ pnpm test", "✓ 128 tests passed (3.21s)", "0123456789 ~ !@#$%^&*()"].join("\n");

function parseDraftValue(draftValue: string): number {
	const trimmedValue = draftValue.trim();
	return trimmedValue.length === 0 ? Number.NaN : Number(trimmedValue);
}

function TerminalTypographyField({
	id,
	label,
	unit,
	value,
	min,
	max,
	step,
	onCommit,
}: {
	id: string;
	label: string;
	unit?: string;
	value: number;
	min: number;
	max: number;
	step: number;
	onCommit: (value: number) => number;
}): React.ReactElement {
	const [draftValue, setDraftValue] = useState(() => String(value));
	const [isEditing, setIsEditing] = useState(false);

	// Keep the input in step with external changes (Reset, another tab) while
	// leaving a half-typed value alone until the user commits it.
	useEffect(() => {
		if (!isEditing) {
			setDraftValue(String(value));
		}
	}, [isEditing, value]);

	const commitDraftValue = useCallback(() => {
		const parsedValue = parseDraftValue(draftValue);
		if (!Number.isFinite(parsedValue)) {
			setDraftValue(String(value));
			return;
		}
		setDraftValue(String(onCommit(parsedValue)));
	}, [draftValue, onCommit, value]);

	return (
		<label htmlFor={id} className="flex items-center justify-between gap-3 text-[13px] text-text-primary">
			<span>{label}</span>
			<span className="flex items-center gap-2">
				<input
					id={id}
					type="number"
					inputMode="decimal"
					min={min}
					max={max}
					step={step}
					value={draftValue}
					onFocus={() => setIsEditing(true)}
					onBlur={() => {
						setIsEditing(false);
						commitDraftValue();
					}}
					onChange={(event) => {
						const rawValue = event.target.value;
						setDraftValue(rawValue);
						const parsedValue = parseDraftValue(rawValue);
						// Only apply values that are already inside the range so
						// typing "1" on the way to "16" does not snap to the minimum.
						if (Number.isFinite(parsedValue) && parsedValue >= min && parsedValue <= max) {
							onCommit(parsedValue);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							commitDraftValue();
						}
					}}
					className="h-7 w-20 rounded-md border border-border bg-surface-2 px-2 text-xs text-text-primary focus:border-border-focus focus:outline-none"
				/>
				<span className="w-5 text-xs text-text-secondary">{unit ?? ""}</span>
			</span>
		</label>
	);
}

export function TerminalTypographySettings(): React.ReactElement {
	const typography = useTerminalTypography();
	const isDefault = isDefaultTerminalTypography(typography);

	return (
		<div className="rounded-lg border border-border bg-surface-0 px-4 py-3 mb-4">
			<div className="flex items-center justify-between gap-2 mb-2">
				<h6 className="text-[12px] font-semibold uppercase tracking-wider text-text-secondary m-0">Typography</h6>
				<Button variant="ghost" size="sm" onClick={() => resetTerminalTypography()} disabled={isDefault}>
					Reset
				</Button>
			</div>
			<div className="flex flex-col gap-1.5">
				<TerminalTypographyField
					id="terminal-font-size"
					label="Font size"
					unit="px"
					value={typography.fontSize}
					min={TERMINAL_FONT_SIZE_MIN}
					max={TERMINAL_FONT_SIZE_MAX}
					step={TERMINAL_FONT_SIZE_STEP}
					onCommit={setTerminalFontSize}
				/>
				<TerminalTypographyField
					id="terminal-line-height"
					label="Line height"
					value={typography.lineHeight}
					min={TERMINAL_LINE_HEIGHT_MIN}
					max={TERMINAL_LINE_HEIGHT_MAX}
					step={TERMINAL_LINE_HEIGHT_STEP}
					onCommit={setTerminalLineHeight}
				/>
				<TerminalTypographyField
					id="terminal-letter-spacing"
					label="Letter spacing"
					unit="px"
					value={typography.letterSpacing}
					min={TERMINAL_LETTER_SPACING_MIN}
					max={TERMINAL_LETTER_SPACING_MAX}
					step={TERMINAL_LETTER_SPACING_STEP}
					onCommit={setTerminalLetterSpacing}
				/>
			</div>
			{/*
				Preview only. The real terminal must keep sizing cells from its own
				options, which is why typography is applied through
				createKanbanTerminalOptions rather than a CSS font override.
			*/}
			<pre
				aria-label="Terminal typography preview"
				className="mt-3 mb-0 overflow-hidden whitespace-pre rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-text-primary"
				style={{
					fontSize: `${typography.fontSize}px`,
					letterSpacing: `${typography.letterSpacing}px`,
					lineHeight: typography.lineHeight,
				}}
			>
				{TYPOGRAPHY_PREVIEW_TEXT}
			</pre>
			<p className="text-text-secondary text-[13px] mt-2 mb-0">
				Saved in this browser only, and applied to every terminal immediately. All viewers of a task share one
				terminal size, so a larger font means fewer columns: when a laptop and a phone resize the same terminal, the
				most recent resize wins.
			</p>
		</div>
	);
}
