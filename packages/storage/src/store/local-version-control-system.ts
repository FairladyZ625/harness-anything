import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-014 */
  execFileSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import {
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
  type HarnessLayout,
} from "@harness-anything/kernel/internal/layout/index.ts";
import { localRuntimeStateFileSystem } from "@harness-anything/kernel/internal/local/local-layout-file-system.ts";
import type {
  VcsCommitAuthor,
  VersionControlSystem,
} from "@harness-anything/kernel/internal/ports/version-control-system.ts";
import { VcsCommandError } from "@harness-anything/kernel/internal/ports/version-control-system.ts";
import { cmdShellInvocation } from "./cmd-command-line.ts";
import { makeLocalVersionControlCommands } from "./local-version-control-commands.ts";
import { writeFileDurably, type WriteFence } from "../durable-file.ts";

const gitMaxBuffer = 256 * 1024 * 1024,
  gitBatchChunkBytes = 64 * 1024 * 1024,
  gitBatchChunkEntries = 4_096,
  gitTreeArgumentBytes = 8 * 1024;

export function makeLocalVersionControlSystem(): VersionControlSystem {
  return makeLocalVersionControlCommands({
    normalizePath: normalizeLocalPath,
    topLevel: gitTopLevel,
    execute: runGit,
    executeAs: runGitAs,
  });
}

const geometricMaintenanceFloor = Object.freeze([2, 52, 0]);
/** Env marker the daemon injects into its own `git commit` so the ledger commit guard lets it through. */
export const HARNESS_LEDGER_WRITER_ENV = "HARNESS_LEDGER_WRITER";
const ledgerCommitGuardMarker = "# harness-ledger-commit-guard/v1",
  ledgerCommitGuardHook = `#!/bin/sh
${ledgerCommitGuardMarker}
# Installed by Harness ledger maintenance. The daemon's ledger writes go
# through git fast-import/update-ref and never reach this hook; the one commit
# it runs itself carries the writer env marker. Any other commit here moves the
# publication pointer and breaks the next ledger write with
# publication_indeterminate.
if [ "\${HARNESS_LEDGER_WRITER:-}" != "1" ]; then
  echo "Refusing a manual commit in the Harness ledger repository." >&2
  echo "Ledger writes go through the daemon: run 'ha doc sync --submit --task <task-id>' instead of git commit." >&2
  exit 1
fi
chained="$(dirname "$0")/pre-commit.local"
if [ -x "$chained" ]; then exec "$chained"; fi
exit 0
`;
export interface LedgerMaintenanceReceipt {
  readonly gitVersion: string | null;
  readonly strategy: "geometric" | null;
  readonly applied: readonly string[];
  readonly degraded: string | null;
}
/** Pins ledger maintenance and incremental-index policy out of the user-global config. */
export function configureLedgerMaintenance(repoRoot: string): LedgerMaintenanceReceipt {
  const version = readGitVersion(repoRoot),
    applied: string[] = [],
    degraded: string[] = [],
    // One `--list --local` answers every pin check; a per-key `--get` spent a git process each,
    // paid again by every repo attach.
    pinned = readLocalGitConfig(repoRoot);
  const pin = (key: string, value: string): void => {
    // Git variable names are case-insensitive, and `config --list` lowercases them on Git < 2.45.
    if (pinned.get(key.toLowerCase()) === value) return;
    runGit(repoRoot, "config", key, value);
    applied.push(`${key}=${value}`);
  };
  pin("maintenance.autoDetach", "true");
  pin("gc.autoDetach", "true");
  pin("core.autocrlf", "false");
  // WAL commits use fast-import and touch-path update-index. A split index is
  // pinned off: every index read re-inserts the not-yet-shared entries into the
  // sorted array (O(k x N), up to 20% of the index before Git rewrites it), which
  // made a 1M-event ledger's update-index cost 0.42 s per write instead of 3 ms.
  // Git converts an existing split index back on its next index write. The
  // untracked cache still keeps the authored settlement probe from re-statting
  // the full active tree.
  pin("core.splitIndex", "false");
  pin("core.untrackedCache", "true");
  // Git detects a worktree edit through the index's stat comparison, which only stays sound while
  // it may compare ctime and the inode (git-config(1) core.checkStat / core.trustctime): a host
  // that opts into `minimal` or `trustctime=false` leaves whole-second mtime and size, and
  // `rsync -a` restores mtime while an equal-length edit keeps size, so a changed document reads
  // as untouched and doc sync silently publishes nothing (deli-ai-lab T7, 2026-11-05). Repository
  // scope outranks global and system scope, so the ledger keeps the full model whatever the host's
  // Git policy is. POSIX cannot set ctime, so keeping it compared needs no content read; falling
  // back to hashing every candidate is the cost this pin avoids.
  pin("core.checkStat", "default");
  pin("core.trustctime", "true");
  const geometric = version !== null && atLeastGitVersion(version.parts, geometricMaintenanceFloor);
  if (geometric) pin("maintenance.strategy", "geometric");
  if (!geometric)
    degraded.push(
      `git ${version?.text ?? "(version unreadable)"} predates the 2.52.0 geometric maintenance strategy; this ledger keeps Git's default repack cadence.`,
    );
  return {
    gitVersion: version?.text ?? null,
    strategy: geometric ? "geometric" : null,
    applied,
    degraded: degraded.length ? degraded.join(" ") : null,
  };
}
export interface LedgerCommitGuardReceipt {
  readonly applied: readonly string[];
  readonly degraded: string | null;
}
/**
 * Installs the pre-commit guard that refuses a manual commit in the ledger repository, once; a
 * foreign hook is preserved as pre-commit.local and chained. Only a standalone ledger repository
 * (the shape bootstrap creates) is guarded: where the ledger root is a plain directory of the
 * project's own repository, every commit there is a project commit and none may be refused.
 */
export function installLedgerCommitGuard(repoRoot: string): LedgerCommitGuardReceipt {
  const gitDir = readGitText(repoRoot, ["rev-parse", "--git-dir"]);
  if (gitDir === null) return { applied: [], degraded: "ledger commit guard not installed: not a Git work tree." };
  const topLevel = readGitText(repoRoot, ["rev-parse", "--show-toplevel"]);
  if (topLevel !== null && normalizeLocalPath(topLevel) !== normalizeLocalPath(repoRoot))
    return {
      applied: [],
      degraded: "ledger commit guard not installed: the ledger root is not a standalone Git repository.",
    };
  const hooksDir = path.join(path.resolve(repoRoot, gitDir), "hooks"),
    hookPath = path.join(hooksDir, "pre-commit"),
    chainedPath = path.join(hooksDir, "pre-commit.local"),
    existing = existsSync(hookPath) ? readFileSync(hookPath, "utf8") : null;
  if (existing === ledgerCommitGuardHook) return { applied: [], degraded: null };
  if (existing !== null && !existing.includes(ledgerCommitGuardMarker)) {
    if (existsSync(chainedPath))
      return {
        applied: [],
        degraded:
          "ledger commit guard not installed: both hooks/pre-commit and hooks/pre-commit.local are occupied by foreign hooks.",
      };
    /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
    renameSync(hookPath, chainedPath);
  }
  /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
  mkdirSync(hooksDir, { recursive: true });
  /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
  writeFileSync(hookPath, ledgerCommitGuardHook, { mode: 0o755 });
  return { applied: ["hooks/pre-commit=harness-ledger-commit-guard/v1"], degraded: null };
}
function readGitVersion(repoRoot: string): { readonly text: string; readonly parts: readonly number[] } | null {
  const raw = readGitText(repoRoot, ["version"]);
  if (raw === null) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw);
  if (!match) return null;
  return { text: match[0], parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] };
}
/** The repository-local scope only: what the pins themselves write, so a pinned key reads back
 * pinned regardless of wider scopes. An unreadable local scope reads as empty (readGitText null),
 * which only re-runs the writes that establish the pins. */
function readLocalGitConfig(repoRoot: string): Map<string, string> {
  const values = new Map<string, string>();
  const raw = readGitText(repoRoot, ["config", "--list", "--local", "--null"]);
  if (raw === null) return values;
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\n");
    values.set(
      (separator === -1 ? entry : entry.slice(0, separator)).toLowerCase(),
      separator === -1 ? "" : entry.slice(separator + 1),
    );
  }
  return values;
}
function readGitText(repoRoot: string, args: readonly string[]): string | null {
  try {
    const value = runGit(repoRoot, ...args).trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function atLeastGitVersion(actual: readonly number[], floor: readonly number[]): boolean {
  for (let at = 0; at < floor.length; at += 1) {
    const seen = actual[at] ?? 0,
      want = floor[at] ?? 0;
    if (seen !== want) return seen > want;
  }
  return true;
}

function gitTopLevel(inputPath: string): string | null {
  try {
    let probe = path.resolve(inputPath);
    while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    return normalizeLocalPath(runGit(probe, "rev-parse", "--show-toplevel").trim());
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function normalizeLocalPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  if (existsSync(resolved)) return realpathSync.native(resolved);

  const pendingSegments: string[] = [];
  let current = resolved;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    pendingSegments.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync.native(current), ...pendingSegments);
}

function runGit(repoRoot: string, ...args: ReadonlyArray<string>): string {
  return runGitAs(repoRoot, undefined, ...args);
}

function runGitAs(repoRoot: string, author: VcsCommitAuthor | undefined, ...args: ReadonlyArray<string>): string {
  localGitProcesses += 1;
  const invocation = gitInvocation(repoRoot, args);
  try {
    return (
      /* @gate-identity check-sync-subprocess/sync-subprocess-015 */
      execFileSync(invocation.command, invocation.args, {
        encoding: "utf8",
        maxBuffer: gitMaxBuffer,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
        env: {
          ...process.env,
          ...(author
            ? {
                GIT_AUTHOR_NAME: author.name,
                GIT_AUTHOR_EMAIL: author.email,
                GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
                GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email,
              }
            : {}),
        },
      })
    );
  } catch (error) {
    throw new VcsCommandError({
      command: args[0] ?? "command",
      cwd: repoRoot,
      exitCode: commandErrorCode(error),
      signal: commandErrorSignal(error),
      stderrSummary: commandErrorSummary(error),
    });
  }
}

function commandErrorCode(error: unknown): string | number | undefined {
  if (typeof error === "object" && error && "status" in error) {
    const status = (error as { readonly status?: unknown }).status;
    if (typeof status === "number" || typeof status === "string") return status;
  }
  if (typeof error === "object" && error && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "number" || typeof code === "string") return code;
  }
  return undefined;
}

function commandErrorSignal(error: unknown): string | undefined {
  if (typeof error === "object" && error && "signal" in error) {
    const signal = (error as { readonly signal?: unknown }).signal;
    if (typeof signal === "string" && signal.length > 0) return signal;
  }
  return undefined;
}

export function localGitText(repoRoot: string, ...args: readonly string[]): string {
  return runGit(repoRoot, ...args);
}
function gitInvocation(
  repoRoot: string,
  args: readonly string[],
): { readonly command: string; readonly args: readonly string[] } {
  if (process.platform !== "win32") return { command: "git", args: ["-C", repoRoot, ...args] };
  return cmdShellInvocation("git", ["-C", repoRoot, ...args], process.env);
}
function localGitBytes(repoRoot: string, args: readonly string[], input?: Uint8Array | number): Buffer {
  localGitProcesses += 1;
  const invocation = gitInvocation(repoRoot, args);
  try {
    return (
      /* @gate-identity check-sync-subprocess/sync-subprocess-016 */
      execFileSync(invocation.command, invocation.args, {
        ...(typeof input === "number" ? {} : { input }),
        encoding: "buffer",
        maxBuffer: gitMaxBuffer,
        stdio: [typeof input === "number" ? input : input ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
      })
    );
  } catch (error) {
    throw new VcsCommandError({
      command: args[0] ?? "command",
      cwd: repoRoot,
      exitCode: commandErrorCode(error),
      signal: commandErrorSignal(error),
      stderrSummary: commandErrorSummary(error),
    });
  }
}
// Synchronous git input always travels through a regular-file descriptor: a socketpair stdin
// wedges intermittently on macOS worker threads (task_fc929174), whatever the payload size.
// This spool is process scratch for one git invocation — never ledger content — so it belongs in
// the OS temporary directory. Putting it under a repository root would make the git read path
// resolve the layout (and read harness.yaml) on every batch, and would leave a default `.harness`
// behind in a repository that renamed its local root. One uniquely named file keeps the lifetime to
// a single governed remove.
function withStdinFile<T>(
  _repoRoot: string,
  prefix: string,
  chunks: Iterable<string | Uint8Array>,
  run: (descriptor: number) => T,
): T {
  const temporaryPath = path.join(tmpdir(), `${prefix}${process.pid}-${randomUUID()}`);
  try {
    localRuntimeStateFileSystem.writeExclusiveStream(temporaryPath, chunks);
    return localRuntimeStateFileSystem.withReadDescriptor(temporaryPath, run);
  } finally {
    localRuntimeStateFileSystem.remove(temporaryPath);
  }
}
function treeTargetIsScoped(target: string, scopes: ReadonlySet<string>): boolean {
  if (scopes.has(target)) return true;
  let separator = target.lastIndexOf("/");
  while (separator >= 0) {
    if (scopes.has(target.slice(0, separator))) return true;
    separator = target.lastIndexOf("/", separator - 1);
  }
  return false;
}
export const localGitObjectRefStore = Object.freeze({
  processCount: () => localGitProcesses,
  commitTimestamp: (repoRoot: string, commit: string): string | null => {
    const output = localGitBytes(repoRoot, ["cat-file", "commit", commit]).toString("utf8"),
      seconds = /^committer .+ ([0-9]+) [+-][0-9]{4}$/mu.exec(output)?.[1];
    if (seconds === undefined) return null;
    const timestamp = new Date(Number(seconds) * 1_000);
    return Number.isNaN(timestamp.valueOf()) ? null : timestamp.toISOString();
  },
  resolveCommit: (repoRoot: string, revision: string) => runGit(repoRoot, "rev-parse", revision).trim(),
  // A directory that is not a Git work tree, or one without any commit yet, has no baseline to branch from.
  headCommit: (repoRoot: string): string | null => {
    try {
      return runGit(repoRoot, "rev-parse", "--verify", "--quiet", "HEAD^{commit}").trim() || null;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  },
  // `rev-parse` echoes a well-formed sha whether or not the object exists; this asks the object store.
  hasCommit: (repoRoot: string, sha: string): boolean => {
    try {
      runGit(repoRoot, "cat-file", "-e", `${sha}^{commit}`);
      return true;
    } catch (error) {
      consumeKnownError(error);
      return false;
    }
  },
  currentBranch: (repoRoot: string): string | null => {
    try {
      const dotGit = path.join(repoRoot, ".git"),
        gitDir = statSync(dotGit).isDirectory()
          ? dotGit
          : path.resolve(repoRoot, /^gitdir: (.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1] ?? ""),
        ref = /^ref: refs\/heads\/(.+)$/mu.exec(readFileSync(path.join(gitDir, "HEAD"), "utf8"))?.[1];
      return ref ?? null;
    } catch (error) {
      consumeKnownError(error);
      return null;
    }
  },
  readPath: (repoRoot: string, commit: string, target: string): Buffer | null => {
    try {
      return localGitBytes(repoRoot, ["show", `${commit}:${target}`]);
    } catch (error) {
      try {
        if (localGitBytes(repoRoot, ["ls-tree", "--name-only", "-z", commit, "--", target]).length === 0) return null;
      } catch (classificationError) {
        consumeKnownError(classificationError);
      }
      throw error;
    }
  },
  isAncestor: (repoRoot: string, ancestor: string, current: string): boolean => {
    try {
      runGit(repoRoot, "merge-base", "--is-ancestor", ancestor, current);
      return true;
    } catch (error) {
      consumeKnownError(error);
      return false;
    }
  },
  pathsMatch: (repoRoot: string, left: string, right: string, targets: readonly string[]): boolean => {
    let batch: string[] = [],
      bytes = 0;
    const compare = (): boolean => {
      if (batch.length === 0) return true;
      try {
        runGit(
          repoRoot,
          "--literal-pathspecs",
          "diff",
          "--quiet",
          "--no-ext-diff",
          "--no-renames",
          left,
          right,
          "--",
          ...batch,
        );
        return true;
      } catch (error) {
        if (error instanceof VcsCommandError && error.exitCode === 1) return false;
        throw error;
      }
    };
    for (const target of targets) {
      const size = Buffer.byteLength(target) + 1;
      if (batch.length > 0 && bytes + size > gitTreeArgumentBytes) {
        if (!compare()) return false;
        batch = [];
        bytes = 0;
      }
      batch.push(target);
      bytes += size;
    }
    return compare();
  },
  readPaths: (
    repoRoot: string,
    commit: string,
    entries: readonly { readonly target: string; readonly size: number; readonly oid: string }[],
  ): ReadonlyMap<string, Buffer> => {
    // One `cat-file --batch` per bounded chunk instead of one `git show` per path: the
    // canonical ledger holds ~10^5 event and content blobs, and per-path processes turned
    // a stopped-generation read into hours. Each blob is addressed by the id the caller's
    // `ls-tree` of this same commit returned: `<commit>:<path>` makes git walk every tree
    // on the path and scan it entry by entry, so a directory of N files costs O(N) per
    // lookup and a whole-closure read turns quadratic.
    const bytesByTarget = new Map<string, Buffer>();
    let chunk: { readonly target: string; readonly size: number; readonly oid: string }[] = [],
      chunkBytes = 0;
    const flush = () => {
      if (chunk.length === 0) return;
      const output = withStdinFile(
        repoRoot,
        ".ha-cat-file-batch-",
        [chunk.map(({ oid }) => `${oid}\n`).join("")],
        (inputFd) => localGitBytes(repoRoot, ["cat-file", "--batch"], inputFd),
      );
      let offset = 0;
      for (const { target, oid } of chunk) {
        const newline = output.indexOf(0x0a, offset);
        if (newline < 0) throw new Error(`Git cat-file --batch output ended before ${target}`);
        const header = output.subarray(offset, newline).toString("utf8"),
          size = header.startsWith(`${oid} blob `) ? /^[0-9a-f]{40} blob ([0-9]+)$/u.exec(header)?.[1] : undefined;
        if (size === undefined) throw new Error(`Git cat-file --batch could not read ${commit}:${target}: ${header}`);
        const start = newline + 1,
          end = start + Number(size);
        bytesByTarget.set(target, Buffer.from(output.subarray(start, end)));
        offset = end + 1;
      }
      chunk = [];
      chunkBytes = 0;
    };
    for (const entry of entries) {
      if (chunk.length > 0 && (chunkBytes + entry.size > gitBatchChunkBytes || chunk.length >= gitBatchChunkEntries))
        flush();
      chunk.push(entry);
      chunkBytes += entry.size;
    }
    flush();
    return bytesByTarget;
  },
  /**
   * The blobs a commit holds at or below the named scopes. One recursive tree read preserves
   * exact modes for both files and directory prefixes without a process per target.
   * An empty scope list asks for nothing and spawns no process.
   */
  listTree: (
    repoRoot: string,
    commit: string,
    targets: readonly string[],
  ): readonly {
    readonly mode: "100644" | "120000";
    readonly oid: string;
    readonly size: number;
    readonly target: string;
  }[] => {
    const scopes = new Set(targets);
    if (scopes.size === 0) return [];
    // Read only the containing directories. Shared parents keep large target sets small;
    // the exact scope filter below preserves file/prefix semantics, including missing paths.
    const parents = new Set(
        [...scopes].map((target) => {
          const slash = target.lastIndexOf("/");
          return slash < 0 ? target : target.slice(0, slash);
        }),
      ),
      traversal = [...parents].filter((target) => {
        for (let slash = target.lastIndexOf("/"); slash >= 0; slash = target.lastIndexOf("/", slash - 1))
          if (parents.has(target.slice(0, slash))) return false;
        return true;
      }),
      entries: { mode: "100644" | "120000"; oid: string; size: number; target: string }[] = [];
    // ls-tree has no stdin path list. Bound argv bytes rather than imposing a target-count cap:
    // each authored path is valid on its own, but a publication may contain thousands of them.
    let batch: string[] = [],
      bytes = 0;
    const flush = () => {
      if (batch.length === 0) return;
      const output = localGitBytes(repoRoot, ["ls-tree", "-r", "-l", "-z", commit, "--", ...batch]);
      let offset = 0;
      while (offset < output.length) {
        const end = output.indexOf(0, offset);
        if (end < 0) throw new Error("Git ls-tree output is not NUL terminated");
        const record = output.subarray(offset, end).toString("utf8"),
          tab = record.indexOf("\t"),
          header = tab < 0 ? "" : record.slice(0, tab),
          target = tab < 0 ? "" : record.slice(tab + 1),
          [mode, type, oid, size] = header.trim().split(/\s+/u);
        if (
          treeTargetIsScoped(target, scopes) &&
          (mode === "100644" || mode === "120000") &&
          type === "blob" &&
          /^[0-9a-f]{40}$/u.test(oid ?? "") &&
          /^\d+$/u.test(size ?? "")
        )
          entries.push({ mode, oid: oid!, size: Number(size), target });
        offset = end + 1;
      }
      batch = [];
      bytes = 0;
    };
    for (const target of traversal) {
      const size = Buffer.byteLength(target) + 1;
      if (bytes + size > gitTreeArgumentBytes) flush();
      batch.push(target);
      bytes += size;
    }
    flush();
    return entries;
  },
  importCommit: (repoRoot: string, input: Iterable<string | Uint8Array>) =>
    withStdinFile(repoRoot, ".ha-fast-import-", input, (inputFd) =>
      localGitBytes(
        repoRoot,
        ["-c", "core.fsync=committed,reference", "-c", "core.fsyncMethod=fsync", "fast-import", "--quiet", "--force"],
        inputFd,
      ),
    ),
  listRefs: (repoRoot: string, refs: readonly string[]) =>
    runGit(repoRoot, "for-each-ref", "--format=%(refname) %(objectname)", ...refs),
  updateRef: (repoRoot: string, ref: string, sha: string, previous?: string) => {
    runGit(
      repoRoot,
      "-c",
      "core.fsync=reference",
      "-c",
      "core.fsyncMethod=fsync",
      "update-ref",
      ref,
      sha,
      ...(previous ? [previous] : []),
    );
  },
  updateRefs: (repoRoot: string, input: string) => {
    localGitBytes(
      repoRoot,
      ["-c", "core.fsync=reference", "-c", "core.fsyncMethod=fsync", "update-ref", "--stdin"],
      Buffer.from(input),
    );
  },
  deleteRef: (repoRoot: string, ref: string) => {
    runGit(repoRoot, "update-ref", "-d", ref);
  },
});
export const localGitWorktreeSettlement = Object.freeze({
  readNode,
  indexedPaths: (repoRoot: string, scopes: readonly string[]): readonly string[] =>
    scopes.length === 0
      ? []
      : localGitBytes(repoRoot, ["ls-files", "-z", "--", ...scopes])
          .toString("utf8")
          .split("\0")
          .filter(Boolean),
  changesFingerprint: (repoRoot: string, scope: string, ignored: ReadonlySet<string> = new Set()): string | null => {
    // --no-optional-locks keeps this read from opportunistically rewriting the index: a write
    // here could overwrite the settlement worker's update-index with the older snapshot this
    // read started from (F-B9DAA193).
    const entries = runGit(
      repoRoot,
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
      "--",
      scope,
    )
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const target = entry.slice(3);
        if (ignored.has(target) || /(?:^|\/)\.ha-(?:visible|settle)-/u.test(target)) return null;
        const absolute = path.join(repoRoot, ...target.split("/"));
        try {
          const stat = statSync(absolute);
          return `${entry}:${stat.size}:${stat.mtimeMs}:${stat.mode}`;
        } catch {
          return `${entry}:missing`;
        }
      })
      .filter((entry): entry is string => entry !== null)
      .sort();
    return entries.length === 0 ? null : entries.join("\0");
  },
  hasChanges: (repoRoot: string, scope: string, ignored: ReadonlySet<string> = new Set()): boolean =>
    localGitWorktreeSettlement.changesFingerprint(repoRoot, scope, ignored) !== null,
  isDirectory: (target: string): boolean => {
    try {
      return lstatSync(target).isDirectory();
    } catch (error) {
      consumeKnownError(error);
      return false;
    }
  },
  visible: (
    repoRoot: string,
    files: readonly (
      | {
          readonly target: string;
          readonly body: string | Uint8Array;
          readonly mode?: "100644" | "120000";
        }
      | { readonly directory: string }
    )[],
    hooks: {
      readonly beforeRename?: () => void;
      readonly afterRename?: () => void;
      readonly withFence?: WriteFence;
    } = {},
  ): void => {
    // A directory an entity owns but puts no file in has nothing to rename into place: creating it is the
    // whole operation. It travels through this same writer so materialization stays one path.
    const pending = files.flatMap((file, index) => {
      const directory =
        "directory" in file
          ? path.join(repoRoot, ...file.directory.split("/"))
          : path.dirname(path.join(repoRoot, ...file.target.split("/")));
      const create = () => {
        /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
        mkdirSync(directory, { recursive: true });
      };
      if ("directory" in file && hooks.withFence) hooks.withFence(create);
      else create();
      sweepStaleSettlementMarkers(directory);
      if ("directory" in file) return [];
      const target = path.join(repoRoot, ...file.target.split("/"));
      const temporary = path.join(directory, `.ha-visible-${process.pid}-${index}`);
      removeNode(temporary);
      if (file.mode === "120000")
        /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
        symlinkSync(linkTarget(file.body), temporary);
      else
        /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
        writeFileSync(temporary, file.body, { mode: 0o644 });
      return [{ target, temporary }];
    });
    try {
      for (const item of pending) {
        hooks.beforeRename?.();
        const publish = () => {
          /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
          renameSync(item.temporary, item.target);
        };
        if (hooks.withFence) hooks.withFence(publish);
        else publish();
        hooks.afterRename?.();
      }
    } finally {
      for (const item of pending) removeNode(item.temporary);
    }
  },
  /**
   * Retiring a directory an entity owned. It is the mirror of the `{ directory }` creation above and travels
   * through the same writer, so materialization stays one path. The caller names the paths, and may only name
   * ones an accepted event says the owner held; this function never discovers a path for itself. Removal is
   * never recursive: `rmdir` refuses a directory that still holds anything, which is exactly the rule that keeps
   * a file or directory the user added from being taken away with the entity's own empty ones. Deepest paths
   * must be presented first, so a parent is only attempted once its retired children are gone. The preserved
   * paths are returned rather than thrown on, because "someone put something here" is an answer, not a
   * settlement failure.
   */
  retireEmptyDirectories: (
    repoRoot: string,
    logicalPaths: readonly string[],
    withFence?: WriteFence,
  ): readonly string[] => {
    const preserved: string[] = [];
    for (const logical of logicalPaths) {
      const target = path.join(repoRoot, ...logical.split("/"));
      const retireEmptyDirectory = () => {
        try {
          removeEmptyDirectory(target);
        } catch (error) {
          consumeKnownError(error);
          if (existsSync(target)) preserved.push(logical);
        }
      };
      if (withFence) withFence(retireEmptyDirectory);
      else retireEmptyDirectory();
    }
    return preserved;
  },
  deleteVisible: (
    repoRoot: string,
    targets: readonly string[],
    hooks: {
      readonly beforeRename?: () => void;
      readonly afterRename?: () => void;
      readonly withFence?: WriteFence;
    } = {},
  ): void => {
    for (const logical of targets) {
      hooks.beforeRename?.();
      const remove = () => removeNode(path.join(repoRoot, ...logical.split("/")));
      if (hooks.withFence) hooks.withFence(remove);
      else remove();
      hooks.afterRename?.();
    }
  },
  index: (
    repoRoot: string,
    files: readonly (
      | {
          readonly target: string;
          readonly body: string | Uint8Array;
          readonly mode?: "100644" | "120000";
        }
      | { readonly delete: string }
    )[],
    skipWorktree = false,
    withFence?: WriteFence,
  ): number => {
    if (files.length === 0) return 0;
    const zero = "0".repeat(40),
      indexInput = files
        .map((file) =>
          "delete" in file
            ? `0 ${zero}\t${file.delete}\0`
            : `${file.mode ?? "100644"} ${gitBlobOidBytes(asBytes(file.body))}\t${file.target}\0`,
        )
        .join("");
    // The synchronous Git port joins the index write before releasing ownership. A timed
    // worker wait could release the fence while its update-index child was still running.
    const publish = () => {
      localGitBytes(repoRoot, ["update-index", "-z", "--index-info"], Buffer.from(indexInput));
      if (skipWorktree)
        localGitBytes(
          repoRoot,
          ["update-index", "--skip-worktree", "-z", "--stdin"],
          Buffer.from(files.map((file) => `${"delete" in file ? file.delete : file.target}\0`).join("")),
        );
    };
    if (withFence) withFence(publish);
    else publish();
    return 1;
  },
  preserveConflict: (layout: HarnessLayout, target: string, logical: string, commit: string): string =>
    preserveConflict(layout, target, logical, commit, true),
  preserveVisibleConflict: (layout: HarnessLayout, target: string, logical: string, cutIdentity: string): string =>
    preserveConflict(layout, target, logical, cutIdentity, false),
  docSyncConflicts: (layout: HarnessLayout): readonly DocSyncConflictRecord[] => docSyncConflicts(layout),
  docSyncConflict: (rootDir: string, conflictId: string): DocSyncConflictRecord | null =>
    docSyncConflict(rootDir, conflictId),
  settleDocSyncConflict: (rootDir: string, conflictId: string): void => settleDocSyncConflict(rootDir, conflictId),
});
export interface DocSyncConflictRecord {
  readonly schema: "doc-sync-conflict/v1";
  readonly conflictId: string;
  readonly logicalPath: string;
  readonly sourceWorkspaceId: string;
  readonly baseIdentity: string;
  readonly operation: "durable-preservation" | "visible-preservation";
  readonly mode: "100644" | "120000";
  readonly contentSha256: string;
  readonly localPath: string;
}
function preserveConflict(
  layout: HarnessLayout,
  target: string,
  logical: string,
  identity: string,
  durable: boolean,
): string {
  const node = readNode(target);
  if (!node) throw new Error(`conflicting worktree node disappeared at ${logical}`);
  const logicalPath = path.relative(layout.authoredRoot, target).split(path.sep).join("/"),
    sourceWorkspaceId = hashVcsBytes("sha256", layout.rootDir),
    operation = durable ? ("durable-preservation" as const) : ("visible-preservation" as const),
    conflictId = `doc-${hashVcsBytes(
      "sha256",
      `${logicalPath}\0${sourceWorkspaceId}\0${identity}\0${operation}\0${node.mode}\0${node.sha256}`,
    )}`,
    directory = path.join(layout.localRoot, "conflicts", "doc-sync", conflictId),
    local = path.join(directory, "local"),
    localPath = path.relative(layout.rootDir, local).split(path.sep).join("/"),
    record: DocSyncConflictRecord = {
      schema: "doc-sync-conflict/v1",
      conflictId,
      logicalPath,
      sourceWorkspaceId,
      baseIdentity: identity,
      operation,
      mode: node.mode,
      contentSha256: node.sha256,
      localPath,
    };
  if (!existsSync(local)) writeFileDurably(local, node.bytes, 0o600);
  const manifest = path.join(directory, "manifest.json"),
    body = Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8");
  if (!existsSync(manifest)) writeFileDurably(manifest, body, 0o600);
  return localPath;
}
function docSyncConflicts(layout: HarnessLayout): readonly DocSyncConflictRecord[] {
  const root = path.join(layout.localRoot, "conflicts", "doc-sync");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^doc-[0-9a-f]{64}$/u.test(entry.name))
    .map((entry) => docSyncConflict(layout, entry.name))
    .filter((record): record is DocSyncConflictRecord => record !== null)
    .sort((left, right) => left.conflictId.localeCompare(right.conflictId));
}
function docSyncConflict(root: string | HarnessLayout, conflictId: string): DocSyncConflictRecord | null {
  if (!/^doc-[0-9a-f]{64}$/u.test(conflictId)) return null;
  const layout = typeof root === "string" ? resolveHarnessLayout(root) : root,
    directory = path.join(layout.localRoot, "conflicts", "doc-sync", conflictId),
    manifest = path.join(directory, "manifest.json");
  if (!existsSync(manifest)) return null;
  const record = JSON.parse(readFileSync(manifest, "utf8")) as DocSyncConflictRecord,
    logicalPath = normalizeRelativeDocumentPath(record.logicalPath),
    local = path.join(directory, "local"),
    localNode = readNode(local),
    localPath = path.relative(layout.rootDir, local).split(path.sep).join("/");
  if (
    record.schema !== "doc-sync-conflict/v1" ||
    record.conflictId !== conflictId ||
    record.logicalPath !== logicalPath ||
    record.localPath !== localPath ||
    localNode === null ||
    localNode.sha256 !== record.contentSha256
  )
    throw new Error(`invalid doc-sync conflict record: ${conflictId}`);
  return record;
}
function settleDocSyncConflict(rootDir: string, conflictId: string): void {
  const layout = resolveHarnessLayout(rootDir),
    directory = path.join(layout.localRoot, "conflicts", "doc-sync", conflictId);
  removeNode(path.join(directory, "local"));
  removeNode(path.join(directory, "manifest.json"));
  removeEmptyDirectory(directory);
}
function readNode(target: string): {
  readonly mode: "100644" | "120000";
  readonly body: string;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly size: number;
} | null {
  try {
    const info = lstatSync(target),
      mode = info.isSymbolicLink() ? ("120000" as const) : info.isFile() ? ("100644" as const) : null;
    if (mode === null) return null;
    const bytes = mode === "120000" ? readlinkSync(target, { encoding: "buffer" }) : readFileSync(target);
    return {
      mode,
      get body() {
        return bytes.toString("utf8");
      },
      bytes,
      sha256: hashVcsBytes("sha256", bytes),
      size: bytes.byteLength,
    };
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
function removeNode(target: string): void {
  try {
    /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
    unlinkSync(target);
  } catch (error) {
    consumeKnownError(error);
  }
}
function removeEmptyDirectory(target: string): void {
  /* @gate-identity state-store/task.source.storage.src.store.local-version-control-system.filesystem-store */
  rmdirSync(target);
}
// Settlement markers sit beside their target because rename(2) is only atomic
// within one filesystem, and "same directory" is the one placement that
// guarantees it. The cost is that a process killed between the durable write
// and the rename leaves `.ha-settle-<pid>-<index>` (or `.ha-visible-...`)
// behind forever; F-B16F8586 counted 1225 of them after two `daemon stop
// --force`. The first time this process settles into a directory it removes
// every marker whose owner pid no longer exists. Sweeping once per process
// bounds the readdir cost to the directories a process ever touches, and the
// failure that produces leftovers (a killed writer) is followed by a new
// process anyway. Its own pid is never touched: an in-flight marker of this
// process is only ever reclaimed by the same-index removeNode above.
const settlementMarkerPattern = /^\.ha-(?:settle|visible)-([1-9][0-9]*)-[0-9]+$/u,
  sweptMarkerDirectories = new Set<string>();
function sweepStaleSettlementMarkers(directory: string): void {
  if (sweptMarkerDirectories.has(directory)) return;
  sweptMarkerDirectories.add(directory);
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    consumeKnownError(error);
    return;
  }
  for (const name of names) {
    const pid = Number(settlementMarkerPattern.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === process.pid || processMayBeAlive(pid)) continue;
    removeNode(path.join(directory, name));
  }
}
/**
 * Only ESRCH proves the owner is gone; EPERM or any other probe failure keeps the
 * marker (fail-safe toward not deleting).
 */
function processMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    consumeKnownError(error);
    return true;
  }
}
function asBytes(body: string | Uint8Array): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.isBuffer(body) ? body : Buffer.from(body);
}
function linkTarget(body: string | Uint8Array): string {
  return typeof body === "string" ? body : asBytes(body).toString("utf8");
}
function gitBlobOidBytes(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}
function hashVcsBytes(algorithm: "sha256", body: string | Uint8Array): string {
  return createHash(algorithm).update(body).digest("hex");
}

function commandErrorSummary(error: unknown): string | undefined {
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text
      .trim()
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
let localGitProcesses = 0;
export function localGitProcessCount(): number {
  return localGitProcesses;
}
