This file captures tribal knowledge-the nuanced, non-obvious patterns that make the difference between a quick fix and hours of debugging.
When to add to this file:
- User had to intervene, correct, or hand-hold
- Multiple back-and-forth attempts were needed to get something working
- You discovered something that required reading many files to understand
- A change touched files you wouldn't have guessed
- Something worked differently than you expected
- User explicitly asks to add something
Proactively suggest additions when any of the above happen-don't wait to be asked.
What NOT to add: Stuff you can figure out from reading a few files, obvious patterns, or standard practices. This file should be high-signal, not comprehensive.

---

TypeScript principles
- No any types unless absolutely necessary.
- Check node_modules for external API type definitions instead of guessing.
- Prefer SDK-provided types, schemas, helpers, and model metadata over local redefinitions. For things like Cline SDK reasoning settings, use the SDK's source of truth whenever possible instead of recreating unions, support checks, or shapes in Kanban.
- NEVER use inline imports. No await import("./foo.js"), no import("pkg").Type in type positions, and no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies. Upgrade the dependency instead.

Code quality
- Write production-quality code, not prototypes
- Break components into small, single-responsibility files. 
- Extract shared logic into hooks and utilities. 
- Prioritize maintainability and clean architecture over speed. 
- Follow DRY principles and maintain clean architecture with clear separation of concerns.
- In `web-ui`, prefer `react-use` hooks (via `@/kanban/utils/react-use`) whenever possible
- Before adding custom utility code, evaluate whether a well-maintained third-party package can reduce complexity and long-term maintenance cost.

Architecture opinions
- Avoid thin shell wrappers that only forward props or relocate JSX for a single call site.
- Prefer extracting domain logic (state, effects, async orchestration) over presentation-only pass-through layers.
- Do not optimize for line count alone. Optimize for codebase navigability and clarity.

Git guardrails
- NEVER commit unless user asks.

GitHub issues
When reading issues:
- Always read all comments on the issue.
- Use this command to get everything in one call:
  gh issue view <number> --json title,body,comments,labels,state

When closing issues via commit:
- Include fixes #<number> or closes #<number> in the commit message. This automatically closes the issue when the commit is merged.

web-ui Stack
- Kanban web-ui uses Tailwind CSS v4 for styling, Radix UI for accessible headless primitives, and Lucide React for icons.
- Custom UI primitives live in `src/components/ui/` (button, dialog, tooltip, kbd, spinner, cn utility).
- Toast notifications use `sonner`. Import `{ toast }` from `"sonner"` or use `showAppToast` from `@/components/app-toaster`.

Styling mental model
- Use Tailwind utility classes as the primary styling system. Prefer `className` over inline `style={{}}`.
- Prefer Tailwind classes over adding custom CSS in `globals.css` when possible. Conditional Tailwind classes via `cn()` are better than CSS overrides for state-driven styling (e.g. selected/active variants). Reserve `globals.css` for things Tailwind can't express: complex selectors (sibling combinators, attribute selectors), app-level layout glue, or styles that genuinely need to cascade.
- Only use inline `style={{}}` for truly dynamic values (colors from props/variables, computed positions from drag-and-drop, runtime-dependent dimensions).
- The design system tokens are defined in `globals.css` inside `@theme { ... }`. Use Tailwind utilities that reference them: `bg-surface-0`, `text-text-primary`, `border-border`, etc.

Design tokens (defined in globals.css @theme)
- Surface hierarchy: `surface-0` (#1F2428, app bg / columns), `surface-1` (#24292E, navbar / project col / raised), `surface-2` (#2D3339, cards/inputs), `surface-3` (#353C43, hover), `surface-4` (#3E464E, pressed/scrollbars)
- Borders: `border` (#30363D, default), `border-bright` (#444C56, more visible), `border-focus` (#0084FF, focus rings)
- Text: `text-primary` (#E6EDF3), `text-secondary` (#8B949E), `text-tertiary` (#6E7681)
- Accent: `accent` (#0084FF), `accent-hover` (#339DFF)
- Status: `status-blue` (#4C9AFF), `status-green` (#3FB950), `status-orange` (#D29922), `status-red` (#F85149), `status-purple` (#A371F7), `status-gold` (#D4A72C)
- Border radius: `rounded-sm` (4px), `rounded-md` (6px), `rounded-lg` (8px), `rounded-xl` (12px)

UI primitives (src/components/ui/)
- `Button` from `@/components/ui/button`: `variant="default"|"primary"|"danger"|"ghost"`, `size="sm"|"md"`, `icon={<LucideIcon />}`, `fill`, children for text content.
- `Dialog`, `DialogHeader`, `DialogBody`, `DialogFooter` from `@/components/ui/dialog`: For modals. `DialogHeader` takes a `title` string.
- `AlertDialog`, `AlertDialogTitle`, `AlertDialogDescription`, `AlertDialogAction`, `AlertDialogCancel` from `@/components/ui/dialog`: For destructive confirmations.
- `Tooltip` from `@/components/ui/tooltip`: `<Tooltip content="text"><trigger/></Tooltip>`.
- `Spinner` from `@/components/ui/spinner`: `size` (number), `className`.
- `Kbd` from `@/components/ui/kbd`: Keyboard shortcut display.
- `cn` from `@/components/ui/cn`: Utility for conditional className joining.

Icons
- Use `lucide-react` for all icons. Import individual icons: `import { Settings, Plus, Play } from "lucide-react"`.
- Standard icon sizes: 14px for small buttons, 16px for default contexts.
- Pass icons as JSX elements to button `icon` prop: `icon={<Settings size={16} />}`.

Radix UI primitives
- Use Radix directly for headless behavior: `@radix-ui/react-popover`, `@radix-ui/react-dropdown-menu`, `@radix-ui/react-checkbox`, `@radix-ui/react-switch`, `@radix-ui/react-collapsible`, `@radix-ui/react-select`.
- Style Radix components with Tailwind classes. Use `data-[state=checked]:` for state-driven styling.

Dark theme
- The app is always in dark theme. Colors are set via CSS custom properties in `globals.css`.
- Surface hierarchy: `bg-surface-0` (app background) -> `bg-surface-1` (raised panels) -> `bg-surface-2` (cards/inputs) -> `bg-surface-3` (hover) -> `bg-surface-4` (pressed).
- Do NOT use Blueprint, Tailwind's light-mode defaults, or any `dark:` prefix. The theme is always dark.

Misc. tribal knowledge
- Kanban's native Cline agent is powered by the installed `@clinebot/core` and `@clinebot/llms` packages plus the local `src/cline-sdk/` boundary layer, so when Cline behavior is unclear, inspect those packages and `src/cline-sdk/` for the real implementation details.
- Kanban is launched from the user's shell and inherits its environment. For agent detection and task-agent startup, prefer direct PATH checks and direct process launches over spawning an interactive shell. Avoid `zsh -i`, shell fallback command discovery, or "launch shell then type command into it" on hot paths. On setups with heavy shell init like `conda` or `nvm`, doing that per task can freeze the runtime and even make new Terminal.app windows feel hung when several tasks start at once. It's fine to use an actual interactive shell for explicit shell terminals, not for normal agent session work.
- Kanban's inherited PATH is the single source of truth for both agent detection and agent spawns. A binary that is only on PATH after interactive shell init (for example `sf` at `~/.local/share/pnpm/bin/sf` added by `~/.zshrc`) is intentionally reported as not installed. The supported escape hatch is the opt-in `agentPathPrepend` / `agentEnv` keys in `~/.cline/kanban/config.json`, resolved by `src/config/agent-runtime-env.ts` and applied to both `isBinaryAvailableOnPath` and the PTY launch env. Do not "fix" a missing agent binary by spawning an interactive shell; extend the shared helper instead.
- Native Cline `run_commands` is hard-coded to a 30s timeout inside `@clinebot/core` 0.0.38, in both the tool-level race and the spawned process executor, and no `CLINE_*TIMEOUT*` env var or session setting exists. Kanban overrides it with `agentCommandTimeoutSec` (`~/.cline/kanban/config.json`, Settings -> Command timeout): `src/cline-sdk/sdk-runtime-boundary.ts` rebuilds the tool through the SDK's own `createDefaultExecutors` / `createDefaultTools` factories and `cline-session-runtime.ts` registers it last in `localRuntime.extraTools`. Core composes tools as `[...builtins, ...extraTools]` and `@clinebot/agents` stores them in a name-keyed Map, so the last duplicate wins for both the model-visible schema and execution. Delete the override once upstream threads `bashTimeoutMs` through session config.
- If CI hangs on Node 22 after tests seem to finish, suspect a live subprocess or SDK-host startup path before assuming a slow test body. Read `.plan/docs/node22-ci-hanging-tests-investigation.md` before repeating that investigation. `test/runtime/cline-sdk/cline-task-session-service.test.ts` was the big prior culprit because a unit-style suite was still booting the real Cline SDK host.
- `pnpm test` is deliberately the FAST path (`test:fast` = `test/runtime` + `test/utilities`, ~603 tests / ~5s) and EXCLUDES `test/integration`. Do not "restore" it to `vitest run`. The integration suite spawns a real CLI/server subprocess and boots a fresh process per scenario (~2s each), so it is ~45s of mostly serial cold starts; `test/integration/runtime-state-stream.integration.test.ts` alone does 14 boots across 11 tests and is the slowest file in the repo. Use `pnpm test:all` for everything, `pnpm test:integration` for just the integration suite (CI runs these as separate steps). `pnpm run check` / `prepublishOnly` intentionally uses `test:all`, so publishing still requires integration coverage. Note that raising the spawned-server startup timeout is NOT enough on its own: each integration test also has its own per-test timeout, and the boot budget must stay below it or the test dies with vitest's generic timeout instead of the harness's useful one.
- Splitting a slow integration file into multiple files to "parallelise" it makes `pnpm test` SLOWER, not faster. Vitest computes `maxWorkers` from CPU count, not from the subprocesses tests spawn, so extra files just create more concurrent out-of-band server boots competing for the same cores, while each file re-pays the full module-graph setup. Measured: capping `--maxWorkers` (8 vs 15) and splitting both failed to help; the run is bound by the serial chain of ~2s cold starts, so the only real lever is per-boot cost (which is why `src/cli.ts` keeps telemetry imports lazy).
- When Kanban runs on a headless remote Linux instance (for example over SSH+tunnel), native folder picker commands may be unavailable (`zenity`/`kdialog`). Treat this as a normal remote-runtime limitation and use manual path entry fallback instead of requiring desktop packages.
- Do not early-return a full-page fallback from `App.tsx` for a transient runtime disconnect. Replacing the app tree unmounts every composer and terminal surface, which is why unsent prompts used to disappear on a Cloudflare-tunnel blip. Keep the shell mounted once a snapshot has loaded and show `RuntimeDisconnectedFallback variant="overlay"` instead; unsent chat/new-task drafts are also persisted in `web-ui/src/storage/text-drafts.ts` so a real reload can restore them.
- Persistent task-terminal reconnects must reopen the whole per-viewer socket pair, not just the IO socket. `src/terminal/ws-server.ts` only clears a viewer's `restoreComplete` gate and re-sends the `restore` snapshot when the control socket connects, so reconnecting IO alone leaves the client waiting for a restore that never arrives. `web-ui/src/terminal/persistent-terminal-manager.ts` therefore tears down both sockets on any abnormal close and reconnects them together.
- A `404 Unknown workspace ID: <id>` from the runtime is almost never a bad workspace id - it means workspace resolution failed. Every workspace-scoped tRPC request resolves its id through `loadWorkspaceScopeById` (`src/state/workspace-state.ts`), which must stay lock-free and must not spawn git. The historical failure was `loadWorkspaceContext` taking the global `~/.cline/kanban/workspaces/index.json` write lock and running 4-5 `spawnSync` git probes inside it, so concurrent requests (e.g. clicking Commit while state/git queries are in flight) exhausted the `proper-lockfile` retry budget (~5-10s), `ELOCKED` was swallowed by a bare `catch { return null }`, and the client was told the workspace did not exist. Keep read paths off that lock, probe git outside it, and catch only `WorkspaceUnavailableError` when mapping a failure to "not found".
- `loadWorkspaceState` (and the old `loadWorkspaceStateById`) is not a polling primitive: it builds the git metadata via `detectGitRepositoryInfo`, which is four `spawnSync("git", ...)` calls, so every call blocks the runtime's event loop. The auto-review reconciler (`src/server/auto-review-reconciler.ts`) therefore reads the board with `loadWorkspaceBoardById` - one `readFile` + parse, no subprocess, no lock. When a new loop needs periodic state, take the narrowest reader that answers the question, and never a helper whose name hides a subprocess.
- `src/server/runtime-state-hub.ts` sends the initial `snapshot` frame *before* registering the socket in `runtimeStateClientsByWorkspaceId` (deliberate, so `workspace_metadata_updated` cannot race the snapshot). A workspace-scoped broadcast issued right after the snapshot can therefore be silently dropped. Tests that connect a client then broadcast must prove registration happened instead of sleeping: probe with `broadcastTaskReadyForReview` (same per-workspace fan-out, sends immediately) until a frame lands. Otherwise the test fails as "broadcast never arrives" and looks like a hub bug. The helper lives in `test/runtime/server/runtime-state-hub.test.ts`.
- `applyAgentRuntimeEnv` (`src/config/agent-runtime-env.ts`) rebuilds `PATH` with Node's `delimiter`, which is host-dependent (`:` on POSIX, `;` on Windows). So a test that fakes `platform = "win32"` and expects `src/core/windows-cmd-launch.ts` to resolve a bare binary out of a `;`-separated PATH cannot work on a POSIX host once `agentPathPrepend` is configured: the rebuilt `:`-joined PATH collapses into a single `;`-separated entry, resolution fails, and `shouldUseWindowsCmdLaunch` falls back to `cmd.exe`. Such a test passes only on a machine with an empty config, so gate it on a real Windows host (`it.skipIf(!isWindows)`), as `test/runtime/terminal/pty-session.test.ts` does. Cases that only assert argument construction stay ungated - they hold on any host.
