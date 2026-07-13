import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../kernel/src/index.ts";

export function resolveCanonicalHarnessRoot(input: HarnessLayoutInput): string {
  const layout = resolveHarnessLayout(input);
  if (layout.configPath) return layout.rootDir;

  const gitFilePath = path.join(layout.rootDir, ".git");
  if (!isFile(gitFilePath)) return layout.rootDir;
  const gitDir = linkedWorktreeGitDir(gitFilePath);
  if (!gitDir) return layout.rootDir;
  const commonDir = linkedWorktreeCommonDir(gitDir);
  if (!commonDir) return layout.rootDir;

  const canonicalLayout = resolveHarnessLayout(path.dirname(commonDir));
  return canonicalLayout.configPath ? canonicalLayout.rootDir : layout.rootDir;
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
