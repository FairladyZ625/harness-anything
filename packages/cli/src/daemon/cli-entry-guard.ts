import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const cliEntryNotCanonicalCode = "cli_entry_not_canonical";

export class CliEntryNotCanonicalError extends Error {
  readonly code = cliEntryNotCanonicalCode;
  readonly entryPath: string;

  constructor(entryPath: string) {
    super(
      `CLI entry ${entryPath} is a linked worktree build, not the canonical checkout. ` +
        "Repair the global CLI from the canonical checkout: cd <canonical>/packages/cli && npm link",
    );
    this.name = "CliEntryNotCanonicalError";
    this.entryPath = entryPath;
  }
}

export function cliEntrypointPath(url: string = import.meta.url): string {
  return realpathSync(fileURLToPath(url));
}

// npm exposes the CLI through this dist entry. Source execution is deliberately left alone so
// repository tests and local development keep working from any checkout.
export function isLinkedCliDistEntry(entryPath: string): boolean {
  return entryPath.split(path.sep).join("/").includes("/packages/cli/dist/");
}

// The only way a global `ha` can silently run foreign code against the canonical daemon is a worker
// running `npm link` inside a linked worktree; that dist lives under `.worktrees/`.
export function assertCanonicalCliEntry(entryPath: string = cliEntrypointPath()): void {
  if (isLinkedCliDistEntry(entryPath) && entryPath.split(path.sep).includes(".worktrees"))
    throw new CliEntryNotCanonicalError(entryPath);
}
