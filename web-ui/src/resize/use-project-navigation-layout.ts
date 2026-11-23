import { useCallback, useState } from "react";

import { useLayoutResetEffect } from "@/resize/layout-customizations";
import { clampBetween } from "@/resize/resize-persistence";
import {
	getResizePreferenceDefaultValue,
	loadBooleanResizePreference,
	loadResizePreference,
	persistBooleanResizePreference,
	persistResizePreference,
	type ResizeBooleanPreference,
	type ResizeNumberPreference,
} from "@/resize/resize-preferences";
import { LocalStorageKey } from "@/storage/local-storage-store";

const SIDEBAR_MIN_EXPANDED_WIDTH = 200;
const SIDEBAR_MAX_EXPANDED_WIDTH = 600;
const SIDEBAR_DEFAULT_EXPANDED_WIDTH_FALLBACK = 280;
// A collapsed rail is persisted, but a 48px rail offers very little surface to
// rediscover the sidebar from. On a wide first load we therefore start expanded
// instead of restoring a collapse that was probably produced in a cramped
// window. The stored preference is kept so narrower viewports still honor it.
const SIDEBAR_COLLAPSED_AUTO_EXPAND_MIN_VIEWPORT_WIDTH = 1024;
const BOARD_SURFACE_HORIZONTAL_PADDING_PX = 16;
const BOARD_SURFACE_COLUMN_GAPS_PX = 24;
const BOARD_SURFACE_HORIZONTAL_CHROME_PX = BOARD_SURFACE_HORIZONTAL_PADDING_PX + BOARD_SURFACE_COLUMN_GAPS_PX;

function getDefaultExpandedSidebarWidth(): number {
	if (typeof window === "undefined" || !Number.isFinite(window.innerWidth)) {
		return SIDEBAR_DEFAULT_EXPANDED_WIDTH_FALLBACK;
	}
	const proportionalWidth = Math.round((window.innerWidth - BOARD_SURFACE_HORIZONTAL_CHROME_PX) / 5);
	return clampBetween(proportionalWidth, SIDEBAR_MIN_EXPANDED_WIDTH, SIDEBAR_MAX_EXPANDED_WIDTH);
}

const SIDEBAR_WIDTH_PREFERENCE: ResizeNumberPreference = {
	key: LocalStorageKey.ProjectNavigationPanelWidth,
	defaultValue: getDefaultExpandedSidebarWidth,
	normalize: (value) => clampBetween(value, SIDEBAR_MIN_EXPANDED_WIDTH, SIDEBAR_MAX_EXPANDED_WIDTH),
};

const SIDEBAR_COLLAPSED_PREFERENCE: ResizeBooleanPreference = {
	key: LocalStorageKey.ProjectNavigationPanelCollapsed,
	defaultValue: false,
};

function loadInitialSidebarCollapsed(): boolean {
	const persistedCollapsed = loadBooleanResizePreference(SIDEBAR_COLLAPSED_PREFERENCE);
	if (!persistedCollapsed) {
		return false;
	}
	const isWideViewport =
		typeof window !== "undefined" &&
		Number.isFinite(window.innerWidth) &&
		window.innerWidth >= SIDEBAR_COLLAPSED_AUTO_EXPAND_MIN_VIEWPORT_WIDTH;
	return !isWideViewport;
}

export function useProjectNavigationLayout(): {
	isCollapsed: boolean;
	isExpanded: boolean;
	setExpandedSidebarWidth: (width: number) => void;
	setSidebarCollapsed: (collapsed: boolean, persist?: boolean) => void;
	setSidebarExpanded: (expanded: boolean) => void;
	sidebarWidth: number;
	toggleSidebarExpanded: () => void;
} {
	const [sidebarWidth, setSidebarWidthState] = useState(() => loadResizePreference(SIDEBAR_WIDTH_PREFERENCE));
	const [isCollapsed, setIsCollapsedState] = useState(loadInitialSidebarCollapsed);
	// Expanded mode is a transient view state: it fills the viewport while the
	// sidebar is open and restores the persisted width when dismissed.
	const [isExpanded, setIsExpandedState] = useState(false);

	const setSidebarCollapsed = useCallback((collapsed: boolean, persist = true) => {
		if (persist) {
			setIsCollapsedState(persistBooleanResizePreference(SIDEBAR_COLLAPSED_PREFERENCE, collapsed));
		} else {
			setIsCollapsedState(collapsed);
		}
		if (collapsed) {
			setIsExpandedState(false);
		}
	}, []);

	const setExpandedSidebarWidth = useCallback((width: number) => {
		setSidebarWidthState(persistResizePreference(SIDEBAR_WIDTH_PREFERENCE, width));
	}, []);

	const setSidebarExpanded = useCallback((expanded: boolean) => {
		setIsExpandedState(expanded);
	}, []);

	const toggleSidebarExpanded = useCallback(() => {
		setIsExpandedState((current) => !current);
	}, []);

	useLayoutResetEffect(() => {
		setSidebarWidthState(getResizePreferenceDefaultValue(SIDEBAR_WIDTH_PREFERENCE));
		setIsCollapsedState(SIDEBAR_COLLAPSED_PREFERENCE.defaultValue);
		setIsExpandedState(false);
	});

	return {
		sidebarWidth,
		setExpandedSidebarWidth,
		isCollapsed,
		setSidebarCollapsed,
		isExpanded,
		setSidebarExpanded,
		toggleSidebarExpanded,
	};
}
