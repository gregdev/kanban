import { delimiter } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
	applyAgentRuntimeEnv,
	normalizeAgentEnv,
	normalizeAgentPathPrepend,
} from "../../../src/config/agent-runtime-env";

const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	setPlatform(originalPlatform);
});

describe("normalizeAgentPathPrepend", () => {
	it("expands home tokens, drops relative entries, and dedupes", () => {
		expect(
			normalizeAgentPathPrepend(["~/bin", "/abs/tools", "relative/bin", "~/bin", "/abs/tools/", "", 123], {
				homeDir: "/home/tester",
			}),
		).toEqual(["/home/tester/bin", "/abs/tools"]);
	});

	it("expands unbraced and braced HOME tokens", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: config input, not a template
		const entries = ["$HOME/tools", "/opt/${HOME}/nested"];
		expect(normalizeAgentPathPrepend(entries, { homeDir: "/home/tester" })).toEqual([
			"/home/tester/tools",
			"/opt/home/tester/nested",
		]);
	});

	it("returns an empty list for malformed input", () => {
		expect(normalizeAgentPathPrepend(undefined, { homeDir: "/home/tester" })).toEqual([]);
		expect(normalizeAgentPathPrepend("~/bin", { homeDir: "/home/tester" })).toEqual([]);
	});
});

describe("normalizeAgentEnv", () => {
	it("keeps string values and expands home tokens", () => {
		expect(
			normalizeAgentEnv(
				{ PNPM_HOME: "~/.local/share/pnpm", TOOL_HOME: "$HOME/tooling", COUNT: 2, FLAG: true },
				{ homeDir: "/home/tester" },
			),
		).toEqual({
			PNPM_HOME: "/home/tester/.local/share/pnpm",
			TOOL_HOME: "/home/tester/tooling",
		});
	});

	it("returns an empty record for malformed input", () => {
		expect(normalizeAgentEnv(null)).toEqual({});
		expect(normalizeAgentEnv(["nope"])).toEqual({});
	});
});

describe("applyAgentRuntimeEnv", () => {
	it("returns the base env unchanged when nothing is configured", () => {
		const baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
		expect(applyAgentRuntimeEnv(baseEnv, { agentEnv: {}, agentPathPrepend: [] })).toBe(baseEnv);
	});

	it("prepends configured directories and dedupes inherited entries", () => {
		const env = applyAgentRuntimeEnv(
			{ PATH: ["/usr/bin", "/opt/tools"].join(delimiter) },
			{ agentEnv: {}, agentPathPrepend: ["/opt/tools", "/custom/bin"] },
		);
		expect(env.PATH).toBe(["/opt/tools", "/custom/bin", "/usr/bin"].join(delimiter));
	});

	it("applies agent env over the base env and prepends on top of its PATH", () => {
		const env = applyAgentRuntimeEnv(
			{ PATH: "/usr/bin", KANBAN_FLAG: "base" },
			{
				agentEnv: { PATH: "/agent/bin", KANBAN_FLAG: "configured" },
				agentPathPrepend: ["/custom/bin"],
			},
		);
		expect(env.KANBAN_FLAG).toBe("configured");
		// agentEnv is a plain env override; agentPathPrepend is the additive PATH knob.
		expect(env.PATH).toBe(["/custom/bin", "/agent/bin"].join(delimiter));
	});

	it("collapses a Windows-style Path key into PATH when prepending", () => {
		setPlatform("win32");
		const baseEnv: NodeJS.ProcessEnv = { Path: ["C:\\Windows", "C:\\Tools"].join(";") };
		const env = applyAgentRuntimeEnv(baseEnv, { agentEnv: {}, agentPathPrepend: ["C:\\Agent\\bin"] });
		expect(env.Path).toBeUndefined();
		// The host's path.delimiter is used, so the inherited entry stays intact as one value.
		expect(env.PATH).toBe(["C:\\Agent\\bin", "C:\\Windows;C:\\Tools"].join(delimiter));
	});
});
