import { defineConfig } from "vitest/config";

process.env.NODE_ENV = "production";

// Tests must be hermetic. A developer's shell may export runtime settings
// (for example `KANBAN_RUNTIME_PORT=3485`) that leak into the test process and
// break suites asserting the default runtime endpoint. Tests that need a
// specific endpoint set it explicitly through `src/core/runtime-endpoint`.
delete process.env.KANBAN_RUNTIME_PORT;
delete process.env.KANBAN_RUNTIME_HOST;
delete process.env.KANBAN_RUNTIME_HTTPS;
delete process.env.KANBAN_RUNTIME_TLS_CA;

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// `packages/**` excluded: those workspaces have their own vitest
		// configs and runtime shapes (e.g. Electron) and are run explicitly by
		// CI. New workspaces under `packages/` MUST get matching install/test
		// steps in .github/workflows/test.yml or they fall out of CI coverage.
		exclude: [
			"apps/**",
			"packages/**",
			"web-ui/**",
			"third_party/**",
			"**/node_modules/**",
			"**/dist/**",
			".worktrees/**",
		],
		testTimeout: 15_000,
	},
});
