import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createClineMcpSettingsService,
	resolveMcpSettingsPath,
} from "../../../src/cline-sdk/cline-mcp-settings-service";

const atlassianOauthState = {
	clientInformation: {
		redirect_uris: ["http://127.0.0.1:1456/mcp/oauth/callback"],
		client_id: "client-id-123",
	},
	tokens: {
		access_token: "access-token",
		refresh_token: "refresh-token",
	},
	codeVerifier: "code-verifier",
	discoveryState: {
		authorizationServerUrl: "https://auth.atlassian.com",
	},
	redirectUrl: "http://127.0.0.1:1456/mcp/oauth/callback",
	lastAuthenticatedAt: 1795308501949,
};

describe("cline-mcp-settings-service", () => {
	let tempDir: string;
	let settingsPath: string;
	const originalSettingsPath = process.env.CLINE_MCP_SETTINGS_PATH;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kanban-cline-mcp-settings-"));
		settingsPath = join(tempDir, "cline_mcp_settings.json");
		process.env.CLINE_MCP_SETTINGS_PATH = settingsPath;
	});

	afterEach(() => {
		if (originalSettingsPath === undefined) {
			delete process.env.CLINE_MCP_SETTINGS_PATH;
		} else {
			process.env.CLINE_MCP_SETTINGS_PATH = originalSettingsPath;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeSettings(settings: unknown): void {
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf8");
	}

	function readSettings(): unknown {
		return JSON.parse(readFileSync(settingsPath, "utf8"));
	}

	it("reads nested streamableHttp servers persisted by the Cline app", () => {
		writeSettings({
			mcpServers: {
				atlassian: {
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v2/mcp",
					},
					oauth: atlassianOauthState,
				},
			},
		});

		const response = createClineMcpSettingsService().loadSettings();

		expect(response.path).toBe(resolveMcpSettingsPath());
		expect(response.servers).toEqual([
			{
				name: "atlassian",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.atlassian.com/v2/mcp",
			},
		]);
	});

	it("reads nested stdio servers", () => {
		writeSettings({
			mcpServers: {
				local: {
					disabled: true,
					transport: {
						type: "stdio",
						command: "node",
						args: ["server.js"],
						cwd: "/tmp/project",
						env: { API_KEY: "secret" },
					},
				},
			},
		});

		const response = createClineMcpSettingsService().loadSettings();

		expect(response.servers).toEqual([
			{
				name: "local",
				disabled: true,
				type: "stdio",
				command: "node",
				args: ["server.js"],
				cwd: "/tmp/project",
				env: { API_KEY: "secret" },
			},
		]);
	});

	it("reads flat stdio servers", () => {
		writeSettings({
			mcpServers: {
				local: {
					command: "npx",
					args: ["-y", "some-mcp-server"],
					cwd: "/tmp/project",
					env: { API_KEY: "secret" },
				},
			},
		});

		const response = createClineMcpSettingsService().loadSettings();

		expect(response.servers).toEqual([
			{
				name: "local",
				disabled: false,
				type: "stdio",
				command: "npx",
				args: ["-y", "some-mcp-server"],
				cwd: "/tmp/project",
				env: { API_KEY: "secret" },
			},
		]);
	});

	it("reads flat url servers including the legacy transportType field", () => {
		writeSettings({
			mcpServers: {
				figma: {
					transportType: "http",
					url: "https://mcp.figma.com/mcp",
					headers: { Authorization: "Bearer token" },
				},
			},
		});

		const response = createClineMcpSettingsService().loadSettings();

		expect(response.servers).toEqual([
			{
				name: "figma",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.figma.com/mcp",
				headers: { Authorization: "Bearer token" },
			},
		]);
	});

	it("reads a file that mixes nested and flat server shapes", () => {
		writeSettings({
			mcpServers: {
				atlassian: {
					transport: { type: "streamableHttp", url: "https://mcp.atlassian.com/v2/mcp" },
					oauth: atlassianOauthState,
				},
				zetaLocal: { command: "node", args: ["zeta.js"] },
				alphaRemote: { type: "sse", url: "https://example.com/sse" },
			},
		});

		const response = createClineMcpSettingsService().loadSettings();

		expect(response.servers).toEqual([
			{ name: "alphaRemote", disabled: false, type: "sse", url: "https://example.com/sse" },
			{
				name: "atlassian",
				disabled: false,
				type: "streamableHttp",
				url: "https://mcp.atlassian.com/v2/mcp",
			},
			{ name: "zetaLocal", disabled: false, type: "stdio", command: "node", args: ["zeta.js"] },
		]);
	});

	it("preserves oauth state, unknown keys, and existing shapes across load -> save", async () => {
		const settings = {
			version: 2,
			mcpServers: {
				atlassian: {
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v2/mcp",
						futureTransportField: "keep",
					},
					oauth: atlassianOauthState,
					futureClineField: { enabled: true },
				},
				local: {
					command: "node",
					args: ["server.js"],
					transportType: "stdio",
					futureClineField: "keep",
				},
			},
		};
		writeSettings(settings);
		const service = createClineMcpSettingsService();

		const loaded = service.loadSettings();
		await service.saveSettings({ servers: loaded.servers });

		expect(readSettings()).toEqual(settings);
	});

	it("keeps the nested transport when only the disabled flag changes", async () => {
		writeSettings({
			mcpServers: {
				atlassian: {
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v2/mcp",
						futureTransportField: "keep",
					},
					oauth: atlassianOauthState,
				},
			},
		});
		const service = createClineMcpSettingsService();
		const loaded = service.loadSettings();

		await service.saveSettings({
			servers: loaded.servers.map((server) => ({ ...server, disabled: true })),
		});

		expect(readSettings()).toEqual({
			mcpServers: {
				atlassian: {
					disabled: true,
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v2/mcp",
						futureTransportField: "keep",
					},
					oauth: atlassianOauthState,
				},
			},
		});
	});

	it("rewrites a changed nested transport without dropping oauth or unmanaged keys", async () => {
		writeSettings({
			mcpServers: {
				atlassian: {
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v2/mcp",
						futureTransportField: "keep",
					},
					oauth: atlassianOauthState,
					futureClineField: "keep",
				},
			},
		});
		const service = createClineMcpSettingsService();
		const loaded = service.loadSettings();

		await service.saveSettings({
			servers: loaded.servers.map((server) =>
				server.type === "stdio"
					? server
					: {
							...server,
							url: "https://mcp.atlassian.com/v3/mcp",
							headers: { "X-Test": "1" },
						},
			),
		});

		expect(readSettings()).toEqual({
			mcpServers: {
				atlassian: {
					transport: {
						type: "streamableHttp",
						url: "https://mcp.atlassian.com/v3/mcp",
						headers: { "X-Test": "1" },
						futureTransportField: "keep",
					},
					oauth: atlassianOauthState,
					futureClineField: "keep",
				},
			},
		});
	});

	it("writes new servers in the flat shape and preserves unrelated top-level keys", async () => {
		writeSettings({
			version: 2,
			unrelatedSetting: { keepMe: true },
			mcpServers: {},
		});
		const service = createClineMcpSettingsService();

		await service.saveSettings({
			servers: [{ name: "newRemote", disabled: false, type: "sse", url: "https://example.com/sse" }],
		});

		expect(readSettings()).toEqual({
			version: 2,
			unrelatedSetting: { keepMe: true },
			mcpServers: {
				newRemote: { type: "sse", url: "https://example.com/sse" },
			},
		});
	});

	it("reports a clear error for a server entry with no transport information", () => {
		writeSettings({
			mcpServers: {
				broken: { type: "streamableHttp" },
			},
		});

		expect(() => createClineMcpSettingsService().loadSettings()).toThrowError(
			`Invalid MCP settings at "${resolveMcpSettingsPath()}": mcpServers.broken: must define \`command\`, \`url\`, or a nested \`transport\` object`,
		);
	});

	it("reports a clear error for an invalid nested transport", () => {
		writeSettings({
			mcpServers: {
				broken: { transport: { type: "streamableHttp" } },
			},
		});

		expect(() => createClineMcpSettingsService().loadSettings()).toThrowError(
			/^Invalid MCP settings at ".*": mcpServers\.broken\.transport/,
		);
	});
});
