import { useSyncExternalStore } from "react";

import {
	getTerminalTypography,
	subscribeTerminalTypography,
	type TerminalTypography,
} from "@/terminal/terminal-typography";

export function useTerminalTypography(): TerminalTypography {
	return useSyncExternalStore(subscribeTerminalTypography, getTerminalTypography, getTerminalTypography);
}
