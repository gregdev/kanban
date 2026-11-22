// Explicit, opt-in agent environment configuration.
//
// Task agents inherit the Kanban runtime process environment. Binaries that are
// only reachable after interactive shell init (`~/.zshrc`, `~/.bashrc`) are
// therefore invisible to agent detection and to spawned agents, even though a
// Kanban shell terminal (a real interactive shell) can run them.
//
// Kanban deliberately does not boot an interactive shell on hot paths to
// discover those PATH additions (see the comment block in
// `src/terminal/command-discovery.ts`). Instead users opt in explicitly in the
// global runtime config (`~/.cline/kanban/config.json`):
//
//   {
//     "agentPathPrepend": ["~/.local/share/pnpm/bin"],
//     "agentEnv": { "PNPM_HOME": "~/.local/share/pnpm" }
//   }
//
// The same resolved values feed agent detection and task-agent spawn env, so
// detection and execution cannot disagree about what is installed.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { getRuntimeGlobalConfigPath } from "./runtime-paths";

export interface AgentRuntimeEnvConfig {
	/** Extra environment variables applied to agent lookups and agent spawns. */
	agentEnv: Record<string, string>;
	/** Absolute directories prepended to PATH for agent lookups and agent spawns. */
	agentPathPrepend: string[];
}

const HOME_TOKEN_PATTERN = /\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g;

function createEmptyAgentRuntimeEnvConfig(): AgentRuntimeEnvConfig {
	return { agentEnv: {}, agentPathPrepend: [] };
}

/**
 * Expand a leading `~` and any `$HOME` / `${HOME}` tokens. Only the leading
 * tilde is expanded; `~otheruser` style values are left untouched.
 */
function expandHomeTokens(value: string, homeDir: string): string {
	let expanded = value;
	if (expanded === "~") {
		expanded = homeDir;
	} else if (expanded.startsWith("~/") || expanded.startsWith("~\\")) {
		expanded = join(homeDir, expanded.slice(2));
	}
	return expanded.replace(HOME_TOKEN_PATTERN, homeDir);
}

function normalizePathKey(pathValue: string): string {
	const withoutTrailingSeparators = pathValue.length > 1 ? pathValue.replace(/[\\/]+$/, "") : pathValue;
	const normalized = withoutTrailingSeparators.replaceAll("\\", "/");
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Normalize configured PATH additions: expand home tokens, drop entries that
 * are not absolute (relative dirs would resolve against an unpredictable cwd),
 * and dedupe while preserving the user's order.
 */
export function normalizeAgentPathPrepend(value: unknown, options: { homeDir?: string } = {}): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const homeDir = options.homeDir ?? homedir();
	const entries: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		if (typeof candidate !== "string") {
			continue;
		}
		const trimmed = candidate.trim();
		if (!trimmed) {
			continue;
		}
		const expanded = expandHomeTokens(trimmed, homeDir);
		if (!isAbsolute(expanded)) {
			continue;
		}
		// resolve() only normalizes here (dot segments, duplicate separators); relative
		// entries were already rejected so it never resolves against the process cwd.
		const normalizedEntry = resolve(expanded);
		const key = normalizePathKey(normalizedEntry);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		entries.push(normalizedEntry);
	}
	return entries;
}

/**
 * Normalize configured env overrides. Only string values are accepted so a
 * malformed config entry cannot smuggle unrelated process env state into the
 * persisted config.
 */
export function normalizeAgentEnv(value: unknown, options: { homeDir?: string } = {}): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	const homeDir = options.homeDir ?? homedir();
	const entries: Record<string, string> = {};
	for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
		const key = rawKey.trim();
		if (!key || typeof rawValue !== "string") {
			continue;
		}
		entries[key] = expandHomeTokens(rawValue, homeDir);
	}
	return entries;
}

export function areAgentEnvValuesEqual(left: Record<string, string>, right: Record<string, string>): boolean {
	const leftKeys = Object.keys(left);
	if (leftKeys.length !== Object.keys(right).length) {
		return false;
	}
	for (const key of leftKeys) {
		if (left[key] !== right[key]) {
			return false;
		}
	}
	return true;
}

export function areAgentPathPrependValuesEqual(left: readonly string[], right: readonly string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((entry, index) => entry === right[index]);
}

// Windows exposes PATH with whatever casing it was created with (commonly `Path`),
// so copying `process.env` into a plain object can leave `PATH` unset. Collapse any
// casing variant into a single canonical `PATH` key for the spawned env block.
function ensureCanonicalPathKey(env: NodeJS.ProcessEnv): void {
	for (const key of Object.keys(env)) {
		if (key === "PATH" || key.toUpperCase() !== "PATH") {
			continue;
		}
		if (env.PATH === undefined && typeof env[key] === "string") {
			env.PATH = env[key];
		}
		delete env[key];
	}
}

/**
 * Apply configured agent env over `baseEnv`.
 *
 * `baseEnv` is expected to already include session-specific overrides.
 * Configured `agentEnv` values win over the inherited process env and are plain
 * overrides (an `agentEnv.PATH` replaces the inherited PATH). Configured
 * `agentPathPrepend` directories are the additive knob: they are prepended to
 * whatever PATH results from the merge.
 */
export function applyAgentRuntimeEnv(baseEnv: NodeJS.ProcessEnv, config: AgentRuntimeEnvConfig): NodeJS.ProcessEnv {
	const configuredEnvKeys = Object.keys(config.agentEnv);
	if (config.agentPathPrepend.length === 0 && configuredEnvKeys.length === 0) {
		return baseEnv;
	}

	const env: NodeJS.ProcessEnv = { ...baseEnv, ...config.agentEnv };
	if (config.agentPathPrepend.length === 0) {
		return env;
	}
	ensureCanonicalPathKey(env);

	const existingEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
	const seen = new Set<string>();
	const mergedEntries: string[] = [];
	for (const entry of [...config.agentPathPrepend, ...existingEntries]) {
		const key = normalizePathKey(entry);
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		mergedEntries.push(entry);
	}
	env.PATH = mergedEntries.join(delimiter);
	return env;
}

interface CachedAgentRuntimeEnvConfig {
	configPath: string;
	mtimeMs: number;
	size: number;
	config: AgentRuntimeEnvConfig;
}

let cachedConfig: CachedAgentRuntimeEnvConfig | null = null;

/**
 * Synchronously read the agent environment section of the global runtime
 * config. Detection runs on hot paths and is synchronous, so this stays cheap:
 * the file is only re-parsed when its mtime/size changed since the last read.
 */
export function readAgentRuntimeEnvConfig(configPath: string = getRuntimeGlobalConfigPath()): AgentRuntimeEnvConfig {
	let stats: ReturnType<typeof statSync>;
	try {
		stats = statSync(configPath);
	} catch {
		return createEmptyAgentRuntimeEnvConfig();
	}
	if (
		cachedConfig &&
		cachedConfig.configPath === configPath &&
		cachedConfig.mtimeMs === stats.mtimeMs &&
		cachedConfig.size === stats.size
	) {
		return cachedConfig.config;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		return createEmptyAgentRuntimeEnvConfig();
	}
	const fileShape = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	const config: AgentRuntimeEnvConfig = {
		agentEnv: normalizeAgentEnv(fileShape.agentEnv),
		agentPathPrepend: normalizeAgentPathPrepend(fileShape.agentPathPrepend),
	};
	cachedConfig = { configPath, mtimeMs: stats.mtimeMs, size: stats.size, config };
	return config;
}

/** Drop the cached config so the next read reflects a just-written file. */
export function clearAgentRuntimeEnvConfigCache(): void {
	cachedConfig = null;
}
