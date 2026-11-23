# Test Layout

- `test/core`: unit tests for core logic
- `test/cli`: unit tests for CLI parsing and output
- `test/integration`: integration tests that touch filesystem or process boundaries
- `test/fixtures`: stable test data
- `test/utilities`: shared test helpers

Use `*.test.ts` for deterministic unit tests. Use `*.integration.test.ts` for optional env-dependent tests.

## Which tests run where

- `pnpm test` (alias for `test:fast`) runs `test/runtime` + `test/utilities` and skips
  `test/integration`. This is the fast path used by the pre-commit hook (`test:precommit`).
- `pnpm test:integration` runs only `test/integration`. These tests spawn real CLI/server
  subprocesses and boot a fresh process per scenario, so they are slow by design.
- `pnpm test:all` runs everything. CI runs `test:fast` and `test:integration` as separate
  steps so a failure is attributed to the right suite.
- `pnpm run check` (also the publish gate via `prepublishOnly`) uses `test:all`, so publishing
  still requires the integration suite to pass.
