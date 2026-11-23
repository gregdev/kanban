import { EditorView } from "@codemirror/view";
import React, { act, createRef, forwardRef, type ReactElement, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClineAgentChatPanel, type ClineAgentChatPanelHandle } from "@/components/detail-panels/cline-agent-chat-panel";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ClineChatMessage } from "@/hooks/use-cline-chat-session";
import type { RuntimeTaskHookActivity, RuntimeTaskSessionSummary } from "@/runtime/types";
import { resetWorkspaceMetadataStore, setTaskWorkspaceSnapshot } from "@/stores/workspace-metadata-store";

const virtuosoLastProps = vi.hoisted(() => ({
	current: null as {
		followOutput?: boolean | string;
		atBottomThreshold?: number;
		atBottomStateChange?: (atBottom: boolean) => void;
	} | null,
}));

const virtuosoScrollToIndexMock = vi.hoisted(() => vi.fn());

vi.mock("react-virtuoso", () => ({
	Virtuoso: forwardRef(function MockVirtuoso(
		{
			data,
			itemContent,
			components,
			context,
			className,
			style,
			followOutput,
			atBottomThreshold,
			atBottomStateChange,
		}: {
			data: unknown[];
			itemContent: (index: number, item: unknown) => React.ReactNode;
			components?: { Footer?: React.ComponentType<{ context?: unknown }> };
			context?: unknown;
			className?: string;
			style?: React.CSSProperties;
			followOutput?: boolean | string;
			atBottomThreshold?: number;
			atBottomStateChange?: (atBottom: boolean) => void;
		},
		ref,
	) {
		virtuosoLastProps.current = { followOutput, atBottomThreshold, atBottomStateChange };
		useImperativeHandle(ref, () => ({ scrollToIndex: virtuosoScrollToIndexMock }));
		return (
			<div className={`overflow-y-auto ${className ?? ""}`} style={style}>
				{data.map((item, index) => (
					<div key={index}>{itemContent(index, item)}</div>
				))}
				{components?.Footer ? <components.Footer context={context} /> : null}
			</div>
		);
	}),
}));

function createSummary(
	state: RuntimeTaskSessionSummary["state"],
	latestHookActivity: RuntimeTaskHookActivity | null = null,
	overrides: Partial<RuntimeTaskSessionSummary> = {},
): RuntimeTaskSessionSummary {
	return {
		taskId: "task-1",
		state,
		agentId: "cline",
		workspacePath: "/tmp/worktree",
		pid: null,
		startedAt: Date.now(),
		updatedAt: Date.now(),
		lastOutputAt: Date.now(),
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity,
		latestTurnCheckpoint: null,
		previousTurnCheckpoint: null,
		...overrides,
	};
}

function renderPanel(root: Root, panel: ReactElement): void {
	root.render(<TooltipProvider>{panel}</TooltipProvider>);
}

/** The composer renders a CodeMirror editor; these helpers drive it like a user would. */
function getComposerEditor(container: HTMLElement): EditorView {
	const editor = container.querySelector<HTMLElement>(".cm-editor");
	if (!editor) {
		throw new Error("Expected the composer editor");
	}
	const view = EditorView.findFromDOM(editor);
	if (!view) {
		throw new Error("Expected an attached EditorView");
	}
	return view;
}

function setComposerText(view: EditorView, text: string): void {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: text },
		selection: { anchor: text.length },
	});
}

function pressComposerKey(view: EditorView, init: KeyboardEventInit): void {
	view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("ClineAgentChatPanel", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		virtuosoLastProps.current = null;
		virtuosoScrollToIndexMock.mockClear();
		resetWorkspaceMetadataStore();
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		act(() => {
			root.unmount();
		});
		resetWorkspaceMetadataStore();
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("renders reasoning and tool messages with specialized UI", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "reasoning-1",
				role: "reasoning",
				content: "Thinking through the next edit",
				createdAt: 1,
			},
			{
				id: "tool-1",
				role: "tool",
				content: [
					"Tool: Read",
					"Input:",
					'{"file":"src/index.ts"}',
					"Output:",
					'{"ok":true}',
					"Duration: 21ms",
				].join("\n"),
				createdAt: 2,
				meta: {
					hookEventName: "tool_call_start",
					toolName: "Read",
					streamType: "tool",
				},
			},
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => messages} />,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Reasoning");
		expect(container.textContent).not.toContain("Thinking through the next edit");

		const reasoningToggle = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Reasoning"),
		);
		expect(reasoningToggle).toBeInstanceOf(HTMLButtonElement);
		if (!(reasoningToggle instanceof HTMLButtonElement)) {
			throw new Error("Expected reasoning toggle button");
		}
		await act(async () => {
			reasoningToggle.click();
		});

		expect(container.textContent).toContain("Thinking through the next edit");
		expect(container.textContent).toContain("Read");
		expect(container.textContent).toContain("src/index.ts");
		expect(container.textContent).not.toContain("Input");
		expect(container.textContent).not.toContain("Output");
		expect(container.textContent).not.toContain("21ms");

		const toolToggle = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Read"),
		);
		expect(toolToggle).toBeInstanceOf(HTMLButtonElement);
		if (!(toolToggle instanceof HTMLButtonElement)) {
			throw new Error("Expected tool toggle button");
		}

		await act(async () => {
			toolToggle.click();
		});

		expect(container.textContent).toContain("Output");
		expect(container.textContent).toContain('{"ok":true}');
	});

	it("keeps completed reasoning collapsed after the stream finishes", async () => {
		const onLoadMessages = vi.fn(async () => []);
		const streamingReasoningMessage: ClineChatMessage = {
			id: "reasoning-1",
			role: "reasoning",
			content: "Thinking through the next edit",
			createdAt: 1,
			meta: {
				hookEventName: "reasoning_delta",
				streamType: "reasoning",
			},
		};
		const completedReasoningMessage: ClineChatMessage = {
			...streamingReasoningMessage,
			meta: {
				hookEventName: "reasoning_end",
				streamType: "reasoning",
			},
		};

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={onLoadMessages}
					incomingMessage={streamingReasoningMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Thinking through the next edit");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={onLoadMessages}
					incomingMessage={completedReasoningMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).not.toContain("Thinking through the next edit");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("awaiting_review")}
					onLoadMessages={onLoadMessages}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).not.toContain("Thinking through the next edit");
	});

	it("shows running progress indicator while session is running", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={createSummary("running")} onLoadMessages={async () => []} />,
			);
			await Promise.resolve();
		});

		const thinkingSpinner = container.querySelector('[data-testid="cline-thinking-spinner"]');
		expect(thinkingSpinner?.textContent).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
		expect(container.textContent).toContain("Thinking...");
		expect(container.textContent).not.toContain("Cline chat");
	});

	it("shows a compact warning below the composer when the session has a warning", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={{
						...createSummary("running"),
						warningMessage:
							'Failed to load MCP server "linear": MCP server "linear" requires OAuth authorization.',
					}}
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain('Failed to load MCP server "linear"');
	});

	it("renders a chat-level out-of-credits notice when credit-limit metadata is present", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary(
						"awaiting_review",
						{
							activityText: "Agent error: 402 Insufficient balance",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "402 Insufficient balance. Your Cline Credits balance is $0.00",
							hookEventName: "agent_error",
							notificationType: "credit_limit",
							source: "cline-sdk",
						},
						{ reviewReason: "error" },
					)}
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		await vi.waitFor(() => {
			const buyCreditsLink = container.querySelector('a[href="https://app.cline.bot/"]');
			expect(buyCreditsLink).toBeInstanceOf(HTMLAnchorElement);
		});
		expect(container.textContent).toContain("Out of Cline credits.");
	});

	it("shows out-of-credits notice after interrupted state when credit-limit metadata persists", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary(
						"interrupted",
						{
							activityText: "Agent error: 402 Insufficient balance",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "402 Insufficient balance. Your Cline Credits balance is $0.00",
							hookEventName: "agent_end",
							notificationType: "credit_limit",
							source: "cline-sdk",
						},
						{ reviewReason: "interrupted" },
					)}
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		await vi.waitFor(() => {
			const buyCreditsLink = container.querySelector('a[href="https://app.cline.bot/"]');
			expect(buyCreditsLink).toBeInstanceOf(HTMLAnchorElement);
		});
	});

	it("offers a resume action for a turn stopped by an error", async () => {
		const onResumeTurn = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("awaiting_review", null, { reviewReason: "error" })}
					onLoadMessages={async () => []}
					onResumeTurn={onResumeTurn}
				/>,
			);
			await Promise.resolve();
		});

		const resumeButton = Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Resume turn"),
		);
		expect(resumeButton).toBeInstanceOf(HTMLButtonElement);
		if (!(resumeButton instanceof HTMLButtonElement)) {
			throw new Error("Expected resume turn button");
		}

		await act(async () => {
			resumeButton.click();
			await Promise.resolve();
		});

		expect(onResumeTurn).toHaveBeenCalledWith("task-1");
	});

	it("offers a resume action for an interrupted turn", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("interrupted", null, { reviewReason: "interrupted" })}
					onLoadMessages={async () => []}
					onResumeTurn={async () => ({ ok: true })}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Resume turn");
	});

	it("does not offer resume while the turn is running or for attention-only reviews", async () => {
		const onResumeTurn = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running", null, { reviewReason: "error" })}
					onLoadMessages={async () => []}
					onResumeTurn={onResumeTurn}
				/>,
			);
			await Promise.resolve();
		});
		expect(container.textContent).not.toContain("Resume turn");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("awaiting_review", null, { reviewReason: "attention" })}
					onLoadMessages={async () => []}
					onResumeTurn={onResumeTurn}
				/>,
			);
			await Promise.resolve();
		});
		expect(container.textContent).not.toContain("Resume turn");
	});

	it("hides resume when the turn stopped on a credit-limit error", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary(
						"awaiting_review",
						{
							activityText: "Agent error: 402 Insufficient balance",
							toolName: null,
							toolInputSummary: null,
							finalMessage: "402 Insufficient balance. Your Cline Credits balance is $0.00",
							hookEventName: "agent_error",
							notificationType: "credit_limit",
							source: "cline-sdk",
						},
						{ reviewReason: "error" },
					)}
					onLoadMessages={async () => []}
					onResumeTurn={async () => ({ ok: true })}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).not.toContain("Resume turn");
		expect(container.textContent).toContain("Out of Cline credits");
	});

	it("renders user message images inline without a task header", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={async () => [
						{
							id: "msg-1",
							role: "user",
							content: "Please inspect this screenshot",
							images: [
								{
									id: "img-1",
									data: "abc123",
									mimeType: "image/png",
									name: "error.png",
								},
							],
							createdAt: 1,
						},
					]}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Please inspect this screenshot");
		expect(container.textContent).toContain("error.png");
		expect(container.textContent).not.toContain("Task images");
		const image = container.querySelector('img[alt="error.png"]');
		expect(image).toBeInstanceOf(HTMLImageElement);
	});

	it("marks a queued prompt as pending until the agent reads it", async () => {
		const assistantMessage: ClineChatMessage = {
			id: "assistant-1",
			role: "assistant",
			content: "Working on it",
			createdAt: 1,
		};
		const queuedMessage: ClineChatMessage = {
			id: "user-1",
			role: "user",
			content: "Also update the changelog",
			createdAt: 2,
			meta: { deliveryState: "pending" },
		};
		const deliveredMessage: ClineChatMessage = {
			id: "user-1",
			role: "user",
			content: "Also update the changelog",
			createdAt: 2,
			meta: { deliveryState: null },
		};

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={async () => [assistantMessage, queuedMessage]}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Also update the changelog");
		expect(container.textContent).toContain("Queued · the agent reads this when the current turn finishes");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={async () => [assistantMessage]}
					incomingMessage={deliveredMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Also update the changelog");
		expect(container.textContent).not.toContain("Queued · the agent reads this");
	});

	it("renders fenced code in a user message with syntax highlighting", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => [
						{
							id: "user-1",
							role: "user",
							content: "this fails\n```ts\nconst value = 42;\n```\ntry again",
							createdAt: 1,
						},
					]}
				/>,
			);
			await Promise.resolve();
		});

		// The prompt a user sends is persisted as a user message, so its code blocks
		// must be formatted like the assistant's, not dumped as literal backticks.
		const codeBlock = container.querySelector("pre.kb-markdown-code");
		expect(codeBlock).toBeInstanceOf(HTMLPreElement);
		expect(codeBlock?.textContent).toContain("const value = 42;");
		expect(codeBlock?.textContent).not.toContain("```");
		expect(codeBlock?.querySelector(".token.keyword")?.textContent).toBe("const");
		expect(container.textContent).toContain("this fails");
		expect(container.textContent).toContain("try again");
	});

	it("wraps renderer tables so a wide table cannot escape the transcript", async () => {
		const table = ["| Option | Notes |", "| --- | --- |", "| `alpha` | works well |"].join("\n");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => [{ id: "assistant-1", role: "assistant", content: table, createdAt: 1 }]}
				/>,
			);
			await Promise.resolve();
		});

		// A table cannot shrink below its cells' min-content width, so it must live in
		// a scroll container or the overflow is clipped with no way to reach it.
		const wrapper = container.querySelector(".kb-markdown-table");
		expect(wrapper).toBeInstanceOf(HTMLDivElement);
		expect(wrapper?.querySelector("table")).toBeInstanceOf(HTMLTableElement);
		expect(wrapper?.querySelector("th")?.textContent).toBe("Option");
		expect(wrapper?.querySelector("td")?.textContent).toBe("alpha");
	});

	it("renders newly streamed messages as they arrive", async () => {
		const initialMessages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "First reply",
				createdAt: 1,
			},
		];
		const incomingMessage: ClineChatMessage = {
			id: "assistant-2",
			role: "assistant",
			content: "Second reply",
			createdAt: 2,
		};

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => initialMessages} />,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("First reply");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={null}
					onLoadMessages={async () => initialMessages}
					incomingMessage={incomingMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("First reply");
		expect(container.textContent).toContain("Second reply");
		expect(virtuosoLastProps.current?.followOutput).toBe(true);
		expect(virtuosoLastProps.current?.atBottomThreshold).toBe(24);
	});

	it("renders all messages across multiple content updates", async () => {
		const initialMessages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "First reply",
				createdAt: 1,
			},
		];
		const secondMessage: ClineChatMessage = {
			id: "assistant-2",
			role: "assistant",
			content: "Second reply",
			createdAt: 2,
		};
		const thirdMessage: ClineChatMessage = {
			id: "assistant-3",
			role: "assistant",
			content: "Third reply",
			createdAt: 3,
		};

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => initialMessages} />,
			);
			await Promise.resolve();
		});

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={null}
					onLoadMessages={async () => initialMessages}
					incomingMessage={secondMessage}
				/>,
			);
			await Promise.resolve();
		});

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={null}
					onLoadMessages={async () => initialMessages}
					incomingMessage={thirdMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("First reply");
		expect(container.textContent).toContain("Second reply");
		expect(container.textContent).toContain("Third reply");
	});

	it("shows the thinking indicator while assistant text is streaming", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "Streaming reply",
				createdAt: 1,
			},
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running", {
						activityText: "Agent active",
						toolName: null,
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "assistant_delta",
						notificationType: null,
						source: "cline-sdk",
					})}
					onLoadMessages={async () => messages}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Streaming reply");
		expect(container.textContent).toContain("Thinking...");
	});

	it("shows the thinking indicator while a tool call is streaming", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "tool-1",
				role: "tool",
				content: ["Tool: Read", "Input:", '{"file":"src/index.ts"}'].join("\n"),
				createdAt: 1,
				meta: {
					hookEventName: "tool_call_start",
					toolName: "Read",
					streamType: "tool",
				},
			},
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running", {
						activityText: "Using Read",
						toolName: "Read",
						toolInputSummary: null,
						finalMessage: null,
						hookEventName: "tool_call",
						notificationType: null,
						source: "cline-sdk",
					})}
					onLoadMessages={async () => messages}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Read");
		expect(container.textContent).toContain("Thinking...");
	});

	it("renders assistant markdown including fenced code blocks", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "Here is code:\n```ts\nconst value = 1;\n```",
				createdAt: 1,
			},
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => messages} />,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Here is code:");
		expect(container.textContent).toContain("const value = 1;");
		expect(container.querySelector("pre code")).toBeTruthy();
	});

	it("applies wrapping styles to inline code in assistant markdown", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "Use `averylongidentifierwithnobreakpointswhatsoever1234567890` here.",
				createdAt: 1,
			},
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => messages} />,
			);
			await Promise.resolve();
		});

		const inlineCode = container.querySelector("p code");
		expect(inlineCode).toBeInstanceOf(HTMLElement);
		expect(inlineCode?.className).toContain("whitespace-pre-wrap");
		expect(inlineCode?.className).toContain("break-all");
	});

	it("autofocuses the composer, sends on enter, and cancels on escape", async () => {
		const onSendMessage = vi.fn(async () => ({
			ok: true,
			chatMessage: {
				id: "sent-1",
				role: "user" as const,
				content: "Ship it",
				createdAt: 2,
			},
		}));
		const onCancelTurn = vi.fn(async () => ({ ok: true }));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("running")}
					onLoadMessages={async () => []}
					onSendMessage={onSendMessage}
					onCancelTurn={onCancelTurn}
				/>,
			);
			await Promise.resolve();
		});

		const editor = getComposerEditor(container);
		expect(document.activeElement).toBe(editor.contentDOM);
		expect(container.textContent).toContain("Select model");
		// A running turn gets its own Stop button so sending a queued prompt stays possible.
		const stopButton = container.querySelector('button[aria-label="Stop agent"]');
		expect(stopButton).toBeInstanceOf(HTMLButtonElement);
		if (!(stopButton instanceof HTMLButtonElement)) {
			throw new Error("Expected composer stop button");
		}
		expect(stopButton.disabled).toBe(false);
		const sendButton = container.querySelector('button[aria-label="Queue message"]');
		expect(sendButton).toBeInstanceOf(HTMLButtonElement);
		if (!(sendButton instanceof HTMLButtonElement)) {
			throw new Error("Expected composer queue button");
		}
		expect(sendButton.disabled).toBe(true);
		expect(editor.contentDOM.getAttribute("aria-label")).toContain("Queue a message");

		await act(async () => {
			setComposerText(editor, "Ship it");
			await Promise.resolve();
		});

		expect(editor.state.doc.toString()).toBe("Ship it");
		expect(sendButton.disabled).toBe(false);

		await act(async () => {
			pressComposerKey(editor, { key: "Enter", keyCode: 13 });
			await Promise.resolve();
		});

		expect(onSendMessage).toHaveBeenCalledWith("task-1", "Ship it", { mode: "act" });

		await act(async () => {
			pressComposerKey(editor, { key: "Escape", keyCode: 27 });
			await Promise.resolve();
		});

		expect(onCancelTurn).toHaveBeenCalledWith("task-1");
	});

	it("defaults the composer mode from the task and sends using the selected mode", async () => {
		const onSendMessage = vi.fn(async () => ({
			ok: true,
			chatMessage: {
				id: "sent-2",
				role: "user" as const,
				content: "Investigate",
				createdAt: 2,
			},
		}));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					defaultMode="plan"
					onLoadMessages={async () => []}
					onSendMessage={onSendMessage}
				/>,
			);
			await Promise.resolve();
		});

		const planner = getComposerEditor(container);

		const planToggle = Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
			button.textContent?.includes("Plan"),
		);
		expect(planToggle?.getAttribute("aria-selected")).toBe("true");

		await act(async () => {
			setComposerText(planner, "Investigate");
			await Promise.resolve();
		});

		const sendButton = container.querySelector('button[aria-label="Send message"]');
		expect(sendButton).toBeInstanceOf(HTMLButtonElement);
		if (!(sendButton instanceof HTMLButtonElement)) {
			throw new Error("Expected composer send button");
		}

		await act(async () => {
			sendButton.click();
			await Promise.resolve();
		});

		expect(onSendMessage).toHaveBeenCalledWith("task-1", "Investigate", { mode: "plan" });
	});

	it("restores the previously selected mode when switching back to a task", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					defaultMode="act"
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		const planButton = Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
			button.textContent?.includes("Plan"),
		);
		expect(planButton).toBeInstanceOf(HTMLButtonElement);
		if (!(planButton instanceof HTMLButtonElement)) {
			throw new Error("Expected plan mode toggle");
		}

		await act(async () => {
			planButton.click();
			await Promise.resolve();
		});
		expect(planButton.getAttribute("aria-selected")).toBe("true");

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-2"
					summary={createSummary("idle", null, { taskId: "task-2" })}
					defaultMode="act"
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					defaultMode="act"
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		const restoredPlanButton = Array.from(container.querySelectorAll('button[role="tab"]')).find((button) =>
			button.textContent?.includes("Plan"),
		);
		expect(restoredPlanButton?.getAttribute("aria-selected")).toBe("true");
	});

	it("appends review comments into the composer draft through the panel handle", async () => {
		const panelRef = createRef<ClineAgentChatPanelHandle>();

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					ref={panelRef}
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => []}
				/>,
			);
			await Promise.resolve();
		});

		const editor = getComposerEditor(container);

		await act(async () => {
			setComposerText(editor, "Keep this");
			await Promise.resolve();
		});

		await act(async () => {
			panelRef.current?.appendToDraft("src/example.ts:4 | value\n> Add tests");
			await Promise.resolve();
		});

		expect(editor.state.doc.toString()).toBe("Keep this\n\nsrc/example.ts:4 | value\n> Add tests");
	});

	it("sends review comments through the panel handle without overwriting the draft", async () => {
		const panelRef = createRef<ClineAgentChatPanelHandle>();
		const onSendMessage = vi.fn(async () => ({
			ok: true,
			chatMessage: {
				id: "sent-review-comments",
				role: "user" as const,
				content: "src/example.ts:8 | done\n> Ship this",
				createdAt: 2,
			},
		}));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					ref={panelRef}
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => []}
					onSendMessage={onSendMessage}
				/>,
			);
			await Promise.resolve();
		});

		const editor = getComposerEditor(container);

		await act(async () => {
			setComposerText(editor, "Keep acting");
			await Promise.resolve();
		});

		await act(async () => {
			await panelRef.current?.sendText("src/example.ts:8 | done\n> Ship this");
		});

		expect(onSendMessage).toHaveBeenCalledWith("task-1", "src/example.ts:8 | done\n> Ship this", { mode: "act" });
		expect(editor.state.doc.toString()).toBe("Keep acting");
	});

	it("toggles the composer mode with command shift a", async () => {
		const onSendMessage = vi.fn(async () => ({
			ok: true,
			chatMessage: {
				id: "sent-3",
				role: "user" as const,
				content: "Switch it",
				createdAt: 2,
			},
		}));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => []}
					onSendMessage={onSendMessage}
				/>,
			);
			await Promise.resolve();
		});

		const editor = getComposerEditor(container);

		await act(async () => {
			pressComposerKey(editor, { key: "A", keyCode: 65, metaKey: true, shiftKey: true });
			await Promise.resolve();
		});

		await act(async () => {
			setComposerText(editor, "Switch it");
			await Promise.resolve();
		});

		const sendButton = container.querySelector('button[aria-label="Send message"]');
		expect(sendButton).toBeInstanceOf(HTMLButtonElement);
		if (!(sendButton instanceof HTMLButtonElement)) {
			throw new Error("Expected composer send button");
		}

		await act(async () => {
			sendButton.click();
			await Promise.resolve();
		});

		expect(onSendMessage).toHaveBeenCalledWith("task-1", "Switch it", { mode: "plan" });
	});

	it("hides the composer mode toggle when requested", async () => {
		const onSendMessage = vi.fn(async () => ({
			ok: true,
			chatMessage: {
				id: "sent-4",
				role: "user" as const,
				content: "Keep acting",
				createdAt: 2,
			},
		}));

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					showComposerModeToggle={false}
					onLoadMessages={async () => []}
					onSendMessage={onSendMessage}
				/>,
			);
			await Promise.resolve();
		});

		expect(container.querySelector('[aria-label="Cline mode"]')).toBeNull();

		const editor = getComposerEditor(container);

		await act(async () => {
			pressComposerKey(editor, { key: "A", keyCode: 65, metaKey: true, shiftKey: true });
			await Promise.resolve();
		});

		await act(async () => {
			setComposerText(editor, "Keep acting");
			await Promise.resolve();
		});

		const sendButton = container.querySelector('button[aria-label="Send message"]');
		expect(sendButton).toBeInstanceOf(HTMLButtonElement);
		if (!(sendButton instanceof HTMLButtonElement)) {
			throw new Error("Expected composer send button");
		}

		await act(async () => {
			sendButton.click();
			await Promise.resolve();
		});

		expect(onSendMessage).toHaveBeenCalledWith("task-1", "Keep acting", { mode: "act" });
	});

	it("renders action footer buttons when task enters review state", async () => {
		const messages: ClineChatMessage[] = [
			{
				id: "assistant-1",
				role: "assistant",
				content: "Done and ready for review.",
				createdAt: 1,
			},
		];
		setTaskWorkspaceSnapshot({
			taskId: "task-1",
			path: "/tmp/worktree",
			branch: "task-1",
			isDetached: false,
			headCommit: "abc1234",
			changedFiles: 2,
			additions: 3,
			deletions: 1,
		});

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("awaiting_review")}
					onLoadMessages={async () => messages}
					taskColumnId="review"
					onCommit={() => {}}
					onOpenPr={() => {}}
					onMoveToTrash={() => {}}
					showMoveToTrash
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Commit");
		expect(container.textContent).toContain("Open PR");
		expect(container.textContent).toContain("Move Card To Done");
	});

	it("does not show commit actions when the review workspace is clean", async () => {
		setTaskWorkspaceSnapshot({
			taskId: "task-1",
			path: "/tmp/worktree",
			branch: "task-1",
			isDetached: false,
			headCommit: "def5678",
			changedFiles: 0,
			additions: 0,
			deletions: 0,
		});

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("awaiting_review")}
					onLoadMessages={async () => []}
					taskColumnId="review"
					onCommit={() => {}}
					onOpenPr={() => {}}
					onMoveToTrash={() => {}}
					showMoveToTrash
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).not.toContain("Commit");
		expect(container.textContent).not.toContain("Open PR");
		expect(container.textContent).toContain("Move Card To Done");
	});

	it("shows the empty transcript notice instead of the message list when a read-only task has no messages", async () => {
		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => []}
					taskColumnId="trash"
					readOnly
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("No session transcript was recorded for this task.");
		expect(container.textContent).toContain("This task is done, so this transcript is read-only.");
		// The notice replaces the scroller rather than sitting above an empty one.
		expect(container.querySelector(".overflow-y-auto")).toBeNull();
	});

	it("renders recorded messages for a read-only task", async () => {
		const messages: ClineChatMessage[] = [
			{ id: "user-1", role: "user", content: "Rename the config flag", createdAt: 1 },
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel
					taskId="task-1"
					summary={createSummary("idle")}
					onLoadMessages={async () => messages}
					taskColumnId="trash"
					readOnly
				/>,
			);
			await Promise.resolve();
		});

		expect(container.textContent).toContain("Rename the config flag");
		expect(container.textContent).not.toContain("No session transcript was recorded for this task.");
		expect(virtuosoLastProps.current?.followOutput).toBe(true);
	});

	it("offers a scroll-to-bottom button only while the transcript is scrolled up", async () => {
		const messages: ClineChatMessage[] = [
			{ id: "assistant-1", role: "assistant", content: "First reply", createdAt: 1 },
		];

		await act(async () => {
			renderPanel(
				root,
				<ClineAgentChatPanel taskId="task-1" summary={null} onLoadMessages={async () => messages} />,
			);
			await Promise.resolve();
		});

		// The scroller starts pinned to the bottom, so there is nothing to jump back to yet.
		expect(container.querySelector('[aria-label="Scroll to bottom"]')).toBeNull();

		await act(async () => {
			virtuosoLastProps.current?.atBottomStateChange?.(false);
		});

		const scrollToBottomButton = container.querySelector<HTMLButtonElement>('[aria-label="Scroll to bottom"]');
		expect(scrollToBottomButton).toBeInstanceOf(HTMLButtonElement);
		if (!(scrollToBottomButton instanceof HTMLButtonElement)) {
			throw new Error("Expected the scroll-to-bottom button");
		}

		await act(async () => {
			scrollToBottomButton.click();
		});

		expect(virtuosoScrollToIndexMock).toHaveBeenCalledWith({ index: "LAST", align: "end", behavior: "smooth" });

		await act(async () => {
			virtuosoLastProps.current?.atBottomStateChange?.(true);
		});

		expect(container.querySelector('[aria-label="Scroll to bottom"]')).toBeNull();
	});
});
