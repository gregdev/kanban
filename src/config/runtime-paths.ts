// Resolves Kanban-owned config paths on disk.
//
// This module is intentionally dependency-free (no config parsing, no terminal
// imports) so low-level consumers such as agent PATH discovery can resolve the
// global config path without creating an import cycle through runtime-config.ts.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RUNTIME_HOME_PARENT_DIR = ".cline";
const RUNTIME_HOME_DIR = "kanban";
const CONFIG_FILENAME = "config.json";
const PROJECT_CONFIG_PARENT_DIR = ".cline";
const PROJECT_CONFIG_DIR = "kanban";
const PROJECT_CONFIG_FILENAME = "config.json";

export function getRuntimeHomePath(): string {
	return join(homedir(), RUNTIME_HOME_PARENT_DIR, RUNTIME_HOME_DIR);
}

export function getRuntimeGlobalConfigPath(): string {
	return join(getRuntimeHomePath(), CONFIG_FILENAME);
}

export function getRuntimeProjectConfigPath(cwd: string): string {
	return join(resolve(cwd), PROJECT_CONFIG_PARENT_DIR, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILENAME);
}
