/**
 * Environment and PATH policy for the Kanban CLI subprocess.
 *
 * Isolated from runtime-child.ts so the process-lifecycle code stays
 * focused on spawn/poll/kill concerns. Two policy decisions live here:
 *
 *   1. Which env vars are forwarded to the child. All parent env vars
 *      are forwarded by default (matching VS Code's model). Agent shells
 *      inherit the full environment.
 *   2. Which platform-specific directories are appended to PATH. GUI-
 *      launched processes on macOS/Linux/Windows inherit a minimal PATH
 *      that typically omits Homebrew, npm-global, nvm, Git for Windows,
 *      etc. Agent shells need those binaries findable by name.
 */

import { homedir } from "node:os";
import path, { join } from "node:path";

function getHomeDir(): string | null {
	const homeDir = process.env.HOME?.trim();
	if (homeDir) {
		return homeDir;
	}
	const fallback = homedir();
	return fallback ? fallback : null;
}

/**
 * Windows-specific PATH dirs that depend on per-user environment variables
 * (APPDATA / LOCALAPPDATA / ProgramFiles).
 */
function getWindowsExtraPathDirs(): string[] {
	const dirs: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	const appData = process.env.APPDATA;
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	if (appData) dirs.push(join(appData, "npm")); // npm global
	if (localAppData) {
		dirs.push(join(localAppData, "Programs", "nodejs"));
		// WinGet places shim executables in `…\WinGet\Links\` (not
		// `…\WinGet\Packages\`, which holds install directories that
		// aren't directly on PATH).
		dirs.push(join(localAppData, "Microsoft", "WinGet", "Links"));
	}
	if (programFiles) dirs.push(join(programFiles, "Git", "cmd"));
	if (programFilesX86) dirs.push(join(programFilesX86, "Git", "cmd"));
	return dirs;
}

/**
 * macOS dirs added for GUI-launched desktop builds. launchd hands GUI apps a
 * minimal PATH that omits Homebrew and the classic system bin dirs.
 */
const DARWIN_EXTRA_PATH_DIRS: readonly string[] = [
	"/opt/homebrew/bin",
	"/opt/homebrew/sbin",
	"/usr/local/bin",
	"/usr/local/sbin",
	"/usr/bin",
	"/bin",
	"/usr/sbin",
	"/sbin",
];

/**
 * Linux dirs added for GUI-launched desktop builds. Desktop-file launches get a
 * minimal PATH that omits per-user tool dirs, so globally-installed CLIs (pnpm
 * globals, cargo, bun, pipx) look uninstalled to agent detection and to spawned
 * agents. PNPM_HOME / NVM_BIN are honored because shell init normally exports
 * them and GUI launches do not run shell init.
 */
function getLinuxExtraPathDirs(): string[] {
	const dirs: string[] = [];
	const homeDir = getHomeDir();
	if (homeDir) {
		dirs.push(
			join(homeDir, ".local", "bin"),
			join(homeDir, ".local", "share", "pnpm"),
			join(homeDir, ".local", "share", "pnpm", "bin"),
			join(homeDir, ".cargo", "bin"),
			join(homeDir, ".bun", "bin"),
		);
	}
	const pnpmHome = process.env.PNPM_HOME?.trim();
	if (pnpmHome) {
		dirs.push(pnpmHome, join(pnpmHome, "bin"));
	}
	const nvmBin = process.env.NVM_BIN?.trim();
	if (nvmBin) {
		dirs.push(nvmBin);
	}
	dirs.push("/usr/local/bin", "/snap/bin", "/usr/bin", "/bin");
	return dirs;
}

/**
 * Directories appended to PATH for GUI-launched desktop processes. Computed per
 * call (not at import time) so tests and runtime env changes are reflected.
 */
function getExtraPathDirs(): readonly string[] {
	if (process.platform === "darwin") {
		return DARWIN_EXTRA_PATH_DIRS;
	}
	if (process.platform === "linux") {
		return getLinuxExtraPathDirs();
	}
	if (process.platform === "win32") {
		return getWindowsExtraPathDirs();
	}
	return [];
}

/**
 * Build an enriched copy of process.env with PATH augmented for GUI-launched
 * processes. All parent environment variables are forwarded by default.
 */
export function buildFilteredEnv(): NodeJS.ProcessEnv {
	// Forward all parent env vars (matching VS Code's model)
	const filtered: NodeJS.ProcessEnv = { ...process.env };

	// Enrich PATH with common tool locations that GUI launches omit
	const extraPathDirs = getExtraPathDirs();
	if (extraPathDirs.length > 0) {
		const pathParts = new Set((filtered.PATH ?? "").split(path.delimiter).filter(Boolean));
		for (const dir of extraPathDirs) pathParts.add(dir);
		filtered.PATH = [...pathParts].join(path.delimiter);
	}

	return filtered;
}
