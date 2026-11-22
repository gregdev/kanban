import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearAgentRuntimeEnvConfigCache } from "../../../src/config/agent-runtime-env";
import { getRuntimeGlobalConfigPath } from "../../../src/config/runtime-paths";
import { isBinaryAvailableOnPath } from "../../../src/terminal/command-discovery";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalPath = process.env.PATH;

let tempHome: string | null = null;

function setupTempHome(): string {
	tempHome = mkdtempSync(join(tmpdir(), "kanban-command-discovery-"));
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	return tempHome;
}

function writeExecutable(binDir: string, command: string): void {
	mkdirSync(binDir, { recursive: true });
	if (process.platform === "win32") {
		writeFileSync(join(binDir, `${command}.cmd`), "@echo off\r\nexit /b 0\r\n", "utf8");
		return;
	}
	const scriptPath = join(binDir, command);
	writeFileSync(scriptPath, "#!/bin/sh\nexit 0\n", "utf8");
	chmodSync(scriptPath, 0o755);
}

function writeGlobalConfig(config: Record<string, unknown>): void {
	const configPath = getRuntimeGlobalConfigPath();
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
	clearAgentRuntimeEnvConfigCache();
}

beforeEach(() => {
	clearAgentRuntimeEnvConfigCache();
});

afterEach(() => {
	clearAgentRuntimeEnvConfigCache();
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true });
		tempHome = null;
	}
	if (originalHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = originalHome;
	}
	if (originalUserProfile === undefined) {
		delete process.env.USERPROFILE;
	} else {
		process.env.USERPROFILE = originalUserProfile;
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
});

describe("isBinaryAvailableOnPath with configured agent PATH additions", () => {
	it("detects a binary that only exists in a configured extra directory", () => {
		if (process.platform === "win32") {
			return;
		}
		const homeDir = setupTempHome();
		const inheritedBin = join(homeDir, "inherited-bin");
		const configuredBin = join(homeDir, "configured-bin");
		writeExecutable(inheritedBin, "kanban-inherited-tool");
		writeExecutable(configuredBin, "kanban-configured-tool");
		process.env.PATH = inheritedBin;

		expect(isBinaryAvailableOnPath("kanban-inherited-tool")).toBe(true);
		expect(isBinaryAvailableOnPath("kanban-configured-tool")).toBe(false);

		writeGlobalConfig({ agentPathPrepend: [configuredBin] });

		expect(isBinaryAvailableOnPath("kanban-configured-tool")).toBe(true);
	});

	it("expands home tokens and ignores relative configured directories", () => {
		if (process.platform === "win32") {
			return;
		}
		const homeDir = setupTempHome();
		const inheritedBin = join(homeDir, "inherited-bin");
		writeExecutable(inheritedBin, "kanban-inherited-tool");
		writeExecutable(join(homeDir, "home-bin"), "kanban-home-tool");
		process.env.PATH = inheritedBin;

		writeGlobalConfig({ agentPathPrepend: ["~/home-bin", "relative/bin"] });

		expect(isBinaryAvailableOnPath("kanban-home-tool")).toBe(true);
		// The relative entry is dropped during normalization, so it cannot resolve from cwd.
		expect(isBinaryAvailableOnPath("./relative/bin/kanban-home-tool")).toBe(false);
	});

	it("keeps inherited PATH entries working and dedupes configured duplicates", () => {
		if (process.platform === "win32") {
			return;
		}
		const homeDir = setupTempHome();
		const inheritedBin = join(homeDir, "inherited-bin");
		writeExecutable(inheritedBin, "kanban-inherited-tool");
		process.env.PATH = [inheritedBin, "/usr/bin", "/bin"].join(delimiter);

		writeGlobalConfig({ agentPathPrepend: [inheritedBin, inheritedBin] });

		expect(isBinaryAvailableOnPath("kanban-inherited-tool")).toBe(true);
	});
});
