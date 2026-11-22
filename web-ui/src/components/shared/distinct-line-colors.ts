/**
 * High-contrast palette for parallel lines that need to stay visually
 * distinguishable from each other (git graph lanes, dependency links, ...).
 *
 * Colors reference the design tokens defined in `globals.css` so they follow
 * the active theme. Keep the order stable: consumers hand out colors by index
 * and expect adjacent lines to contrast.
 */
export const DISTINCT_LINE_COLORS = [
	"var(--color-status-blue)",
	"var(--color-status-green)",
	"var(--color-status-orange)",
	"var(--color-status-violet)",
	"var(--color-status-rose)",
	"var(--color-status-cyan)",
	"var(--color-status-lime)",
	"var(--color-status-gold)",
];
