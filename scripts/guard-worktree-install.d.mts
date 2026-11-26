/**
 * Types for `scripts/guard-worktree-install.mjs`, which the root `preinstall`
 * lifecycle script runs. Kept next to the script so TypeScript tests can import
 * the pure predicate without `allowJs`.
 */

/** True when any candidate path is inside a `.cline/worktrees/<id>` directory. */
export declare function isInsideTaskWorktree(paths: string[]): boolean;
