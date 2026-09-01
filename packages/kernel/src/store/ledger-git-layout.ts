import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
export interface LedgerGitLayout {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly authoredPrefix: string;
}
// The Git repository root of an existing authored root does not move while a process is
// attached to it, but deriving it costs a `git rev-parse --show-toplevel` subprocess. The
// write path resolves the layout on nearly every command and again on every WAL reload, so
// the derivation — and the layout object identity downstream per-commit caches key on — is
// memoized per normalized authored root. Harness layout settings stay uncached: a changed
// harness.yaml resolves to a different authored root and therefore a different key.
const ledgerTopLevelCache = new Map<string, LedgerGitLayout>();
export function resolveLedgerGitLayout(input: HarnessLayoutInput): LedgerGitLayout {
  const vcs = makeLocalVersionControlSystem(),
    authoredRoot = vcs.normalizePath(resolveHarnessLayout(input).authoredRoot),
    cached = ledgerTopLevelCache.get(authoredRoot);
  if (cached) return cached;
  const rootDir = vcs.topLevel(authoredRoot);
  if (!rootDir) throw new Error(`authored root must belong to its ledger Git repository: ${authoredRoot}`);
  const authoredPrefix = path.relative(rootDir, authoredRoot).split(path.sep).join("/");
  if (authoredPrefix === ".." || authoredPrefix.startsWith("../"))
    throw new Error(`authored root must be inside its ledger Git repository: ${authoredRoot}`);
  const layout = { rootDir, authoredRoot, authoredPrefix };
  if (ledgerTopLevelCache.size >= 64) ledgerTopLevelCache.clear();
  ledgerTopLevelCache.set(authoredRoot, layout);
  return layout;
}
export function ledgerGitPath(layout: LedgerGitLayout, authoredRelativePath: string): string {
  return layout.authoredPrefix ? `${layout.authoredPrefix}/${authoredRelativePath}` : authoredRelativePath;
}
