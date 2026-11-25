import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	disposeAllPersistentTerminalsForWorkspace,
	ensurePersistentTerminal,
} from "@/terminal/persistent-terminal-manager";
import {
	resetTerminalTypography,
	setTerminalFontSize,
	setTerminalLetterSpacing,
	setTerminalLineHeight,
} from "@/terminal/terminal-typography";

type TerminalOptionsSnapshot = {
	fontSize?: number;
	letterSpacing?: number;
	lineHeight?: number;
	theme: Record<string, unknown>;
};

const xtermMock = vi.hoisted(() => ({
	instances: [] as Array<{
		cols: number;
		rows: number;
		options: { fontSize?: number; letterSpacing?: number; lineHeight?: number; theme: Record<string, unknown> };
		unicode: { activeVersion: string };
		loadAddon: ReturnType<typeof vi.fn>;
		open: ReturnType<typeof vi.fn>;
		onData: ReturnType<typeof vi.fn>;
		onBinary: ReturnType<typeof vi.fn>;
		attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
		write: ReturnType<typeof vi.fn>;
		reset: ReturnType<typeof vi.fn>;
		resize: ReturnType<typeof vi.fn>;
		input: ReturnType<typeof vi.fn>;
		paste: ReturnType<typeof vi.fn>;
		focus: ReturnType<typeof vi.fn>;
		clear: ReturnType<typeof vi.fn>;
		dispose: ReturnType<typeof vi.fn>;
		hasSelection: ReturnType<typeof vi.fn>;
		getSelection: ReturnType<typeof vi.fn>;
	}>,
	fitCount: 0,
	resetCount: 0,
	writes: [] as string[],
}));

vi.mock("@xterm/xterm", () => {
	class Terminal {
		cols = 80;
		rows = 24;
		options: { fontSize?: number; letterSpacing?: number; lineHeight?: number; theme: Record<string, unknown> };
		unicode = { activeVersion: "" };
		loadAddon = vi.fn();
		open = vi.fn();
		onData = vi.fn();
		onBinary = vi.fn();
		attachCustomKeyEventHandler = vi.fn();
		write = vi.fn((data: string | Uint8Array, callback?: () => void) => {
			xtermMock.writes.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			callback?.();
		});
		reset = vi.fn(() => {
			xtermMock.resetCount += 1;
		});
		resize = vi.fn();
		input = vi.fn();
		paste = vi.fn();
		focus = vi.fn();
		clear = vi.fn();
		dispose = vi.fn();
		hasSelection = vi.fn(() => false);
		getSelection = vi.fn(() => "");

		constructor(options: Partial<TerminalOptionsSnapshot> = {}) {
			this.options = {
				fontSize: options.fontSize,
				letterSpacing: options.letterSpacing,
				lineHeight: options.lineHeight,
				theme: options.theme ?? {},
			};
			xtermMock.instances.push(this);
		}
	}

	return { Terminal };
});

vi.mock("@xterm/addon-clipboard", () => ({ ClipboardAddon: class {} }));
vi.mock("@xterm/addon-fit", () => ({
	FitAddon: class {
		fit() {
			xtermMock.fitCount += 1;
		}
	},
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));
vi.mock("@xterm/addon-webgl", () => ({
	WebglAddon: class {
		onContextLoss() {}
		dispose() {}
	},
}));

const WORKSPACE_ID = "workspace-1";
const DEFAULT_TASK_ID = "task-a";
const APPEARANCE = {
	cursorColor: "cursor-color",
	terminalBackgroundColor: "terminal-background",
};
const IO_URL_FRAGMENT = "/api/terminal/io";
const CONTROL_URL_FRAGMENT = "/api/terminal/control";
const STREAM_CLOSED_ERROR = "Terminal stream closed. Close and reopen to reconnect.";
const CONTROL_CLOSED_ERROR = "Terminal control connection closed. Close and reopen to reconnect.";
const REPLACED_STREAM_REASON = "Replaced by newer terminal stream.";
const REPLACED_CONTROL_REASON = "Replaced by newer terminal control connection.";
const TASK_NOT_RUNNING_REASON = "Task session is not running.";

type SocketEvent = { data?: unknown; code?: number; reason?: string };
type SocketListener = (event: SocketEvent) => void;

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readyState = FakeWebSocket.CONNECTING;
	binaryType = "blob";
	onopen: (() => void) | null = null;
	onmessage: SocketListener | null = null;
	onerror: (() => void) | null = null;
	onclose: SocketListener | null = null;
	readonly sent: unknown[] = [];
	private readonly listeners = new Map<string, Set<SocketListener>>();

	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: SocketListener): void {
		const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: SocketListener): void {
		this.listeners.get(type)?.delete(listener);
	}

	send(data: unknown): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.();
		this.dispatch("open", {});
	}

	receive(data: unknown): void {
		const event = { data };
		this.onmessage?.(event);
		this.dispatch("message", event);
	}

	fail(code = 1006, reason = ""): void {
		this.readyState = FakeWebSocket.CLOSED;
		const event = { code, reason };
		this.onclose?.(event);
		this.dispatch("close", event);
	}

	private dispatch(type: string, event: SocketEvent): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}
}

class FakeResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}

interface Harness {
	terminal: ReturnType<typeof ensurePersistentTerminal>;
	ready: ReturnType<typeof vi.fn>;
	errors: Array<string | null>;
	reconnectingStates: boolean[];
}

function createHarness(taskId = DEFAULT_TASK_ID): Harness {
	const terminal = ensurePersistentTerminal({
		taskId,
		workspaceId: WORKSPACE_ID,
		...APPEARANCE,
	});
	const ready = vi.fn();
	const errors: Array<string | null> = [];
	const reconnectingStates: boolean[] = [];
	terminal.subscribe({
		onConnectionReady: ready,
		onLastError: (message) => {
			errors.push(message);
		},
		onReconnectingChange: (reconnecting) => {
			reconnectingStates.push(reconnecting);
		},
	});
	return { terminal, ready, errors, reconnectingStates };
}

function getSockets(): { io: FakeWebSocket[]; control: FakeWebSocket[] } {
	return {
		io: FakeWebSocket.instances.filter((socket) => socket.url.includes(IO_URL_FRAGMENT)),
		control: FakeWebSocket.instances.filter((socket) => socket.url.includes(CONTROL_URL_FRAGMENT)),
	};
}

function lastSocket(sockets: FakeWebSocket[]): FakeWebSocket {
	const socket = sockets[sockets.length - 1];
	if (!socket) {
		throw new Error("Expected a terminal websocket to exist.");
	}
	return socket;
}

function getLatestPair(): { io: FakeWebSocket; control: FakeWebSocket } {
	const sockets = getSockets();
	return {
		io: lastSocket(sockets.io),
		control: lastSocket(sockets.control),
	};
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index += 1) {
		await Promise.resolve();
	}
}

function sendRestore(socket: FakeWebSocket, snapshot: string): void {
	socket.receive(
		JSON.stringify({
			type: "restore",
			snapshot,
			cols: 100,
			rows: 40,
		}),
	);
}

async function establishReadyConnection(taskId = DEFAULT_TASK_ID): Promise<Harness> {
	const harness = createHarness(taskId);
	const pair = getLatestPair();
	pair.control.open();
	pair.io.open();
	sendRestore(pair.control, "snapshot-1");
	await flushMicrotasks();
	expect(harness.ready).toHaveBeenCalledTimes(1);
	return harness;
}

describe("persistent terminal reconnect", () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		xtermMock.instances.length = 0;
		xtermMock.fitCount = 0;
		xtermMock.resetCount = 0;
		xtermMock.writes.length = 0;
		localStorage.clear();
		resetTerminalTypography();
		vi.useFakeTimers();
		vi.stubGlobal("WebSocket", FakeWebSocket);
		vi.stubGlobal("ResizeObserver", FakeResizeObserver);
	});

	afterEach(() => {
		disposeAllPersistentTerminalsForWorkspace(WORKSPACE_ID);
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("automatically reopens both sockets after an unexpected close", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1006);

		expect(pair.control.readyState).toBe(FakeWebSocket.CLOSED);
		expect(harness.reconnectingStates.at(-1)).toBe(true);
		expect(harness.errors.at(-1)).toBeNull();
		expect(getSockets().io).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(499);
		expect(getSockets().io).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(getSockets().io).toHaveLength(2);
		expect(getSockets().control).toHaveLength(2);
		expect(harness.ready).toHaveBeenCalledTimes(1);

		const reconnectPair = getLatestPair();
		reconnectPair.control.open();
		reconnectPair.io.open();
		sendRestore(reconnectPair.control, "snapshot-2");
		await flushMicrotasks();

		expect(reconnectPair.control.sent).toEqual([JSON.stringify({ type: "restore_complete" })]);
		expect(harness.ready).toHaveBeenCalledTimes(2);
		expect(harness.reconnectingStates.at(-1)).toBe(false);
	});

	it("reconnects both sockets when the control socket drops", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.control.fail(1006);

		expect(pair.io.readyState).toBe(FakeWebSocket.CLOSED);
		expect(harness.reconnectingStates.at(-1)).toBe(true);

		await vi.advanceTimersByTimeAsync(500);

		expect(getSockets().io).toHaveLength(2);
		expect(getSockets().control).toHaveLength(2);
	});

	it("runs the full restore handshake before reporting ready on reconnect", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1006);
		await vi.advanceTimersByTimeAsync(500);

		const reconnectPair = getLatestPair();
		reconnectPair.io.open();

		expect(harness.ready).toHaveBeenCalledTimes(1);
		expect(reconnectPair.control.sent).toHaveLength(0);

		reconnectPair.control.open();
		expect(harness.ready).toHaveBeenCalledTimes(1);

		sendRestore(reconnectPair.control, "snapshot-2");
		await flushMicrotasks();

		expect(xtermMock.resetCount).toBe(2);
		expect(xtermMock.writes).toContain("snapshot-2");
		expect(reconnectPair.control.sent).toEqual([JSON.stringify({ type: "restore_complete" })]);
		expect(harness.ready).toHaveBeenCalledTimes(2);
		expect(harness.reconnectingStates.at(-1)).toBe(false);
	});

	it.each([
		["online", () => window.dispatchEvent(new Event("online"))],
		["pageshow", () => window.dispatchEvent(new Event("pageshow"))],
		["visibilitychange", () => document.dispatchEvent(new Event("visibilitychange"))],
	])("retries immediately on %s and resets the backoff", async (_eventName, trigger) => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1006);
		await vi.advanceTimersByTimeAsync(500);
		expect(getSockets().io).toHaveLength(2);

		getLatestPair().io.fail(1006);

		trigger();

		expect(getSockets().io).toHaveLength(3);
		expect(getSockets().control).toHaveLength(3);
		expect(harness.reconnectingStates.at(-1)).toBe(true);
	});

	it("does not create duplicate sockets while a retry is pending", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();
		const container = document.createElement("div");
		document.body.appendChild(container);

		pair.io.fail(1006);
		harness.terminal.mount(container, APPEARANCE, { isVisible: false });
		harness.terminal.mount(container, APPEARANCE, { isVisible: false });

		expect(getSockets().io).toHaveLength(1);

		window.dispatchEvent(new Event("online"));
		window.dispatchEvent(new Event("online"));

		expect(getSockets().io).toHaveLength(2);
		expect(getSockets().control).toHaveLength(2);
		container.remove();
	});

	it("stops reconnecting when the server replaces the stream", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1000, REPLACED_STREAM_REASON);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getSockets().io).toHaveLength(1);
		expect(pair.control.readyState).toBe(FakeWebSocket.OPEN);
		expect(harness.errors.at(-1)).toBe(STREAM_CLOSED_ERROR);
		expect(harness.reconnectingStates.at(-1)).toBe(false);
	});

	it("stops reconnecting when the control connection is replaced", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.control.fail(1000, REPLACED_CONTROL_REASON);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getSockets().control).toHaveLength(1);
		expect(pair.io.readyState).toBe(FakeWebSocket.OPEN);
		expect(harness.errors.at(-1)).toBe(CONTROL_CLOSED_ERROR);
		expect(harness.reconnectingStates.at(-1)).toBe(false);
	});

	it("stops reconnecting when the task session is gone", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1011, TASK_NOT_RUNNING_REASON);
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getSockets().io).toHaveLength(1);
		expect(harness.errors.at(-1)).toBe(STREAM_CLOSED_ERROR);
		expect(harness.reconnectingStates.at(-1)).toBe(false);
	});

	it("still retries an internal error without the task-session-gone reason", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();

		pair.io.fail(1011, "pty write failed");
		expect(harness.reconnectingStates.at(-1)).toBe(true);

		await vi.advanceTimersByTimeAsync(500);

		expect(getSockets().io).toHaveLength(2);
		expect(harness.errors.at(-1)).toBeNull();
	});

	it("exhausts the retry budget, surfaces the error, and recovers on a wake event", async () => {
		const harness = await establishReadyConnection();

		for (const delay of [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000, 5_000]) {
			getLatestPair().io.fail(1006);
			await vi.advanceTimersByTimeAsync(delay);
		}

		expect(getSockets().io).toHaveLength(9);

		getLatestPair().io.fail(1006);

		expect(harness.reconnectingStates.at(-1)).toBe(false);
		expect(harness.errors.at(-1)).toBe(STREAM_CLOSED_ERROR);

		await vi.advanceTimersByTimeAsync(60_000);
		expect(getSockets().io).toHaveLength(9);

		window.dispatchEvent(new Event("online"));
		expect(getSockets().io).toHaveLength(10);
	});

	it("cleans up the reconnect timer and wake listeners on dispose", async () => {
		const harness = await establishReadyConnection();
		const pair = getLatestPair();
		const container = document.createElement("div");
		document.body.appendChild(container);
		harness.terminal.mount(container, APPEARANCE, { isVisible: false });

		pair.io.fail(1006);
		expect(harness.reconnectingStates.at(-1)).toBe(true);

		harness.terminal.dispose();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(getSockets().io).toHaveLength(1);
		expect(harness.reconnectingStates.at(-1)).toBe(false);

		window.dispatchEvent(new Event("online"));
		expect(getSockets().io).toHaveLength(1);
		container.remove();
	});

	it("creates terminals with the persisted typography", async () => {
		setTerminalFontSize(17);
		setTerminalLineHeight(1.2);
		setTerminalLetterSpacing(0.5);

		await establishReadyConnection();

		const terminal = xtermMock.instances.at(-1);
		expect(terminal?.options.fontSize).toBe(17);
		expect(terminal?.options.lineHeight).toBe(1.2);
		expect(terminal?.options.letterSpacing).toBe(0.5);
	});

	it("applies a live typography change in place and re-fits the PTY", async () => {
		const harness = await establishReadyConnection();
		const container = document.createElement("div");
		document.body.appendChild(container);
		harness.terminal.mount(container, APPEARANCE, { isVisible: false });

		const terminal = xtermMock.instances.at(-1);
		expect(terminal?.options.fontSize).toBe(13);

		const control = getLatestPair().control;
		control.sent.length = 0;
		const fitCountBeforeChange = xtermMock.fitCount;

		setTerminalFontSize(18);

		expect(terminal?.options.fontSize).toBe(18);
		expect(xtermMock.fitCount).toBe(fitCountBeforeChange + 1);
		const sentMessages = control.sent.map((message) => JSON.parse(String(message)) as { type: string });
		expect(sentMessages).toContainEqual(expect.objectContaining({ type: "resize" }));
		// The terminal is updated in place: nothing is recreated or remounted.
		expect(xtermMock.instances).toHaveLength(1);
		container.remove();
	});

	it("stops following typography changes after dispose", async () => {
		const harness = await establishReadyConnection();
		const terminal = xtermMock.instances.at(-1);

		harness.terminal.dispose();
		setTerminalFontSize(20);

		expect(terminal?.options.fontSize).toBe(13);
	});
});
