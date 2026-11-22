import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { RuntimeClineMcpServer, RuntimeClineMcpSettingsResponse } from "../core/api-contract";
import { lockedFileSystem } from "../fs/locked-file-system";

const stringRecordSchema = z.record(z.string(), z.string());

const remoteTransportTypeSchema = z.enum(["sse", "streamableHttp"]);

// Cline persists MCP servers in two shapes:
//   - flat: `{ command }` for stdio, or `{ url }` for remote transports
//   - nested: `{ transport: { type, command | url, ... }, oauth: {...} }`
// Kanban normalizes both into RuntimeClineMcpServer on read and merges writes
// back into the raw entry so keys it does not manage (like `oauth`) survive.
const nestedStdioTransportSchema = z.object({
	type: z.literal("stdio"),
	command: z.string().min(1),
	args: z.array(z.string()).optional(),
	cwd: z.string().min(1).optional(),
	env: stringRecordSchema.optional(),
});

const nestedRemoteTransportSchema = z.object({
	type: remoteTransportTypeSchema,
	url: z.string().url(),
	headers: stringRecordSchema.optional(),
});

const nestedTransportSchema = z.discriminatedUnion("type", [nestedStdioTransportSchema, nestedRemoteTransportSchema]);

// `type` / `transportType` are optional on disk (Cline infers from fields),
// but we always resolve them on read. Unknown keys are allowed here because
// they are read from the raw JSON when saving, not from this normalized output.
const persistedServerEntrySchema = z
	.object({
		type: z.enum(["stdio", "sse", "streamableHttp"]).optional(),
		transportType: z.enum(["stdio", "sse", "http", "streamableHttp"]).optional(),
		disabled: z.boolean().optional(),
		command: z.string().min(1).optional(),
		args: z.array(z.string()).optional(),
		cwd: z.string().min(1).optional(),
		env: stringRecordSchema.optional(),
		url: z.string().url().optional(),
		headers: stringRecordSchema.optional(),
		transport: nestedTransportSchema.optional(),
	})
	.superRefine((entry, ctx) => {
		if (entry.transport || entry.command || entry.url) {
			return;
		}
		ctx.addIssue({
			code: "custom",
			message: "must define `command`, `url`, or a nested `transport` object",
		});
	});

const persistedSettingsSchema = z.object({
	mcpServers: z.record(z.string(), persistedServerEntrySchema),
});

type PersistedServerEntry = z.infer<typeof persistedServerEntrySchema>;
type PersistedServerRecord = Record<string, unknown>;

function resolveUrlServerType(entry: Pick<PersistedServerEntry, "type" | "transportType">): "sse" | "streamableHttp" {
	if (entry.type === "streamableHttp" || entry.type === "sse") {
		return entry.type;
	}
	if (entry.transportType === "http" || entry.transportType === "streamableHttp") {
		return "streamableHttp";
	}
	if (entry.transportType === "sse") {
		return "sse";
	}
	// Default for url-based servers without explicit type (Cline's default for legacy configs)
	return "sse";
}

function normalizePersistedServer(name: string, entry: PersistedServerEntry): RuntimeClineMcpServer {
	if (entry.transport) {
		if (entry.transport.type === "stdio") {
			return {
				name,
				disabled: entry.disabled === true,
				type: "stdio",
				command: entry.transport.command,
				args: entry.transport.args,
				cwd: entry.transport.cwd,
				env: entry.transport.env,
			};
		}
		return {
			name,
			disabled: entry.disabled === true,
			type: entry.transport.type,
			url: entry.transport.url,
			headers: entry.transport.headers,
		};
	}

	if (entry.command) {
		return {
			name,
			disabled: entry.disabled === true,
			type: "stdio",
			command: entry.command,
			args: entry.args,
			cwd: entry.cwd,
			env: entry.env,
		};
	}

	if (!entry.url) {
		// Unreachable: persistedSettingsSchema rejects entries without a transport.
		throw new Error(`MCP server "${name}" must define \`command\`, \`url\`, or a nested \`transport\` object.`);
	}

	return {
		name,
		disabled: entry.disabled === true,
		type: resolveUrlServerType(entry),
		url: entry.url,
		headers: entry.headers,
	};
}

function normalizeRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!record) {
		return undefined;
	}
	const entries = Object.entries(record)
		.filter(([key, value]) => key.trim().length > 0 && value.trim().length > 0)
		.map(([key, value]) => [key.trim(), value.trim()] as const);
	if (entries.length === 0) {
		return undefined;
	}
	return Object.fromEntries(entries);
}

function normalizeServer(server: RuntimeClineMcpServer): RuntimeClineMcpServer {
	const name = server.name.trim();
	if (server.type === "stdio") {
		const args = server.args?.map((value) => value.trim()).filter((value) => value.length > 0);
		return {
			name,
			disabled: server.disabled,
			type: "stdio",
			command: server.command.trim(),
			args: args && args.length > 0 ? args : undefined,
			cwd: server.cwd?.trim() || undefined,
			env: normalizeRecord(server.env),
		};
	}

	return {
		name,
		disabled: server.disabled,
		type: server.type,
		url: server.url.trim(),
		headers: normalizeRecord(server.headers),
	};
}

function normalizeServers(servers: RuntimeClineMcpServer[]): RuntimeClineMcpServer[] {
	return servers.map(normalizeServer).sort((left, right) => left.name.localeCompare(right.name));
}

export function resolveMcpSettingsPath(): string {
	const configuredPath = process.env.CLINE_MCP_SETTINGS_PATH?.trim();
	if (configuredPath) {
		return resolve(configuredPath);
	}
	return join(homedir(), ".cline", "data", "settings", "cline_mcp_settings.json");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const issuePath = issue.path.join(".");
			return issuePath ? `${issuePath}: ${issue.message}` : issue.message;
		})
		.join("; ");
}

interface ParsedSettingsFile {
	servers: RuntimeClineMcpServer[];
	rawServers: Record<string, PersistedServerRecord>;
	topLevel: Record<string, unknown>;
}

function parseSettingsFile(filePath: string): ParsedSettingsFile {
	if (!existsSync(filePath)) {
		return {
			servers: [],
			rawServers: {},
			topLevel: {},
		};
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(readFileSync(filePath, "utf8"));
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse MCP settings JSON at "${filePath}": ${details}`);
	}

	const parsed = persistedSettingsSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(`Invalid MCP settings at "${filePath}": ${formatIssues(parsed.error)}`);
	}

	const rawServers: Record<string, PersistedServerRecord> = {};
	if (isPlainRecord(parsedJson) && isPlainRecord(parsedJson.mcpServers)) {
		for (const [name, entry] of Object.entries(parsedJson.mcpServers)) {
			if (isPlainRecord(entry)) {
				rawServers[name] = entry;
			}
		}
	}

	const servers = normalizeServers(
		Object.entries(parsed.data.mcpServers).map(([name, entry]) => normalizePersistedServer(name, entry)),
	);

	return {
		servers,
		rawServers,
		topLevel: isPlainRecord(parsedJson) ? parsedJson : {},
	};
}

const FLAT_MANAGED_SERVER_KEYS = ["command", "args", "cwd", "env", "url", "headers", "type", "transportType"] as const;
const NESTED_MANAGED_TRANSPORT_KEYS = ["command", "args", "cwd", "env", "url", "headers", "type"] as const;

function withoutKeys(record: PersistedServerRecord, keys: readonly string[]): PersistedServerRecord {
	const next: PersistedServerRecord = { ...record };
	for (const key of keys) {
		delete next[key];
	}
	return next;
}

function applyDisabledFlag(entry: PersistedServerRecord, disabled: boolean): void {
	if (disabled) {
		entry.disabled = true;
	} else {
		delete entry.disabled;
	}
}

function buildTransportFields(server: RuntimeClineMcpServer): PersistedServerRecord {
	if (server.type === "stdio") {
		return {
			type: "stdio",
			command: server.command,
			...(server.args ? { args: server.args } : {}),
			...(server.cwd ? { cwd: server.cwd } : {}),
			...(server.env ? { env: server.env } : {}),
		};
	}
	return {
		type: server.type,
		url: server.url,
		...(server.headers ? { headers: server.headers } : {}),
	};
}

function buildFlatServerEntry(server: RuntimeClineMcpServer): PersistedServerRecord {
	return {
		...buildTransportFields(server),
		...(server.disabled ? { disabled: true } : {}),
	};
}

function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areStringRecordsEqual(
	left: Record<string, string> | undefined,
	right: Record<string, string> | undefined,
): boolean {
	if (!left || !right) {
		return left === right;
	}
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) {
		return false;
	}
	return leftKeys.every((key) => Object.hasOwn(right, key) && right[key] === left[key]);
}

function hasSameTransport(left: RuntimeClineMcpServer, right: RuntimeClineMcpServer): boolean {
	if (left.type === "stdio") {
		return (
			right.type === "stdio" &&
			left.command === right.command &&
			left.cwd === right.cwd &&
			areStringArraysEqual(left.args, right.args) &&
			areStringRecordsEqual(left.env, right.env)
		);
	}
	if (right.type === "stdio") {
		return false;
	}
	return left.type === right.type && left.url === right.url && areStringRecordsEqual(left.headers, right.headers);
}

function mergeServerEntry(input: {
	server: RuntimeClineMcpServer;
	existingEntry: PersistedServerRecord | undefined;
	existingServer: RuntimeClineMcpServer | undefined;
}): PersistedServerRecord {
	const { server, existingEntry, existingServer } = input;
	if (!existingEntry) {
		return buildFlatServerEntry(server);
	}

	if (existingServer && hasSameTransport(existingServer, server)) {
		// Keep the on-disk shape (flat vs nested) and every key Kanban does not manage.
		const unchangedEntry: PersistedServerRecord = { ...existingEntry };
		if (existingServer.disabled !== server.disabled) {
			applyDisabledFlag(unchangedEntry, server.disabled);
		}
		return unchangedEntry;
	}

	if (isPlainRecord(existingEntry.transport)) {
		// Keep Cline's nested shape, merge only the transport fields Kanban manages,
		// and preserve sibling keys such as `oauth`.
		const nextEntry = withoutKeys(existingEntry, FLAT_MANAGED_SERVER_KEYS);
		nextEntry.transport = {
			...withoutKeys(existingEntry.transport, NESTED_MANAGED_TRANSPORT_KEYS),
			...buildTransportFields(server),
		};
		applyDisabledFlag(nextEntry, server.disabled);
		return nextEntry;
	}

	const nextEntry = {
		...withoutKeys(existingEntry, FLAT_MANAGED_SERVER_KEYS),
		...buildTransportFields(server),
	};
	applyDisabledFlag(nextEntry, server.disabled);
	return nextEntry;
}

export interface ClineMcpSettingsService {
	loadSettings(): RuntimeClineMcpSettingsResponse;
	saveSettings(input: { servers: RuntimeClineMcpServer[] }): Promise<RuntimeClineMcpSettingsResponse>;
}

export function createClineMcpSettingsService(): ClineMcpSettingsService {
	return {
		loadSettings(): RuntimeClineMcpSettingsResponse {
			const path = resolveMcpSettingsPath();
			return {
				path,
				servers: parseSettingsFile(path).servers,
			};
		},

		async saveSettings(input: { servers: RuntimeClineMcpServer[] }): Promise<RuntimeClineMcpSettingsResponse> {
			const path = resolveMcpSettingsPath();
			const servers = normalizeServers(input.servers);
			const existing = parseSettingsFile(path);
			const existingServersByName = new Map(existing.servers.map((server) => [server.name, server]));
			const existingEntriesByName = new Map(
				Object.entries(existing.rawServers).map(([name, entry]) => [name.trim(), entry] as const),
			);

			const mcpServers: Record<string, PersistedServerRecord> = {};
			for (const server of servers) {
				mcpServers[server.name] = mergeServerEntry({
					server,
					existingEntry: existingEntriesByName.get(server.name),
					existingServer: existingServersByName.get(server.name),
				});
			}

			await lockedFileSystem.writeJsonFileAtomic(
				path,
				{
					...existing.topLevel,
					mcpServers,
				},
				{
					lock: {
						path,
						type: "file",
					},
				},
			);

			return {
				path,
				servers,
			};
		},
	};
}
