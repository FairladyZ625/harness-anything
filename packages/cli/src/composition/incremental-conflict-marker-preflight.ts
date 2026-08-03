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
      const currentHead = readGitHead(layout.authoredRoot);
      const changedAuthoredPaths = cleanAuthoredHead && currentHead
        ? readChangedGitPaths(layout.authoredRoot, cleanAuthoredHead)
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

function readGitHead(repoRoot: string): string | null {
  try {
    return readGit(repoRoot, ["rev-parse", "--verify", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

function readChangedGitPaths(
  repoRoot: string,
  cleanHead: string
): ReadonlyArray<string> | null {
  try {
    const outputs = [
      readGit(repoRoot, ["diff", "--name-only", "-z", cleanHead, "--"]),
      readGit(repoRoot, ["ls-files", "--others", "-z"])
    ];
    return [...new Set(outputs.flatMap(nullSeparatedPaths))]
      .filter((entry) => safeRepoRelativePath(entry))
      .filter((entry) => !entry.split(/[\\/]/u).some((part) =>
        part === ".git" || part === "node_modules"
      ));
  } catch {
    return null;
  }
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
