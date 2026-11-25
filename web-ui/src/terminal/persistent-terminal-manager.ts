import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { getTerminalThemeColors, type ThemeTerminalColors } from "@/hooks/use-theme";
import { estimateTaskSessionGeometry } from "@/runtime/task-session-geometry";
import { getRuntimeTrpcClient } from "@/runtime/trpc-client";
import type {
	RuntimeTaskSessionSummary,
	RuntimeTerminalWsClientMessage,
	RuntimeTerminalWsServerMessage,
} from "@/runtime/types";
import { clearTerminalGeometry, reportTerminalGeometry } from "@/terminal/terminal-geometry-registry";
import { createKanbanTerminalOptions } from "@/terminal/terminal-options";
import {
	getTerminalTypography,
	subscribeTerminalTypography,
	type TerminalTypography,
} from "@/terminal/terminal-typography";
import {
	appendTerminalHeuristicText,
	hasInterruptAcknowledgement,
	hasLikelyShellPrompt,
} from "@/terminal/terminal-prompt-heuristics";
import { isMacPlatform } from "@/utils/platform";

const SHIFT_ENTER_SEQUENCE = "\n";
const RESIZE_DEBOUNCE_MS = 50;
const INTERRUPT_IDLE_SETTLE_MS = 250;
const PARKING_ROOT_ID = "kb-persistent-terminal-parking-root";
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 5_000;
const RECONNECT_MAX_ATTEMPTS = 8;
const TERMINAL_SOCKET_CLOSE_NORMAL = 1000;
const TERMINAL_SOCKET_CLOSE_INTERNAL_ERROR = 1011;
const TERMINAL_STREAM_CLOSED_ERROR = "Terminal stream closed. Close and reopen to reconnect.";
const TERMINAL_CONTROL_CLOSED_ERROR = "Terminal control connection closed. Close and reopen to reconnect.";
const TERMINAL_STREAM_FAILED_ERROR = "Terminal stream failed.";
const TERMINAL_CONTROL_FAILED_ERROR = "Terminal control connection failed.";
const REPLACED_TERMINAL_STREAM_CLOSE_REASON = "Replaced by newer terminal stream.";
const REPLACED_TERMINAL_CONTROL_CLOSE_REASON = "Replaced by newer terminal control connection.";
const TASK_SESSION_NOT_RUNNING_CLOSE_REASON = "Task session is not running.";

type TerminalSocketChannel = "io" | "control";

interface PersistentTerminalAppearance {
	cursorColor: string;
	terminalBackgroundColor: string;
	themeColors?: ThemeTerminalColors;
}

interface PersistentTerminalSubscriber {
	onConnectionReady?: (taskId: string) => void;
	onLastError?: (message: string | null) => void;
	onReconnectingChange?: (isReconnecting: boolean) => void;
	onSummary?: (summary: RuntimeTaskSessionSummary) => void;
	onOutputText?: (text: string) => void;
}

interface MountPersistentTerminalOptions {
	autoFocus?: boolean;
	isVisible?: boolean;
}

interface EnsurePersistentTerminalInput extends PersistentTerminalAppearance {
	taskId: string;
	workspaceId: string;
}

function generateTerminalClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}
	return `terminal-${Math.random().toString(36).slice(2, 10)}`;
}

function getTerminalIoWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/io`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function getTerminalControlWebSocketUrl(taskId: string, workspaceId: string, clientId: string): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const url = new URL(`${protocol}//${window.location.host}/api/terminal/control`);
	url.searchParams.set("taskId", taskId);
	url.searchParams.set("workspaceId", workspaceId);
	url.searchParams.set("clientId", clientId);
	return url.toString();
}

function decodeTerminalSocketChunk(decoder: TextDecoder, data: string | ArrayBuffer | Blob): string {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return decoder.decode(new Uint8Array(data), { stream: true });
	}
	return "";
}

function getTerminalSocketWriteData(data: string | ArrayBuffer | Blob): string | Uint8Array<ArrayBuffer> | null {
	if (typeof data === "string") {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return null;
}

function getTerminalSocketChunkByteLength(data: string | ArrayBuffer | Blob): number {
	if (typeof data === "string") {
		return new TextEncoder().encode(data).byteLength;
	}
	if (data instanceof ArrayBuffer) {
		return data.byteLength;
	}
	return 0;
}

function isCopyShortcut(event: KeyboardEvent): boolean {
	return (
		event.type === "keydown" &&
		((isMacPlatform && event.metaKey && !event.shiftKey && event.key.toLowerCase() === "c") ||
			(!isMacPlatform && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c"))
	);
}

function getParkingRoot(): HTMLDivElement {
	const existingRoot = document.getElementById(PARKING_ROOT_ID);
	if (existingRoot instanceof HTMLDivElement) {
		return existingRoot;
	}
	const root = document.createElement("div");
	root.id = PARKING_ROOT_ID;
	root.setAttribute("aria-hidden", "true");
	Object.assign(root.style, {
		position: "fixed",
		left: "-10000px",
		top: "-10000px",
		width: "1px",
		height: "1px",
		overflow: "hidden",
		opacity: "0",
		pointerEvents: "none",
	});
	document.body.appendChild(root);
	return root;
}

function buildKey(workspaceId: string, taskId: string): string {
	return `${workspaceId}:${taskId}`;
}

function isIntentionalTerminalSocketClose(channel: TerminalSocketChannel, event: CloseEvent): boolean {
	if (event.code === TERMINAL_SOCKET_CLOSE_INTERNAL_ERROR && event.reason === TASK_SESSION_NOT_RUNNING_CLOSE_REASON) {
		return true;
	}
	if (event.code !== TERMINAL_SOCKET_CLOSE_NORMAL) {
		return false;
	}
	const replacedReason =
		channel === "io" ? REPLACED_TERMINAL_STREAM_CLOSE_REASON : REPLACED_TERMINAL_CONTROL_CLOSE_REASON;
	return event.reason === replacedReason;
}

class PersistentTerminal {
	private readonly terminal: Terminal;
	private readonly fitAddon = new FitAddon();
	private readonly hostElement: HTMLDivElement;
	private readonly subscribers = new Set<PersistentTerminalSubscriber>();
	private readonly parkingRoot: HTMLDivElement;
	private readonly unicode11Addon = new Unicode11Addon();
	private readonly unsubscribeTypography: () => void;
	// This identifies one browser viewer, not the PTY session itself.
	// The server uses it to keep per-tab restore and socket state while all tabs
	// still share the same taskId backed PTY.
	private readonly clientId = generateTerminalClientId();
	private appearance: PersistentTerminalAppearance;
	private latestSummary: RuntimeTaskSessionSummary | null = null;
	private lastError: string | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeTimer: ReturnType<typeof setTimeout> | null = null;
	private visibleContainer: HTMLDivElement | null = null;
	private ioSocket: WebSocket | null = null;
	private controlSocket: WebSocket | null = null;
	private connectionReady = false;
	private restoreCompleted = false;
	private outputTextDecoder = new TextDecoder();
	private terminalWriteQueue: Promise<void> = Promise.resolve();
	private disposed = false;
	private reconnectTimer: number | null = null;
	private reconnectAttempt = 0;
	private reconnecting = false;
	private ioSocketReconnectSuppressed = false;
	private controlSocketReconnectSuppressed = false;
	private readonly handleWindowOnline = (): void => {
		this.retryImmediately();
	};
	private readonly handleWindowPageShow = (): void => {
		this.retryImmediately();
	};
	private readonly handleDocumentVisibilityChange = (): void => {
		if (document.visibilityState === "visible") {
			this.retryImmediately();
		}
	};

	constructor(
		private readonly taskId: string,
		private readonly workspaceId: string,
		appearance: PersistentTerminalAppearance,
	) {
		this.appearance = appearance;
		this.parkingRoot = getParkingRoot();
		this.hostElement = document.createElement("div");
		Object.assign(this.hostElement.style, {
			width: "100%",
			height: "100%",
		});
		this.parkingRoot.appendChild(this.hostElement);
		const initialGeometry = estimateTaskSessionGeometry(window.innerWidth, window.innerHeight);

		this.terminal = new Terminal({
			...createKanbanTerminalOptions({
				cursorColor: this.appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: this.appearance.terminalBackgroundColor,
				themeColors: this.appearance.themeColors ?? getTerminalThemeColors(),
				typography: getTerminalTypography(),
			}),
			cols: initialGeometry.cols,
			rows: initialGeometry.rows,
		});
		this.terminal.loadAddon(this.fitAddon);
		this.terminal.loadAddon(new ClipboardAddon());
		this.terminal.loadAddon(new WebLinksAddon());
		this.terminal.loadAddon(this.unicode11Addon);
		this.terminal.unicode.activeVersion = "11";
		this.terminal.open(this.hostElement);
		// Typography is a per-browser preference, so it lives in a small store
		// instead of the per-terminal appearance payload. Subscribing here keeps
		// every live terminal (task + home shell) in step without remounting them.
		this.unsubscribeTypography = subscribeTerminalTypography((typography) => {
			this.applyTypography(typography);
		});
		this.terminal.onData((data) => {
			this.sendIoData(data);
		});
		this.terminal.onBinary((data) => {
			const bytes = new Uint8Array(data.length);
			for (let index = 0; index < data.length; index += 1) {
				bytes[index] = data.charCodeAt(index) & 0xff;
			}
			this.sendIoData(bytes);
		});
		this.terminal.attachCustomKeyEventHandler((event) => {
			if (event.key === "Enter" && event.shiftKey) {
				if (event.type === "keydown") {
					this.terminal.input(SHIFT_ENTER_SEQUENCE);
				}
				return false;
			}
			if (isCopyShortcut(event) && this.terminal.hasSelection()) {
				void navigator.clipboard.writeText(this.terminal.getSelection()).catch(() => {
					// Ignore clipboard failures.
				});
				return false;
			}
			return true;
		});

		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
			});
			this.terminal.loadAddon(webglAddon);
		} catch {
			// Fall back to the default renderer when WebGL is unavailable.
		}

		window.addEventListener("online", this.handleWindowOnline);
		window.addEventListener("pageshow", this.handleWindowPageShow);
		document.addEventListener("visibilitychange", this.handleDocumentVisibilityChange);
		this.ensureConnected();
	}

	private notifyLastError(): void {
		for (const subscriber of this.subscribers) {
			subscriber.onLastError?.(this.lastError);
		}
	}

	private setLastError(message: string | null): void {
		if (this.lastError === message) {
			return;
		}
		this.lastError = message;
		this.notifyLastError();
	}

	private setReconnecting(reconnecting: boolean): void {
		if (this.reconnecting === reconnecting) {
			return;
		}
		this.reconnecting = reconnecting;
		for (const subscriber of this.subscribers) {
			subscriber.onReconnectingChange?.(reconnecting);
		}
	}

	private clearReconnectTimer(): void {
		if (this.reconnectTimer === null) {
			return;
		}
		window.clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
	}

	private scheduleReconnect(errorMessage: string): void {
		if (this.disposed || this.reconnectTimer !== null) {
			return;
		}
		if (this.ioSocketReconnectSuppressed || this.controlSocketReconnectSuppressed) {
			this.failReconnect(errorMessage);
			return;
		}
		if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
			this.failReconnect(errorMessage);
			return;
		}
		this.setLastError(null);
		this.setReconnecting(true);
		const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			this.connectSockets();
		}, delay);
	}

	private failReconnect(errorMessage: string): void {
		this.clearReconnectTimer();
		this.setReconnecting(false);
		this.setLastError(errorMessage);
	}

	private retryImmediately(): void {
		if (this.disposed) {
			return;
		}
		this.reconnectAttempt = 0;
		this.clearReconnectTimer();
		this.ioSocketReconnectSuppressed = false;
		this.controlSocketReconnectSuppressed = false;
		const needsIo = this.ioSocket === null;
		const needsControl = this.controlSocket === null;
		if (!needsIo && !needsControl) {
			return;
		}
		this.setLastError(null);
		this.setReconnecting(true);
		this.connectSockets();
	}

	private notifySummary(summary: RuntimeTaskSessionSummary): void {
		this.latestSummary = summary;
		for (const subscriber of this.subscribers) {
			subscriber.onSummary?.(summary);
		}
	}

	private notifyOutputText(text: string): void {
		for (const subscriber of this.subscribers) {
			subscriber.onOutputText?.(text);
		}
	}

	private notifyConnectionReady(): void {
		this.connectionReady = true;
		this.reconnectAttempt = 0;
		this.setLastError(null);
		this.setReconnecting(false);
		for (const subscriber of this.subscribers) {
			subscriber.onConnectionReady?.(this.taskId);
		}
	}

	private sendControlMessage(message: RuntimeTerminalWsClientMessage): void {
		if (!this.controlSocket || this.controlSocket.readyState !== WebSocket.OPEN) {
			return;
		}
		this.controlSocket.send(JSON.stringify(message));
	}

	private sendIoData(data: string | Uint8Array<ArrayBuffer>): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.ioSocket.send(data);
		return true;
	}

	private enqueueTerminalWrite(
		data: string | Uint8Array,
		options: {
			ackBytes?: number;
			notifyText?: string | null;
		} = {},
	): Promise<void> {
		const ackBytes = options.ackBytes ?? 0;
		const notifyText = options.notifyText ?? null;
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(
				async () =>
					await new Promise<void>((resolve) => {
						if (this.disposed) {
							resolve();
							return;
						}
						this.terminal.write(data, () => {
							if (notifyText) {
								this.notifyOutputText(notifyText);
							}
							if (ackBytes > 0) {
								this.sendControlMessage({
									type: "output_ack",
									bytes: ackBytes,
								});
							}
							resolve();
						});
					}),
			);
		return this.terminalWriteQueue;
	}

	private async applyRestore(
		snapshot: string,
		cols: number | null | undefined,
		rows: number | null | undefined,
	): Promise<void> {
		await this.terminalWriteQueue.catch(() => undefined);
		this.terminal.reset();
		if (cols && rows && (this.terminal.cols !== cols || this.terminal.rows !== rows)) {
			this.terminal.resize(cols, rows);
		}
		if (!snapshot) {
			return;
		}
		await this.enqueueTerminalWrite(snapshot);
	}

	private requestResize(): void {
		if (!this.visibleContainer) {
			return;
		}
		this.fitAddon.fit();
		const bounds = this.visibleContainer.getBoundingClientRect();
		const pixelWidth = Math.round(bounds.width);
		const pixelHeight = Math.round(bounds.height);
		reportTerminalGeometry(this.taskId, {
			cols: this.terminal.cols,
			rows: this.terminal.rows,
		});
		this.sendControlMessage({
			type: "resize",
			cols: this.terminal.cols,
			rows: this.terminal.rows,
			pixelWidth: pixelWidth > 0 ? pixelWidth : undefined,
			pixelHeight: pixelHeight > 0 ? pixelHeight : undefined,
		});
	}

	private closeSocket(socket: WebSocket | null): void {
		if (!socket) {
			return;
		}
		socket.onopen = null;
		socket.onmessage = null;
		socket.onerror = null;
		socket.onclose = null;
		try {
			socket.close();
		} catch {
			// Ignore close errors from already-closed sockets.
		}
	}

	private teardownSocketPairForReconnect(): void {
		const ioSocket = this.ioSocket;
		const controlSocket = this.controlSocket;
		this.ioSocket = null;
		this.controlSocket = null;
		this.connectionReady = false;
		this.restoreCompleted = false;
		this.outputTextDecoder = new TextDecoder();
		this.closeSocket(ioSocket);
		this.closeSocket(controlSocket);
	}

	private handleSocketClose(channel: TerminalSocketChannel, event: CloseEvent): void {
		const closedError = channel === "io" ? TERMINAL_STREAM_CLOSED_ERROR : TERMINAL_CONTROL_CLOSED_ERROR;
		if (channel === "io") {
			this.ioSocket = null;
			this.outputTextDecoder = new TextDecoder();
		} else {
			this.controlSocket = null;
		}
		this.connectionReady = false;
		this.restoreCompleted = false;

		if (isIntentionalTerminalSocketClose(channel, event)) {
			if (channel === "io") {
				this.ioSocketReconnectSuppressed = true;
			} else {
				this.controlSocketReconnectSuppressed = true;
			}
			if (this.ioSocketReconnectSuppressed && this.controlSocketReconnectSuppressed) {
				this.failReconnect(closedError);
				return;
			}
			this.setReconnecting(false);
			this.setLastError(closedError);
			return;
		}

		// The server resets its per-viewer restore gate when the control socket
		// reconnects. Reconnecting the pair together guarantees a fresh restore
		// snapshot instead of a half-restored stream.
		this.teardownSocketPairForReconnect();
		this.scheduleReconnect(closedError);
	}

	private connectIo(): void {
		if (this.disposed || this.ioSocket || this.ioSocketReconnectSuppressed) {
			return;
		}
		let ioSocket: WebSocket;
		try {
			ioSocket = new WebSocket(getTerminalIoWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		} catch {
			this.scheduleReconnect(TERMINAL_STREAM_CLOSED_ERROR);
			return;
		}
		ioSocket.binaryType = "arraybuffer";
		ioSocket.addEventListener("message", (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			const writeData = getTerminalSocketWriteData(event.data);
			if (!writeData) {
				return;
			}
			const decoded = decodeTerminalSocketChunk(this.outputTextDecoder, event.data);
			void this.enqueueTerminalWrite(writeData, {
				ackBytes: getTerminalSocketChunkByteLength(event.data),
				notifyText: decoded || null,
			});
		});
		this.ioSocket = ioSocket;
		ioSocket.onopen = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.setLastError(null);
			if (this.restoreCompleted && this.visibleContainer) {
				this.requestResize();
			}
			if (this.restoreCompleted) {
				this.notifyConnectionReady();
			}
		};
		ioSocket.onerror = () => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.setLastError(TERMINAL_STREAM_FAILED_ERROR);
		};
		ioSocket.onclose = (event) => {
			if (this.disposed || this.ioSocket !== ioSocket) {
				return;
			}
			this.handleSocketClose("io", event);
		};
	}

	private connectControl(): void {
		if (this.disposed || this.controlSocket || this.controlSocketReconnectSuppressed) {
			return;
		}
		let controlSocket: WebSocket;
		try {
			controlSocket = new WebSocket(getTerminalControlWebSocketUrl(this.taskId, this.workspaceId, this.clientId));
		} catch {
			this.scheduleReconnect(TERMINAL_CONTROL_CLOSED_ERROR);
			return;
		}
		this.controlSocket = controlSocket;
		controlSocket.onopen = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.setLastError(null);
		};
		controlSocket.onmessage = (event) => {
			let payload: RuntimeTerminalWsServerMessage;
			try {
				payload = JSON.parse(String(event.data)) as RuntimeTerminalWsServerMessage;
			} catch {
				// Ignore malformed control frames.
				return;
			}

			if (payload.type === "restore") {
				this.restoreCompleted = false;
				void this.applyRestore(payload.snapshot, payload.cols, payload.rows)
					.then(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.restoreCompleted = true;
						this.sendControlMessage({ type: "restore_complete" });
						if (this.ioSocket?.readyState === WebSocket.OPEN) {
							this.requestResize();
							this.notifyConnectionReady();
						}
					})
					.catch(() => {
						if (this.disposed || this.controlSocket !== controlSocket) {
							return;
						}
						this.setLastError("Terminal restore failed.");
					});
				return;
			}
			if (payload.type === "state") {
				this.notifySummary(payload.summary);
				return;
			}
			if (payload.type === "exit") {
				const label = payload.code == null ? "session exited" : `session exited with code ${payload.code}`;
				void this.enqueueTerminalWrite(`\r\n[kanban] ${label}\r\n`);
				return;
			}
			if (payload.type === "error") {
				this.setLastError(payload.message);
				void this.enqueueTerminalWrite(`\r\n[kanban] ${payload.message}\r\n`);
			}
		};
		controlSocket.onerror = () => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.setLastError(TERMINAL_CONTROL_FAILED_ERROR);
		};
		controlSocket.onclose = (event) => {
			if (this.disposed || this.controlSocket !== controlSocket) {
				return;
			}
			this.handleSocketClose("control", event);
		};
	}

	private connectSockets(): void {
		if (this.disposed) {
			return;
		}
		if (!this.ioSocket && !this.ioSocketReconnectSuppressed) {
			this.connectIo();
		}
		if (!this.controlSocket && !this.controlSocketReconnectSuppressed) {
			this.connectControl();
		}
	}

	private ensureConnected(): void {
		if (this.disposed || this.reconnectTimer !== null) {
			return;
		}
		this.connectSockets();
	}

	/**
	 * Apply a typography change in place. xterm measures its cell size from its
	 * own options, so the PTY has to be told the new cols/rows: mutate the
	 * options, then reuse the mounted-viewport resize path (fit + control
	 * `resize`). A parked terminal re-fits when it is next mounted.
	 */
	private applyTypography(typography: TerminalTypography): void {
		const { fontSize, letterSpacing, lineHeight } = this.terminal.options;
		if (
			fontSize === typography.fontSize &&
			letterSpacing === typography.letterSpacing &&
			lineHeight === typography.lineHeight
		) {
			return;
		}
		this.terminal.options.fontSize = typography.fontSize;
		this.terminal.options.lineHeight = typography.lineHeight;
		this.terminal.options.letterSpacing = typography.letterSpacing;
		this.requestResize();
	}

	private updateAppearance(appearance: PersistentTerminalAppearance): void {
		this.appearance = appearance;
		this.terminal.options.theme = {
			...this.terminal.options.theme,
			...createKanbanTerminalOptions({
				cursorColor: appearance.cursorColor,
				isMacPlatform,
				terminalBackgroundColor: appearance.terminalBackgroundColor,
				themeColors: appearance.themeColors ?? getTerminalThemeColors(),
			}).theme,
		};
	}

	setAppearance(appearance: PersistentTerminalAppearance): void {
		this.updateAppearance(appearance);
	}

	subscribe(subscriber: PersistentTerminalSubscriber): () => void {
		this.subscribers.add(subscriber);
		subscriber.onLastError?.(this.lastError);
		subscriber.onReconnectingChange?.(this.reconnecting);
		if (this.latestSummary) {
			subscriber.onSummary?.(this.latestSummary);
		}
		if (this.connectionReady) {
			subscriber.onConnectionReady?.(this.taskId);
		}
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	mount(
		container: HTMLDivElement,
		appearance: PersistentTerminalAppearance,
		options: MountPersistentTerminalOptions,
	): void {
		if (this.disposed) {
			return;
		}
		this.ensureConnected();
		this.updateAppearance(appearance);
		if (this.visibleContainer !== container) {
			this.visibleContainer = container;
			container.appendChild(this.hostElement);
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
		}
		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeTimer !== null) {
				clearTimeout(this.resizeTimer);
			}
			this.resizeTimer = setTimeout(() => {
				this.resizeTimer = null;
				this.requestResize();
			}, RESIZE_DEBOUNCE_MS);
		});
		this.resizeObserver.observe(container);
		if (options.isVisible !== false) {
			window.requestAnimationFrame(() => {
				this.requestResize();
				if (options.autoFocus) {
					this.terminal.focus();
				}
			});
		}
	}

	unmount(container: HTMLDivElement | null): void {
		if (this.disposed && this.visibleContainer === null) {
			return;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.resizeTimer !== null) {
			clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		if (container && this.visibleContainer !== container) {
			return;
		}
		this.visibleContainer = null;
		clearTerminalGeometry(this.taskId);
		this.parkingRoot.appendChild(this.hostElement);
	}

	focus(): void {
		this.terminal.focus();
	}

	input(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.input(text);
		return true;
	}

	paste(text: string): boolean {
		if (!this.ioSocket || this.ioSocket.readyState !== WebSocket.OPEN) {
			return false;
		}
		this.terminal.paste(text);
		return true;
	}

	clear(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.clear();
			});
	}

	reset(): void {
		this.terminalWriteQueue = this.terminalWriteQueue
			.catch(() => undefined)
			.then(() => {
				if (this.disposed) {
					return;
				}
				this.terminal.reset();
			});
	}

	waitForLikelyPrompt(timeoutMs: number): Promise<boolean> {
		if (timeoutMs <= 0) {
			return Promise.resolve(false);
		}

		return new Promise((resolve) => {
			let buffer = "";
			let sawInterruptAcknowledgement = false;
			let settled = false;
			let idleTimer: number | null = null;

			const cleanup = (result: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				window.clearTimeout(timeoutId);
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				unsubscribe();
				resolve(result);
			};

			const scheduleIdleCompletion = () => {
				if (!sawInterruptAcknowledgement) {
					return;
				}
				if (idleTimer !== null) {
					window.clearTimeout(idleTimer);
				}
				idleTimer = window.setTimeout(() => {
					cleanup(true);
				}, INTERRUPT_IDLE_SETTLE_MS);
			};

			const unsubscribe = this.subscribe({
				onOutputText: (text) => {
					buffer = appendTerminalHeuristicText(buffer, text);
					if (hasLikelyShellPrompt(buffer)) {
						cleanup(true);
						return;
					}
					if (hasInterruptAcknowledgement(buffer)) {
						sawInterruptAcknowledgement = true;
					}
					scheduleIdleCompletion();
				},
			});

			const timeoutId = window.setTimeout(() => {
				cleanup(false);
			}, timeoutMs);
		});
	}

	async stop(): Promise<void> {
		this.sendControlMessage({ type: "stop" });
		const trpcClient = getRuntimeTrpcClient(this.workspaceId);
		await trpcClient.runtime.stopTaskSession.mutate({ taskId: this.taskId });
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.unsubscribeTypography();
		window.removeEventListener("online", this.handleWindowOnline);
		window.removeEventListener("pageshow", this.handleWindowPageShow);
		document.removeEventListener("visibilitychange", this.handleDocumentVisibilityChange);
		this.clearReconnectTimer();
		this.setReconnecting(false);
		this.unmount(this.visibleContainer);
		const ioSocket = this.ioSocket;
		const controlSocket = this.controlSocket;
		this.ioSocket = null;
		this.controlSocket = null;
		this.closeSocket(ioSocket);
		this.closeSocket(controlSocket);
		this.subscribers.clear();
		this.terminal.dispose();
		this.hostElement.remove();
	}
}

const terminals = new Map<string, PersistentTerminal>();

export function ensurePersistentTerminal(input: EnsurePersistentTerminalInput): PersistentTerminal {
	const key = buildKey(input.workspaceId, input.taskId);
	let terminal = terminals.get(key);
	if (!terminal) {
		terminal = new PersistentTerminal(input.taskId, input.workspaceId, {
			cursorColor: input.cursorColor,
			terminalBackgroundColor: input.terminalBackgroundColor,
			themeColors: input.themeColors,
		});
		terminals.set(key, terminal);
		return terminal;
	}
	terminal.setAppearance({
		cursorColor: input.cursorColor,
		terminalBackgroundColor: input.terminalBackgroundColor,
		themeColors: input.themeColors,
	});
	return terminal;
}

export function disposePersistentTerminal(workspaceId: string, taskId: string): void {
	const key = buildKey(workspaceId, taskId);
	const terminal = terminals.get(key);
	if (!terminal) {
		return;
	}
	terminal.dispose();
	terminals.delete(key);
}

export function disposeAllPersistentTerminalsForWorkspace(workspaceId: string): void {
	for (const [key, terminal] of terminals.entries()) {
		if (!key.startsWith(`${workspaceId}:`)) {
			continue;
		}
		terminal.dispose();
		terminals.delete(key);
	}
}
