/**
 * Regression tests for the batched task-chat broadcast in `runtime-state-hub.ts`.
 *
 * Token deltas are buffered for TASK_CHAT_STREAM_BATCH_MS (50 ms) before they
 * flush. A `task_chat_cleared` frame must never be overtaken by deltas that are
 * still sitting in that window: the web UI reducer empties the task's message
 * list on clear and upserts on every delta, so a late flush resurrects content
 * the user just wiped.
 *
 * These drive the real hub over a real WebSocket, but fully in-process (no CLI
 * subprocess), so they stay in the fast suite.
 */

import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { ClineTaskMessage } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeBoardData, RuntimeStateStreamMessage } from "../../../src/core/api-contract";
import { createRuntimeStateHub, type RuntimeStateHub } from "../../../src/server/runtime-state-hub";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

const WORKSPACE_ID = "ws-hub-test";
// Comfortably above the 50 ms batch window, so "nothing arrived" assertions are meaningful.
const SETTLE_MS = 200;

interface HubTestHarness {
	hub: RuntimeStateHub;
	messages: RuntimeStateStreamMessage[];
	close: () => Promise<void>;
}

function createEmptyBoard(): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: [] },
		],
		dependencies: [],
	};
}

function createMessage(id: string): ClineTaskMessage {
	return {
		id,
		role: "assistant",
		content: `delta-${id}`,
		createdAt: Date.now(),
	};
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const REGISTRATION_PROBE_TASK_ID = "__registration-probe__";

/**
 * `broadcastTaskReadyForReview` fans out over the same per-workspace client set
 * that chat broadcasts use and sends immediately, so a landed probe proves the
 * socket is registered for `WORKSPACE_ID`. Probe frames are identified by their
 * task id and never interact with the chat assertions below.
 */
async function waitForRegistration(hub: RuntimeStateHub, messages: RuntimeStateStreamMessage[]): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		hub.broadcastTaskReadyForReview(WORKSPACE_ID, REGISTRATION_PROBE_TASK_ID);
		const registered = messages.some(
			(message) => message.type === "task_ready_for_review" && message.taskId === REGISTRATION_PROBE_TASK_ID,
		);
		if (registered) {
			return;
		}
		await sleep(20);
	}
	throw new Error("Timed out waiting for the runtime state client to register for its workspace.");
}

async function waitFor<T>(read: () => T | null | undefined, description: string, timeoutMs = 2_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== null && value !== undefined) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${description}.`);
		}
		await sleep(10);
	}
}

async function createHarness(workspacePath: string): Promise<HubTestHarness> {
	const hub = createRuntimeStateHub({
		workspaceRegistry: {
			resolveWorkspaceForStream: async () => ({
				workspaceId: WORKSPACE_ID,
				workspacePath,
				removedRequestedWorkspacePath: null,
				didPruneProjects: false,
			}),
			buildProjectsPayload: async () => ({ currentProjectId: WORKSPACE_ID, projects: [] }),
			buildWorkspaceStateSnapshot: async () => ({
				repoPath: workspacePath,
				statePath: workspacePath,
				git: { currentBranch: null, defaultBranch: null, branches: [] },
				board: createEmptyBoard(),
				sessions: {},
				revision: 0,
			}),
		},
	});

	const server = createServer((_request, response) => {
		response.statusCode = 404;
		response.end();
	});
	server.on("upgrade", (request, socket, head) => {
		hub.handleUpgrade(request, socket, head, { requestedWorkspaceId: WORKSPACE_ID });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	const socket = new WebSocket(`ws://127.0.0.1:${port}/api/runtime/ws`);
	const messages: RuntimeStateStreamMessage[] = [];
	socket.on("message", (data) => {
		messages.push(JSON.parse(String(data)) as RuntimeStateStreamMessage);
	});
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	await waitFor(() => messages.some((message) => message.type === "snapshot"), "the initial snapshot");
	// The snapshot is written before the hub registers the socket under its
	// workspace, so a broadcast immediately after the snapshot can still be
	// dropped. Probe with a per-workspace broadcast until one actually lands.
	await waitForRegistration(hub, messages);

	return {
		hub,
		messages,
		close: async () => {
			socket.terminate();
			await hub.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

function chatMessagesFor(messages: RuntimeStateStreamMessage[], taskId: string): ClineTaskMessage[] {
	return messages.flatMap((message) =>
		message.type === "task_chat_message" && message.taskId === taskId ? [message.message] : [],
	);
}

describe("createRuntimeStateHub task chat batching", () => {
	let harness: HubTestHarness;
	let tempDir: ReturnType<typeof createTempDir>;

	beforeEach(async () => {
		tempDir = createTempDir("kanban-hub-test-");
		// The hub probes git metadata while connecting a workspace client, so the
		// workspace path has to be a real repository.
		execFileSync("git", ["init", "-q"], { cwd: tempDir.path, env: createGitTestEnv() });
		harness = await createHarness(tempDir.path);
	});

	afterEach(async () => {
		await harness.close();
		tempDir.cleanup();
	});

	it("flushes buffered deltas within the batch window", async () => {
		harness.hub.broadcastTaskChatMessage(WORKSPACE_ID, "task-1", createMessage("delta-1"));

		const delivered = await waitFor(
			() => chatMessagesFor(harness.messages, "task-1")[0] ?? null,
			"the batched chat delta",
		);
		expect(delivered.id).toBe("delta-1");
	});

	it("drops buffered deltas for a cleared task so none can arrive after the cleared frame", async () => {
		harness.hub.broadcastTaskChatMessage(WORKSPACE_ID, "task-1", createMessage("delta-1"));
		harness.hub.broadcastTaskChatMessage(WORKSPACE_ID, "task-1", createMessage("delta-2"));
		harness.hub.broadcastTaskChatCleared(WORKSPACE_ID, "task-1");

		await waitFor(
			() => harness.messages.find((message) => message.type === "task_chat_cleared") ?? null,
			"the cleared frame",
		);
		await sleep(SETTLE_MS);

		expect(chatMessagesFor(harness.messages, "task-1")).toEqual([]);
		const clearedIndex = harness.messages.findIndex((message) => message.type === "task_chat_cleared");
		expect(clearedIndex).toBeGreaterThanOrEqual(0);
		const framesAfterClear = harness.messages
			.slice(clearedIndex + 1)
			.filter((message) => message.type === "task_chat_message");
		expect(framesAfterClear).toEqual([]);
	});

	it("keeps buffered deltas for other tasks when one task is cleared", async () => {
		harness.hub.broadcastTaskChatMessage(WORKSPACE_ID, "task-1", createMessage("delta-1"));
		harness.hub.broadcastTaskChatMessage(WORKSPACE_ID, "task-2", createMessage("delta-2"));
		harness.hub.broadcastTaskChatCleared(WORKSPACE_ID, "task-1");

		const survivingDelta = await waitFor(
			() => chatMessagesFor(harness.messages, "task-2")[0] ?? null,
			"the surviving task-2 delta",
		);
		await sleep(SETTLE_MS);

		expect(survivingDelta.id).toBe("delta-2");
		expect(chatMessagesFor(harness.messages, "task-1")).toEqual([]);
	});
});
