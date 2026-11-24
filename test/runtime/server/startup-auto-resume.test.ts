import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const commandDiscoveryMocks = vi.hoisted(() => ({
	isBinaryAvailableOnPath: vi.fn(),
}));

vi.mock("../../../src/terminal/command-discovery.js", () => ({
	isBinaryAvailableOnPath: commandDiscoveryMocks.isBinaryAvailableOnPath,
}));

import type { ClineTaskSessionService } from "../../../src/cline-sdk/cline-task-session-service";
import type { RuntimeConfigState } from "../../../src/config/runtime-config";
import type {
	RuntimeBoardData,
	RuntimeTaskSessionStartRequest,
	RuntimeTaskSessionSummary,
} from "../../../src/core/api-contract";
import {
	MAX_AUTO_RESUME_TASKS_PER_STARTUP,
	runStartupAutoResume,
	type StartupAutoResumeSession,
} from "../../../src/server/startup-auto-resume";
import { loadWorkspaceContext, loadWorkspaceState, saveWorkspaceState } from "../../../src/state/workspace-state";
import { createGitTestEnv } from "../../utilities/git-env";
import { createTempDir } from "../../utilities/temp-dir";

function initGitRepository(path: string): void {
	const init = spawnSync("git", ["init"], {
		cwd: path,
		stdio: "ignore",
		env: createGitTestEnv(),
	});
	if (init.status !== 0) {
		throw new Error(`Failed to initialize git repository at ${path}`);
	}
}

function createCard(taskId: string) {
	return {
		id: taskId,
		title: `Task ${taskId}`,
		prompt: `Task ${taskId}`,
		startInPlanMode: false,
		baseRef: "main",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
}

function createBoard(taskIds: string[]): RuntimeBoardData {
	return {
		columns: [
			{ id: "backlog", title: "Backlog", cards: [] },
			{ id: "in_progress", title: "In Progress", cards: [] },
			{ id: "review", title: "Review", cards: [] },
			{ id: "trash", title: "Done", cards: taskIds.map(createCard) },
		],
		dependencies: [],
	};
}

function createInterruptedSummary(taskId: string, agentId: "claude" | "cline"): RuntimeTaskSessionSummary {
	return {
		taskId,
		state: "interrupted",
		agentId,
		workspacePath: `/tmp/${taskId}`,
		pid: null,
		startedAt: 1,
		updatedAt: 1,
		lastOutputAt: 1,
		reviewReason: "interrupted",
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
	};
}

function createRuntimeConfig(overrides: Partial<RuntimeConfigState> = {}): RuntimeConfigState {
	return {
		globalConfigPath: "/tmp/global-config.json",
		projectConfigPath: "/tmp/project-config.json",
		selectedAgentId: "claude",
		selectedShortcutLabel: null,
		agentAutonomousModeEnabled: true,
		agentCommandTimeoutSec: 300,
		readyForReviewNotificationsEnabled: true,
		shortcuts: [],
		commitPromptTemplate: "commit",
		openPrPromptTemplate: "pr",
		commitPromptTemplateDefault: "commit",
		openPrPromptTemplateDefault: "pr",
		agentEnv: {},
		agentPathPrepend: [],
		autoResumeInterruptedTasks: true,
		dependencyHandoffContextEnabled: true,
		...overrides,
	};
}

function createClineService(resumable: boolean): ClineTaskSessionService {
	return {
		reconcileInterruptedTaskSession: vi.fn(async (summary: RuntimeTaskSessionSummary) => ({
			summary,
			resumable,
		})),
	} as unknown as ClineTaskSessionService;
}

async function withWorkspaceState(
	taskIds: string[],
	run: (input: {
		workspaceId: string;
		workspacePath: string;
		candidates: StartupAutoResumeSession[];
	}) => Promise<void>,
): Promise<void> {
	const { path: tempHome, cleanup: cleanupHome } = createTempDir("kanban-home-auto-resume-");
	const { path: sandboxRoot, cleanup: cleanupSandbox } = createTempDir("kanban-auto-resume-");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	try {
		const workspacePath = join(sandboxRoot, "project");
		mkdirSync(workspacePath, { recursive: true });
		initGitRepository(workspacePath);
		const initial = await loadWorkspaceState(workspacePath);
		await saveWorkspaceState(workspacePath, {
			board: createBoard(taskIds),
			sessions: {},
			expectedRevision: initial.revision,
		});
		const workspaceId = (await loadWorkspaceContext(workspacePath)).workspaceId;
		await run({
			workspaceId,
			workspacePath,
			candidates: taskIds.map((taskId) => ({
				workspaceId,
				workspacePath,
				summary: createInterruptedSummary(taskId, "claude"),
			})),
		});
	} finally {
		if (previousHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = previousHome;
		}
		if (previousUserProfile === undefined) {
			delete process.env.USERPROFILE;
		} else {
			process.env.USERPROFILE = previousUserProfile;
		}
		cleanupSandbox();
		cleanupHome();
	}
}

describe("runStartupAutoResume", () => {
	beforeEach(() => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockReset();
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(true);
	});

	it("does nothing when the opt-in flag is disabled", async () => {
		await withWorkspaceState(["task-1"], async ({ workspacePath, candidates }) => {
			const startTaskSession = vi.fn();
			const started = await runStartupAutoResume({
				listReconciledSessions: () => candidates,
				loadScopedRuntimeConfig: async () => createRuntimeConfig({ autoResumeInterruptedTasks: false }),
				getScopedClineTaskSessionService: async () => createClineService(true),
				startTaskSession,
				warn: () => {},
			});

			expect(started).toBe(0);
			expect(startTaskSession).not.toHaveBeenCalled();
			const state = await loadWorkspaceState(workspacePath);
			expect(state.board.columns.find((column) => column.id === "trash")?.cards).toHaveLength(1);
		});
	});

	it("skips sessions whose agent binary is unavailable and reports the skip", async () => {
		commandDiscoveryMocks.isBinaryAvailableOnPath.mockReturnValue(false);
		await withWorkspaceState(["task-1"], async ({ workspacePath, candidates }) => {
			const startTaskSession = vi.fn();
			const warn = vi.fn();
			const started = await runStartupAutoResume({
				listReconciledSessions: () => candidates,
				loadScopedRuntimeConfig: async () => createRuntimeConfig(),
				getScopedClineTaskSessionService: async () => createClineService(true),
				startTaskSession,
				warn,
			});

			expect(started).toBe(0);
			expect(startTaskSession).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("not available on PATH"));
			const state = await loadWorkspaceState(workspacePath);
			expect(state.board.columns.find((column) => column.id === "trash")?.cards).toHaveLength(1);
		});
	});

	it("resumes a bounded number of interrupted tasks and moves them to review", async () => {
		const taskIds = Array.from({ length: MAX_AUTO_RESUME_TASKS_PER_STARTUP + 2 }, (_, index) => `task-${index + 1}`);
		await withWorkspaceState(taskIds, async ({ workspacePath, candidates }) => {
			const startTaskSession = vi.fn(async (_scope, request: RuntimeTaskSessionStartRequest) => ({
				ok: true as const,
				summary: {
					...createInterruptedSummary(request.taskId, "claude"),
					state: "awaiting_review" as const,
					reviewReason: "attention" as const,
				},
			}));
			const started = await runStartupAutoResume({
				listReconciledSessions: () => candidates,
				loadScopedRuntimeConfig: async () => createRuntimeConfig(),
				getScopedClineTaskSessionService: async () => createClineService(true),
				startTaskSession,
				warn: () => {},
			});

			expect(started).toBe(MAX_AUTO_RESUME_TASKS_PER_STARTUP);
			expect(startTaskSession).toHaveBeenCalledTimes(MAX_AUTO_RESUME_TASKS_PER_STARTUP);
			expect(startTaskSession).toHaveBeenCalledWith(
				expect.objectContaining({ workspacePath }),
				expect.objectContaining({ resumeFromTrash: true, prompt: "", agentId: "claude" }),
			);
			const state = await loadWorkspaceState(workspacePath);
			expect(state.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(
				MAX_AUTO_RESUME_TASKS_PER_STARTUP,
			);
			expect(state.board.columns.find((column) => column.id === "trash")?.cards).toHaveLength(2);
		});
	});
	it("skips home-agent sessions and reports the skip", async () => {
		await withWorkspaceState(["__home_agent__:workspace:claude"], async ({ candidates }) => {
			const startTaskSession = vi.fn();
			const warn = vi.fn();
			const started = await runStartupAutoResume({
				listReconciledSessions: () => candidates,
				loadScopedRuntimeConfig: async () => createRuntimeConfig(),
				getScopedClineTaskSessionService: async () => createClineService(true),
				startTaskSession,
				warn,
			});

			expect(started).toBe(0);
			expect(startTaskSession).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("Home agent sessions"));
		});
	});

	it("does not auto-resume a Cline task without a persisted session", async () => {
		await withWorkspaceState(["cline-task"], async ({ candidates }) => {
			const startTaskSession = vi.fn();
			const warn = vi.fn();
			const clineService = createClineService(false);
			const started = await runStartupAutoResume({
				listReconciledSessions: () =>
					candidates.map((candidate) => ({
						...candidate,
						summary: createInterruptedSummary(candidate.summary.taskId, "cline"),
					})),
				loadScopedRuntimeConfig: async () => createRuntimeConfig({ selectedAgentId: "cline" }),
				getScopedClineTaskSessionService: async () => clineService,
				startTaskSession,
				warn,
			});

			expect(clineService.reconcileInterruptedTaskSession).toHaveBeenCalled();
			expect(started).toBe(0);
			expect(startTaskSession).not.toHaveBeenCalled();
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("No persisted Cline session"));
		});
	});
});
