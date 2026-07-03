import { execFileSync } from "node:child_process";

const gitMaxBuffer = 256 * 1024 * 1024;

export interface GitDiffEvidenceOptions {
  readonly rootDir: string;
  readonly baseRef?: string;
}

export interface GitDiffEvidenceFile {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "unknown";
  readonly indexStatus: string;
  readonly worktreeStatus: string;
}

export interface GitDiffEvidenceReport {
  readonly schema: "git-diff-evidence/v1";
  readonly ok: boolean;
  readonly baseRef?: string;
  readonly head: string | null;
  readonly dirty: boolean;
  readonly readOnly: true;
  readonly fileCount: number;
  readonly files: ReadonlyArray<GitDiffEvidenceFile>;
  readonly error?: string;
}

export function collectGitDiffEvidence(options: GitDiffEvidenceOptions): GitDiffEvidenceReport {
  const head = readGit(options.rootDir, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) return unavailable(head.error);

  const status = readGit(options.rootDir, [
    "-c",
    "status.renames=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all"
  ]);
  if (!status.ok) return unavailable(status.error, head.stdout);

  const statusFiles = parsePorcelainStatus(status.stdout);
  const baseFiles = options.baseRef ? readBaseDiff(options.rootDir, options.baseRef) : [];
  const files = mergeFiles([...baseFiles, ...statusFiles]);

  return {
    schema: "git-diff-evidence/v1",
    ok: true,
    ...(options.baseRef ? { baseRef: options.baseRef } : {}),
    head: head.stdout.trim(),
    dirty: files.length > 0,
    readOnly: true,
    fileCount: files.length,
    files
  };
}

function readBaseDiff(rootDir: string, baseRef: string): ReadonlyArray<GitDiffEvidenceFile> {
  const result = readGit(rootDir, ["-c", "diff.renames=false", "diff", "--name-status", "-z", baseRef, "--"]);
  return result.ok ? parseNameStatus(result.stdout) : [];
}

function parsePorcelainStatus(output: string): ReadonlyArray<GitDiffEvidenceFile> {
  return output.split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const indexStatus = entry.slice(0, 1);
      const worktreeStatus = entry.slice(1, 2);
      const filePath = entry.slice(3);
      return makeFile(filePath, indexStatus, worktreeStatus);
    })
    .filter(isRelativePath);
}

function parseNameStatus(output: string): ReadonlyArray<GitDiffEvidenceFile> {
  const parts = output.split("\0").filter((part) => part.length > 0);
  const files: GitDiffEvidenceFile[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const status = parts[index] ?? "";
    const filePath = parts[index + 1] ?? "";
    files.push(makeFile(filePath, status.slice(0, 1), " "));
  }
  return files.filter(isRelativePath);
}

function makeFile(filePath: string, indexStatus: string, worktreeStatus: string): GitDiffEvidenceFile {
  return {
    path: filePath,
    status: classifyStatus(indexStatus, worktreeStatus),
    indexStatus,
    worktreeStatus
  };
}

function classifyStatus(indexStatus: string, worktreeStatus: string): GitDiffEvidenceFile["status"] {
  const status = indexStatus === " " || indexStatus === "?" ? worktreeStatus : indexStatus;
  if (indexStatus === "?" && worktreeStatus === "?") return "untracked";
  if (status === "A") return "added";
  if (status === "M") return "modified";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  return "unknown";
}

function mergeFiles(files: ReadonlyArray<GitDiffEvidenceFile>): ReadonlyArray<GitDiffEvidenceFile> {
  const byPath = new Map<string, GitDiffEvidenceFile>();
  for (const file of files) byPath.set(file.path, file);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function isRelativePath(file: GitDiffEvidenceFile): boolean {
  return !file.path.startsWith("/") && !file.path.split("/").includes("..");
}

function unavailable(error: string, head: string | null = null): GitDiffEvidenceReport {
  return {
    schema: "git-diff-evidence/v1",
    ok: false,
    head: head?.trim() ?? null,
    dirty: false,
    readOnly: true,
    fileCount: 0,
    files: [],
    error
  };
}

function readGit(rootDir: string, args: ReadonlyArray<string>): { readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly error: string } {
  try {
    return {
      ok: true,
      stdout: execFileSync("git", ["-C", rootDir, "-c", "core.longpaths=true", ...args], {
        encoding: "utf8",
        maxBuffer: gitMaxBuffer,
        stdio: ["ignore", "pipe", "ignore"]
      })
    };
  } catch (error) {
    return { ok: false, error: gitErrorMessage(error) };
  }
}

function gitErrorMessage(error: unknown): string {
  if (typeof error === "object" && error && "code" in error && typeof (error as { readonly code?: unknown }).code === "string") {
    const code = (error as { readonly code: string }).code;
    if (code.length > 0) return `git command failed: ${code}`;
  }
  return "git command unavailable for this repository";
}
