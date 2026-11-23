import { Agent, createDefaultExecutors, createDefaultTools } from "@clinebot/core";
import type { AgentModel, AgentModelRequest, AgentTool } from "@clinebot/shared";
import { describe, expect, it } from "vitest";

const isWindows = process.platform === "win32";

function createRunCommandsTool(input: { cwd: string; timeoutMs?: number }): AgentTool {
	const executors = createDefaultExecutors(
		input.timeoutMs === undefined ? {} : { bash: { timeoutMs: input.timeoutMs } },
	);
	const bashExecutor = executors.bash;
	if (!bashExecutor) {
		throw new Error("Expected the SDK to provide a bash executor.");
	}
	const tools = createDefaultTools({
		cwd: input.cwd,
		...(input.timeoutMs === undefined ? {} : { bashTimeoutMs: input.timeoutMs }),
		executors: { bash: bashExecutor },
	});
	const tool = tools.find((candidate) => candidate.name === "run_commands");
	if (!tool) {
		throw new Error("Expected the SDK to create a run_commands tool.");
	}
	return tool;
}

function createScriptedModel(input: { command: string }): {
	model: AgentModel;
	requests: AgentModelRequest[];
} {
	const requests: AgentModelRequest[] = [];
	let turn = 0;
	const model: AgentModel = {
		async *stream(request) {
			requests.push(request);
			turn += 1;
			if (turn === 1) {
				yield {
					type: "tool-call-delta" as const,
					toolCallId: "call_1",
					toolName: "run_commands",
					input: { commands: [input.command] },
				};
				yield { type: "finish" as const, reason: "tool-calls" as const };
				return;
			}
			yield { type: "text-delta" as const, text: "done" };
			yield { type: "finish" as const, reason: "stop" as const };
		},
	};
	return { model, requests };
}

describe("run_commands tool override", () => {
	it.skipIf(isWindows)(
		"later extraTools with the same name shadow the SDK builtin for both the model and execution",
		async () => {
			const builtinTool = createRunCommandsTool({ cwd: process.cwd() });
			const overrideTool = createRunCommandsTool({ cwd: process.cwd(), timeoutMs: 250 });
			const { model, requests } = createScriptedModel({ command: "sleep 0.6" });

			// Core composes tools as [...builtinTools, ...extraTools], so the override
			// must be registered last for this test to model the real ordering.
			const agent = new Agent({
				model,
				systemPrompt: "Test agent.",
				tools: [builtinTool, overrideTool],
			});

			const result = await agent.run("Run the command.");

			const runCommandsOffers = requests[0]?.tools.filter((tool) => tool.name === "run_commands") ?? [];
			expect(runCommandsOffers).toHaveLength(1);

			const toolResult = result.messages
				.flatMap((message) => message.content)
				.find((part) => part.type === "tool-result");
			expect(toolResult).toMatchObject({ type: "tool-result", toolName: "run_commands" });
			const serializedOutput = JSON.stringify(toolResult);
			expect(serializedOutput).toContain("Command timed out after 250ms");

			// Negative control: with the builtin registered last, the builtin wins and
			// the same command completes, so the shadowing above is really order-based.
			const reversedScript = createScriptedModel({ command: "sleep 0.6" });
			const reversedAgent = new Agent({
				model: reversedScript.model,
				systemPrompt: "Test agent.",
				tools: [overrideTool, builtinTool],
			});
			const reversedResult = await reversedAgent.run("Run the command.");
			const reversedToolResult = reversedResult.messages
				.flatMap((message) => message.content)
				.find((part) => part.type === "tool-result");
			expect(JSON.stringify(reversedToolResult)).not.toContain("timed out");
		},
	);

	it.skipIf(isWindows)("applies the configured timeout to the tool definition and executor", async () => {
		const tool = createRunCommandsTool({ cwd: process.cwd(), timeoutMs: 250 });

		expect(tool.timeoutMs).toBe(500);

		const output = await tool.execute(
			{ commands: ["sleep 0.6"] },
			{
				agentId: "agent-1",
				iteration: 1,
			},
		);
		const serializedOutput = JSON.stringify(output);
		expect(serializedOutput).toContain("Command timed out after 250ms");
	});

	it.skipIf(isWindows)("runs commands that finish within the configured timeout", async () => {
		const tool = createRunCommandsTool({ cwd: process.cwd(), timeoutMs: 5_000 });

		const output = await tool.execute(
			{ commands: ["printf 'ok'"] },
			{
				agentId: "agent-1",
				iteration: 1,
			},
		);
		const results = output as Array<{ result?: unknown; success?: boolean }>;
		expect(results[0]?.success).toBe(true);
		expect(String(results[0]?.result)).toContain("ok");
	});
});
