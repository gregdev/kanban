import { showAppToast } from "@/components/app-toaster";

/**
 * Writes text to the system clipboard and reports the outcome with a toast.
 * Menu items and copy buttons should route through this so every copy in the
 * app behaves identically (and fails loudly instead of silently).
 */
export async function copyTextToClipboard(text: string, label = "Copied to clipboard"): Promise<void> {
	try {
		await navigator.clipboard.writeText(text);
		showAppToast({ intent: "success", message: label });
	} catch {
		showAppToast({ intent: "danger", message: "Could not copy to clipboard" });
	}
}
