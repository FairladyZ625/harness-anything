import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  findConflictMarkerWarnings,
  resolveHarnessLayout,
  type HarnessLayoutInput,
  type ProjectionWarning
} from "@harness-anything/kernel";

export interface IncrementalConflictMarkerPreflight {
  readonly read: () => ProjectionWarning | undefined;
}

export interface IncrementalConflictMarkerPreflightScan {
  readonly mode: "full" | "incremental";
  readonly candidateCount?: number;
}

/**
 * Keeps the authored-tree conflict baseline for one long-lived writer generation.
 * The first read covers every governed text file; later reads cover only paths whose
 * Git state differs from the last clean authored HEAD plus the two root policy files.
 */
export function makeIncrementalConflictMarkerPreflight(
  rootInput: HarnessLayoutInput,
  options: {
    readonly onScan?: (scan: IncrementalConflictMarkerPreflightScan) => void;
  } = {}
): IncrementalConflictMarkerPreflight {
  const layout = resolveHarnessLayout(rootInput);
  let cleanAuthoredHead: string | undefined;

  return {
    read: () => {
      const gitState = readAuthoredGitState(layout.authoredRoot);
      const currentHead = gitState?.head ?? null;
      const changedAuthoredPaths = cleanAuthoredHead && gitState
        ? readChangedGitPaths(layout.authoredRoot, cleanAuthoredHead, gitState)
        : null;
      if (changedAuthoredPaths === null) {
        options.onScan?.({ mode: "full" });
        const warning = findConflictMarkerWarnings(rootInput)[0];
        if (!warning && currentHead) cleanAuthoredHead = currentHead;
        return warning;
      }

      const candidates = [...new Set([
        path.join(layout.rootDir, "AGENTS.md"),
        path.join(layout.rootDir, "CLAUDE.md"),
        ...changedAuthoredPaths.map((entry) => path.join(layout.authoredRoot, entry))
      ].filter((entry) => isTextLikePath(entry)))];
      options.onScan?.({ mode: "incremental", candidateCount: candidates.length });
      const warning = findConflictMarkerWarnings(rootInput, candidates)[0];
      if (!warning && currentHead) cleanAuthoredHead = currentHead;
      return warning;
    }
  };
}

interface AuthoredGitState {
  readonly head: string;
  readonly worktreePaths: ReadonlyArray<string>;
}

function readAuthoredGitState(repoRoot: string): AuthoredGitState | null {
  try {
    const entries = readGit(repoRoot, [
      "status",
      "--porcelain=v2",
      "--branch",
      "-z",
      "--untracked-files=all",
      "--ignored=matching"
    ]).split("\0");
    let head: string | undefined;
    const worktreePaths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      const oid = /^# branch\.oid ([0-9a-f]{40})$/u.exec(entry)?.[1];
      if (oid) {
        head = oid;
        continue;
      }
      const fieldCount = entry.startsWith("1 ")
        ? 8
        : entry.startsWith("2 ")
          ? 9
          : entry.startsWith("u ")
            ? 10
            : undefined;
      if (fieldCount !== undefined) {
        const changedPath = pathAfterFields(entry, fieldCount);
        if (changedPath) worktreePaths.push(changedPath);
        if (entry.startsWith("2 ")) {
          const originalPath = entries[index + 1];
          if (originalPath) worktreePaths.push(originalPath);
          index += 1;
        }
        continue;
      }
      if (entry.startsWith("? ") || entry.startsWith("! ")) {
        worktreePaths.push(entry.slice(2));
      }
    }
    return head ? { head, worktreePaths } : null;
  } catch {
    return null;
  }
}

function readChangedGitPaths(
  repoRoot: string,
  cleanHead: string,
  state: AuthoredGitState
): ReadonlyArray<string> | null {
  try {
    const committedPaths = state.head === cleanHead
      ? []
      : nullSeparatedPaths(readGit(repoRoot, ["diff", "--name-only", "-z", cleanHead, state.head, "--"]));
    return [...new Set([...state.worktreePaths, ...committedPaths])]
      .filter((entry) => safeRepoRelativePath(entry))
      .filter((entry) => !entry.split(/[\\/]/u).some((part) =>
        part === ".git" || part === "node_modules" || part === ".harness"
      ));
  } catch {
    return null;
  }
}

function pathAfterFields(entry: string, fieldCount: number): string | null {
  let cursor = 0;
  for (let index = 0; index < fieldCount; index += 1) {
    cursor = entry.indexOf(" ", cursor);
    if (cursor < 0) return null;
    cursor += 1;
  }
  return entry.slice(cursor);
}

function nullSeparatedPaths(output: string): ReadonlyArray<string> {
  return output.split("\0").filter(Boolean);
}

function safeRepoRelativePath(relativePath: string): boolean {
  return relativePath.length > 0
    && !path.isAbsolute(relativePath)
    && !relativePath.split(/[\\/]/u).includes("..");
}

function isTextLikePath(filePath: string): boolean {
  return /\.(md|markdown|txt|ya?ml|json)$/iu.test(filePath);
}

function readGit(repoRoot: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true
  });
}
