// @slice-activation PLT-Boundary W2 exports the daemon-owned canonical harness root to CLI consumers.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "@harness-anything/kernel";

export type CanonicalHarnessRootResolution =
  | { readonly root: string; readonly source: "local-layout"; readonly isHarnessRepository: boolean }
  | { readonly root: string; readonly source: "git-common-dir"; readonly canonicalRoot: string; readonly isHarnessRepository: true }
  | { readonly root: string; readonly source: "git-common-dir-unresolved"; readonly canonicalRoot: string; readonly isHarnessRepository: false };

export function resolveCanonicalHarnessRoot(input: HarnessLayoutInput): string {
  return resolveCanonicalHarnessRootResolution(input).root;
}

export function resolveCanonicalHarnessRootResolution(input: HarnessLayoutInput): CanonicalHarnessRootResolution {
  const layout = resolveHarnessLayout(input);
  if (layout.configPath) return { root: layout.rootDir, source: "local-layout", isHarnessRepository: true };

  const gitFilePath = path.join(layout.rootDir, ".git");
  if (!isFile(gitFilePath)) return { root: layout.rootDir, source: "local-layout", isHarnessRepository: false };
  const gitDir = linkedWorktreeGitDir(gitFilePath);
  if (!gitDir) return { root: layout.rootDir, source: "local-layout", isHarnessRepository: false };
  const commonDir = linkedWorktreeCommonDir(gitDir);
  if (!commonDir) return { root: layout.rootDir, source: "local-layout", isHarnessRepository: false };

  const canonicalRoot = path.dirname(commonDir);
  const canonicalLayout = resolveHarnessLayout(canonicalRoot);
  return canonicalLayout.configPath
    ? { root: canonicalLayout.rootDir, source: "git-common-dir", canonicalRoot, isHarnessRepository: true }
    : { root: layout.rootDir, source: "git-common-dir-unresolved", canonicalRoot, isHarnessRepository: false };
}

function linkedWorktreeGitDir(gitFilePath: string): string | undefined {
  const match = /^gitdir:\s*(.+?)\s*$/iu.exec(readFileSync(gitFilePath, "utf8"));
  if (!match) return undefined;
  const gitDir = path.resolve(path.dirname(gitFilePath), match[1]!);
  return existsSync(gitDir) ? realpathSync.native(gitDir) : undefined;
}

function linkedWorktreeCommonDir(gitDir: string): string | undefined {
  const commonDirPath = path.join(gitDir, "commondir");
  if (!isFile(commonDirPath)) return undefined;
  const relativeCommonDir = readFileSync(commonDirPath, "utf8").trim();
  if (!relativeCommonDir) return undefined;
  const commonDir = path.resolve(gitDir, relativeCommonDir);
  return existsSync(commonDir) ? realpathSync.native(commonDir) : undefined;
}

function isFile(inputPath: string): boolean {
  try {
    return statSync(inputPath).isFile();
  } catch {
    return false;
  }
}
