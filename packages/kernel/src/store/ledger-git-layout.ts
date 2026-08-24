import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { makeLocalVersionControlSystem } from "./local-version-control-system.ts";
export interface LedgerGitLayout {
  readonly rootDir: string;
  readonly authoredRoot: string;
  readonly authoredPrefix: string;
}
export function resolveLedgerGitLayout(input: HarnessLayoutInput): LedgerGitLayout {
  const vcs = makeLocalVersionControlSystem(),
    authoredRoot = vcs.normalizePath(resolveHarnessLayout(input).authoredRoot),
    rootDir = vcs.topLevel(authoredRoot);
  if (!rootDir) throw new Error(`authored root must belong to its ledger Git repository: ${authoredRoot}`);
  const authoredPrefix = path.relative(rootDir, authoredRoot).split(path.sep).join("/");
  if (authoredPrefix === ".." || authoredPrefix.startsWith("../"))
    throw new Error(`authored root must be inside its ledger Git repository: ${authoredRoot}`);
  return { rootDir, authoredRoot, authoredPrefix };
}
export function ledgerGitPath(layout: LedgerGitLayout, authoredRelativePath: string): string {
  return layout.authoredPrefix ? `${layout.authoredPrefix}/${authoredRelativePath}` : authoredRelativePath;
}
