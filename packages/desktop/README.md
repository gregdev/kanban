# @kanban/desktop

Electron shell for Kanban. It boots the Kanban runtime as a child process and
renders the bundled web UI in native windows.

The package contains two things:

- `src/` — the Electron main process, preload script and window management,
  compiled to `dist/` by `build:ts`.
- `cli/` — a staged copy of the **root** build output (`dist/cli.js` +
  `dist/web-ui/`), created by `stage:cli`. It is never committed and must be
  regenerated after any runtime/web UI change.

`electron-builder.yml` is the single source of truth for packaging: asar layout,
`asarUnpack` for node-pty, the `kanban://` protocol, and the per-platform
targets/icons.

## Prerequisites

- Node.js **>= 22.12** (the root `engines` field; Vitest 5 requires it).
- pnpm **12.21.0** (`packageManager` in the root `package.json` — `corepack enable`
  picks it up automatically).
- A native toolchain for node-pty, because `postinstall` runs
  `electron-builder install-app-deps` and `scripts/patch-node-pty.mjs`:
  - Windows: Visual Studio Build Tools (C++ workload) + Python 3. GitHub's
    `windows-latest` image already has both.
  - macOS: Xcode command line tools. If node-gyp fails on Python 3.12, pin
    Python 3.11 (see `.github/workflows/test.yml`).

## Build commands

Build the root package first. `stage:cli` validates its input and fails loudly
when `dist/cli.js` or `dist/web-ui/index.html` is missing:

```bash
pnpm install
pnpm run build                              # root: dist/cli.js + dist/web-ui
pnpm --filter @kanban/desktop run build:win
```

`cd packages/desktop && pnpm run build:win` is equivalent.

| Script | What it does | Output |
| --- | --- | --- |
| `stage:cli` | Copies root `dist/` into `packages/desktop/cli/` and writes an ESM `package.json` next to it | `cli/` |
| `build:ts` | `tsc` for the main process plus an esbuild bundle of `preload.ts`, and copies `disconnected.html` | `dist/` |
| `build` | `stage:cli` + `build:ts` + `electron-builder` with the config's default target | `out/` |
| `build:win` | Windows NSIS installer for x64 | `out/Kanban-<version>-x64.exe` |
| `build:win:dir` | Windows unpacked app only (`--dir`) — fastest iteration loop | `out/win-unpacked/` |
| `build:mac:dmg` | macOS DMG for the host architecture | `out/Kanban-<version>-<arch>.dmg` |
| `build:mac:arm64` / `build:mac:x64` | Same, forced to one architecture | `out/Kanban-<version>-<arch>.dmg` |
| `clean` | Removes `dist/`, `out/` and `cli/` for this package | — |

Windows output is unsigned by design (no code-signing certificate is
configured). Expect a SmartScreen warning on first launch.

### Fast iteration

`build:win:dir` skips NSIS and produces a runnable app tree:

```bash
pnpm --filter @kanban/desktop run build:win:dir
```

```powershell
packages\desktop\out\win-unpacked\Kanban.exe
```

It still re-runs `stage:cli`, so re-run `pnpm run build` at the root first when
you changed runtime or web UI code. Only changed Electron `src/` code needs the
`--dir` rebuild.

## What lands in `out/`

`directories.output` is `out/` (gitignored):

- `Kanban-<version>-x64.exe` — NSIS installer. Assisted (not one-click), installs
  per-user under `%LOCALAPPDATA%\Programs\Kanban` so it needs no elevation, and
  lets the user change the install directory.
- `win-unpacked/` (`win-arm64-unpacked/` for an arm64 build) — the unpacked
  application the installer is built from:
  `Kanban.exe`, `resources/bin/kanban.cmd`, `resources/app.asar` and
  `resources/app.asar.unpacked/` (staged CLI + node-pty). Handy for
  reproducing installer-only bugs without installing.
- `.icon-ico/icon.ico` — the icon electron-builder derived from `build/icon.png`.
- `builder-effective-config.yaml` / `builder-debug.yml` — the fully resolved
  config and packaging log. Read these first whenever a YAML option appears to
  be ignored.
- macOS builds add `Kanban-<version>-<arch>.dmg` plus `mac/`,
  `mac-x64/` or `mac-arm64/`.

## Windows builds must run on Windows

`node-pty` is a native module and `postinstall` rebuilds it against the Electron
ABI (`electron-builder install-app-deps`). A cross-build from Linux or WSL — even
with Wine installed, which electron-builder needs to edit the `.exe` — copies the
**host** platform's `.node` binaries into the Windows package. The app then
starts but every terminal fails to spawn, which looks like an unrelated PTY bug.

So: `build:win` on Windows only (a Windows VM, a Windows box, or the
`.github/workflows/desktop-windows.yml` runner). Treat Wine builds as
attach-only experiments for debugging the packaging step, never as shippable
artifacts.

## Icons and re-branding

- **Windows**: `build/icon.png`. Electron-builder converts it into the `.ico`
  used by `Kanban.exe`, the installer and the uninstaller, so replacing this one
  PNG re-brands the whole Windows surface. It must be at least 256×256; the
  committed copy is the 512×512 `web-ui/public/assets/icon-512.png`. Keep them in
  sync when the brand changes (or re-copy the web UI asset over it).
- **macOS**: `build/icon.icns` is a separate asset and is *not* derived from
  `icon.png`. Regenerate it from a `.iconset` with `iconutil -c icns`.

Do not rename `productName` / `win.executableName`: `build/bin/kanban.cmd`
resolves the bundled CLI runner as `<install root>\Kanban.exe`, and
`packages/desktop/src/main.ts` looks for `resources/bin/kanban.cmd`.

## CI

`.github/workflows/desktop-windows.yml` builds the installer on `windows-latest`
from a manual `workflow_dispatch` or a `v*` tag push. It sets
`CSC_IDENTITY_AUTO_DISCOVERY: false` so electron-builder does not hunt for a
signing identity, then uploads the `.exe` and a zipped `win-unpacked/` tree as
the `kanban-windows-installer` artifact.

Sentry sourcemap upload during the root build self-skips when
`SENTRY_AUTH_TOKEN` is absent, so no secrets are required.

## Manual verification checklist (Windows)

Run this against a fresh install from `Kanban-<version>-x64.exe` on a machine
that has never had Kanban installed:

1. **Installer runs.** The wizard offers a directory choice, installs without
   elevation, and finishes. `%LOCALAPPDATA%\Programs\Kanban\Kanban.exe` exists.
2. **App launches and spawns its bundled runtime.** Start it from the Start menu
   (not from a dev shell). The window loads the board instead of the
   "disconnected" screen, and the runtime is the bundled one —
   `%LOCALAPPDATA%\Programs\Kanban\resources\bin\kanban.cmd` should be the shim
   in use, not a global `kanban` install.
3. **A terminal works.** Open a task card's terminal, create a new task, or run
   the home shell. You must get an interactive prompt. If it stays blank, the
   PTY native module is wrong — see "Windows builds must run on Windows".
4. **`kanban://` protocol is registered.** `reg query HKCU\Software\Classes\kanban`
   resolves to the installed `Kanban.exe`. With the app already running,
   `Start-Process "kanban://oauth/callback?code=test"` focuses the existing
   window instead of opening a second instance (the OAuth relay will report a
   failure because there is no live flow — that is expected; what matters is
   that the deep link reached the running app).
5. **Uninstall is clean.** Uninstalling removes the install directory and the
   Start menu entry, and leaves user data (`%APPDATA%\Kanban`, `~/.cline/kanban`)
   intact.

Only steps 1–5 need a Windows host. Everything else in this repo (typecheck,
lint, unit tests) runs on any platform.

## Troubleshooting

- **`stage:cli` error: `dist/cli.js is missing`** — run `pnpm run build` at the
  repo root first; the desktop package never builds the runtime itself.
- **Installer builds but the terminal is dead** — native module mismatch
  (cross-build, or `postinstall` was skipped). Re-run
  `pnpm --filter @kanban/desktop run postinstall` on Windows and rebuild.
- **A YAML option looks ignored** — check `out/builder-effective-config.yaml`;
  CLI flags (`--win`, `--dir`, `--x64`) override the file.
- **`electron-builder` cannot find an icon** — the `icon` paths are resolved
  against this package's `directories.buildResources` (`build/`) and the package
  root, so `build/icon.png` means `packages/desktop/build/icon.png`.
