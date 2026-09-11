import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-014 */
  execFileSync,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import { open as openAsync } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { consumeKnownError } from "../error-consumption.ts";
import { localRuntimeStateFileSystem } from "../local/local-layout-file-system.ts";
import type { VcsCommitAuthor, VersionControlSystem } from "../ports/version-control-system.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";
import { makeLocalVersionControlCommands } from "./local-version-control-commands.ts";

const gitMaxBuffer = 256 * 1024 * 1024,
  gitBatchChunkBytes = 64 * 1024 * 1024,
  gitBatchChunkEntries = 4_096,
  // Windows CreateProcess limits the quoted command line to 32,767 UTF-16 characters, but
  // cmd.exe /d /s /c limits the command line to 8,191 characters.
  // Leave room for quoting, repo path, and Git's fixed arguments; 4 KiB safely fits.
  gitPathspecChunkBytes = (process.platform === "win32" ? 4 : 128) * 1024;

export function makeLocalVersionControlSystem(): VersionControlSystem {
  return makeLocalVersionControlCommands({
    normalizePath: normalizeLocalPath,
    topLevel: gitTopLevel,
    execute: runGit,
    executeAs: runGitAs,
  });
}

const geometricMaintenanceFloor = Object.freeze([2, 52, 0]);
export interface LedgerMaintenanceReceipt {
  readonly gitVersion: string | null;
  readonly strategy: "geometric" | null;
  readonly applied: readonly string[];
  readonly degraded: string | null;
}
/** Pins ledger maintenance and incremental-index policy out of the user-global config. */
export function configureLedgerMaintenance(repoRoot: string): LedgerMaintenanceReceipt {
  const version = readGitVersion(repoRoot),
    applied: string[] = [];
  const pin = (key: string, value: string): void => {
    if (readGitConfig(repoRoot, key) === value) return;
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
  const geometric = version !== null && atLeastGitVersion(version.parts, geometricMaintenanceFloor);
  if (geometric) pin("maintenance.strategy", "geometric");
  return {
    gitVersion: version?.text ?? null,
    strategy: geometric ? "geometric" : null,
    applied,
    degraded: geometric
      ? null
      : `git ${version?.text ?? "(version unreadable)"} predates the 2.52.0 geometric maintenance strategy; this ledger keeps Git's default repack cadence.`,
  };
}
function readGitVersion(repoRoot: string): { readonly text: string; readonly parts: readonly number[] } | null {
  const raw = readGitText(repoRoot, ["version"]);
  if (raw === null) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw);
  if (!match) return null;
  return { text: match[0], parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] };
}
function readGitConfig(repoRoot: string, key: string): string | null {
  return readGitText(repoRoot, ["config", "--get", key]);
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
  const command = ["git", "-C", repoRoot, ...args].map(quoteWindowsCommandArgument).join(" ");
  return { command: process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", command] };
}
function quoteWindowsCommandArgument(value: string): string {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
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
function withStdinFile<T>(
  repoRoot: string,
  prefix: string,
  chunks: Iterable<string | Uint8Array>,
  run: (descriptor: number) => T,
): T {
  const temporaryRoot = path.join(repoRoot, ".harness"),
    temporaryPath = path.join(temporaryRoot, `${prefix}${process.pid}-${randomUUID()}`);
  localRuntimeStateFileSystem.mkdirp(temporaryRoot);
  try {
    localRuntimeStateFileSystem.writeExclusiveStream(temporaryPath, chunks);
    return localRuntimeStateFileSystem.withReadDescriptor(temporaryPath, run);
  } finally {
    localRuntimeStateFileSystem.remove(temporaryPath);
  }
}
/**
 * Pathspec batches that stay inside the platform argument limit. One batch is the common case;
 * a caller naming more paths than one command line holds pays one extra process per batch
 * instead of one full-tree listing.
 */
function pathspecChunks(targets: readonly string[]): readonly (readonly string[])[] {
  if (targets.length === 0) return [];
  const chunks: string[][] = [];
  let chunk: string[] = [],
    chunkBytes = 0;
  for (const target of targets) {
    const size = Buffer.byteLength(target, "utf8") + 1;
    if (chunk.length > 0 && (chunkBytes + size > gitPathspecChunkBytes || chunk.length >= gitBatchChunkEntries)) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
    chunk.push(target);
    chunkBytes += size;
  }
  chunks.push(chunk);
  return chunks;
}
export const localGitObjectRefStore = Object.freeze({
  processCount: () => localGitProcesses,
  addWorktree: (repoRoot: string, cwd: string, branch: string, baseRef: string): void => {
    runGit(repoRoot, "worktree", "add", cwd, "-b", branch, baseRef);
  },
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
   * The blobs a commit holds under the named pathspecs. `targets` is required because an
   * unscoped `ls-tree -r` costs one full tree listing per call: a publication that names three
   * paths in a repository holding 10^4 of them paid for all 10^4 on every accepted write.
   * An empty target list asks for nothing and spawns no process.
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
    const scoped = [...new Set(targets)],
      entries: { mode: "100644" | "120000"; oid: string; size: number; target: string }[] = [];
    for (const chunk of pathspecChunks(scoped)) {
      const output = localGitBytes(repoRoot, [
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "-l",
        "-z",
        commit,
        "--",
        ...chunk,
      ]);
      for (const record of output.toString("utf8").split("\0")) {
        if (!record) continue;
        const tab = record.indexOf("\t"),
          header = tab < 0 ? "" : record.slice(0, tab),
          logical = tab < 0 ? "" : record.slice(tab + 1);
        const [mode, type, oid, size] = header.trim().split(/\s+/u);
        if (
          (mode === "100644" || mode === "120000") &&
          type === "blob" &&
          /^[0-9a-f]{40}$/u.test(oid ?? "") &&
          /^[0-9]+$/u.test(size ?? "") &&
          logical
        )
          entries.push({ mode, oid: oid!, size: Number(size), target: logical });
      }
    }
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
    const entries = runGit(repoRoot, "status", "--porcelain=v1", "--untracked-files=all", "-z", "--", scope)
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
    } = {},
  ): void => {
    // A directory an entity owns but puts no file in has nothing to rename into place: creating it is the
    // whole operation. It travels through this same writer so materialization stays one path.
    const pending = files.flatMap((file, index) => {
      const directory =
        "directory" in file
          ? path.join(repoRoot, ...file.directory.split("/"))
          : path.dirname(path.join(repoRoot, ...file.target.split("/")));
      /* @gate-identity check-bypass-write-boundary/bypass-write-076 */
      mkdirSync(directory, { recursive: true });
      sweepStaleSettlementMarkers(directory);
      if ("directory" in file) return [];
      const target = path.join(repoRoot, ...file.target.split("/"));
      const temporary = path.join(directory, `.ha-visible-${process.pid}-${index}`);
      removeNode(temporary);
      if (file.mode === "120000")
        /* @gate-identity check-bypass-write-boundary/bypass-write-077 */
        symlinkSync(linkTarget(file.body), temporary);
      else
        /* @gate-identity check-bypass-write-boundary/bypass-write-084 */
        writeFileSync(temporary, file.body, { mode: 0o644 });
      return [{ target, temporary }];
    });
    for (const item of pending) {
      hooks.beforeRename?.();
      /* @gate-identity check-bypass-write-boundary/bypass-write-082 */
      renameSync(item.temporary, item.target);
      hooks.afterRename?.();
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
  retireEmptyDirectories: (repoRoot: string, logicalPaths: readonly string[]): readonly string[] => {
    const preserved: string[] = [];
    for (const logical of logicalPaths) {
      const target = path.join(repoRoot, ...logical.split("/"));
      try {
        /* @gate-identity check-bypass-write-boundary/bypass-write-134 */
        rmdirSync(target);
      } catch (error) {
        consumeKnownError(error);
        if (existsSync(target)) preserved.push(logical);
      }
    }
    return preserved;
  },
  deleteVisible: (
    repoRoot: string,
    targets: readonly string[],
    hooks: {
      readonly beforeRename?: () => void;
      readonly afterRename?: () => void;
    } = {},
  ): void => {
    for (const logical of targets) {
      hooks.beforeRename?.();
      removeNode(path.join(repoRoot, ...logical.split("/")));
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
    localGitProcesses += 1;
    awaitDurableSettlement(
      beginDurableSettlement({
        index: {
          repoRoot,
          input: indexInput,
          skipWorktreeInput: skipWorktree
            ? files.map((file) => `${"delete" in file ? file.delete : file.target}\0`).join("")
            : undefined,
        },
      }),
    );
    return 1;
  },
  preserveConflict: (repoRoot: string, target: string, logical: string, commit: string): string =>
    preserveConflict(repoRoot, target, logical, commit, true),
  preserveVisibleConflict: (repoRoot: string, target: string, logical: string, cutIdentity: string): string =>
    preserveConflict(repoRoot, target, logical, cutIdentity, false),
});
function preserveConflict(
  repoRoot: string,
  target: string,
  logical: string,
  identity: string,
  durable: boolean,
): string {
  const node = readNode(target);
  if (!node) throw new Error(`conflicting worktree node disappeared at ${logical}`);
  const extension = path.extname(target),
    stem = target.slice(0, target.length - extension.length),
    id = hashVcsBytes("sha256", `${logical}\0${identity}\0${node.mode}\0${node.sha256}`).slice(0, 8),
    scratch = `${stem}.conflict-${id}${extension}`,
    relative = path.relative(repoRoot, scratch).split(path.sep).join("/");
  ensureConflictExclude(repoRoot);
  if (!readNode(scratch)) {
    if (node.mode === "120000")
      /* @gate-identity check-bypass-write-boundary/bypass-write-078 */
      symlinkSync(node.body, scratch);
    else if (durable) durableWrite(scratch, node.bytes);
    else
      /* @gate-identity check-bypass-write-boundary/bypass-write-089 */
      writeFileSync(scratch, node.bytes, { mode: 0o600 });
  }
  return relative;
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
      body: bytes.toString("utf8"),
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
    /* @gate-identity check-bypass-write-boundary/bypass-write-081 */
    unlinkSync(target);
  } catch (error) {
    consumeKnownError(error);
  }
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
function ensureConflictExclude(repoRoot: string): void {
  const dotGit = path.join(repoRoot, ".git"),
    gitDir = statSync(dotGit).isDirectory()
      ? dotGit
      : path.resolve(repoRoot, /^gitdir: (.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1] ?? ""),
    target = path.join(gitDir, "info/exclude"),
    marker = "*.conflict-*\n";
  /* @gate-identity check-bypass-write-boundary/bypass-write-085 */
  mkdirSync(path.dirname(target), { recursive: true });
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (!current.split(/\r?\n/u).includes("*.conflict-*"))
    /* @gate-identity check-bypass-write-boundary/bypass-write-086 */
    writeFileSync(target, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${marker}`);
}
function durableWrite(target: string, body: Uint8Array): void {
  const directory = path.dirname(target),
    temporary = `${target}.tmp-${process.pid}`;
  /* @gate-identity check-bypass-write-boundary/bypass-write-087 */
  mkdirSync(directory, { recursive: true });
  const descriptor =
    /* @gate-identity check-bypass-write-boundary/bypass-write-088 */
    openSync(temporary, "w", 0o600);
  // `.tmp-<pid>` is the same shape as the settlement markers above and the sweep there does
  // not match it, by design: this temporary lands inside the repository worktree, where a
  // pid means nothing to whichever node the bytes reach next. The failing writer clears it.
  try {
    try {
      /* @gate-identity check-bypass-write-boundary/bypass-write-090 */
      writeFileSync(descriptor, body);
      /* @gate-identity check-bypass-write-boundary/bypass-write-091 */
      fsyncSync(descriptor);
    } finally {
      /* @gate-identity check-bypass-write-boundary/bypass-write-092 */
      closeSync(descriptor);
    }
    /* @gate-identity check-bypass-write-boundary/bypass-write-094 */
    renameSync(temporary, target);
  } catch (error) {
    removeNode(temporary);
    throw error;
  }
  if (process.platform === "win32") return;
  const parent =
    /* @gate-identity check-bypass-write-boundary/bypass-write-095 */
    openSync(directory, "r");
  try {
    /* @gate-identity check-bypass-write-boundary/bypass-write-096 */
    fsyncSync(parent);
  } finally {
    /* @gate-identity check-bypass-write-boundary/bypass-write-097 */
    closeSync(parent);
  }
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
const settlementWorkerKind = "harness-durable-settlement/v1";
let settlementWorker: Worker | null = null;
interface DurableSettlementInput {
  readonly files?: readonly { readonly temporary: string; readonly body: string | Uint8Array }[];
  readonly directories?: readonly string[];
  readonly index?: { readonly repoRoot: string; readonly input: string; readonly skipWorktreeInput?: string };
}
interface DurableSettlementWait {
  readonly state: Int32Array;
  readonly errorBytes: Uint8Array;
  readonly worker: Worker;
}
function beginDurableSettlement(input: DurableSettlementInput): DurableSettlementWait | null {
  if (!input.files?.length && !input.directories?.length && !input.index) return null;
  const state = new Int32Array(new SharedArrayBuffer(8)),
    errorBytes = new Uint8Array(new SharedArrayBuffer(4096)),
    worker = getSettlementWorker();
  worker.ref();
  worker.postMessage({ ...input, state, errorBytes });
  return { state, errorBytes, worker };
}
function awaitDurableSettlement(pending: DurableSettlementWait | null): void {
  if (!pending) return;
  const wait = Atomics.wait(pending.state, 0, 0, 30_000);
  pending.worker.unref();
  if (wait === "timed-out") throw new Error("durable settlement worker timed out");
  if (Atomics.load(pending.state, 0) !== 1)
    throw new Error(
      new TextDecoder().decode(pending.errorBytes.subarray(0, Atomics.load(pending.state, 1))) ||
        "durable settlement worker failed",
    );
}
function getSettlementWorker(): Worker {
  if (settlementWorker) return settlementWorker;
  const ready = new Int32Array(new SharedArrayBuffer(4)),
    worker = new Worker(new URL(import.meta.url), {
      execArgv: process.execArgv.filter(
        (argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps",
      ),
      workerData: { kind: settlementWorkerKind, ready },
    });
  worker.unref();
  if (Atomics.wait(ready, 0, 0, 5_000) === "timed-out") {
    void worker.terminate();
    throw new Error("durable settlement worker failed to start");
  }
  settlementWorker = worker;
  return worker;
}
if (!isMainThread && workerData?.kind === settlementWorkerKind) {
  const ready = workerData.ready as Int32Array;
  parentPort!.on(
    "message",
    async (
      request: DurableSettlementInput & {
        readonly state: Int32Array;
        readonly errorBytes: Uint8Array;
      },
    ) => {
      try {
        const durability = [
          ...(request.files ?? []).map((file) => async () => {
            const descriptor = await /* @gate-identity check-bypass-write-boundary/bypass-write-079 */
            openAsync(file.temporary, "w", 0o644);
            try {
              await descriptor.writeFile(file.body);
              await descriptor.sync();
            } finally {
              await descriptor.close();
            }
          }),
          ...(process.platform === "win32"
            ? []
            : (request.directories ?? []).map((directory) => async () => {
                const descriptor = await /* @gate-identity check-bypass-write-boundary/bypass-write-080 */
                openAsync(directory, "r");
                try {
                  await descriptor.sync();
                } finally {
                  await descriptor.close();
                }
              })),
        ];
        if (request.index) {
          const invocation = gitInvocation(request.index.repoRoot, ["update-index", "-z", "--index-info"]);
          /* @gate-identity check-sync-subprocess/sync-subprocess-017 */
          execFileSync(invocation.command, invocation.args, {
            input: Buffer.from(request.index.input),
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
          });
          if (request.index.skipWorktreeInput)
            localGitBytes(
              request.index.repoRoot,
              ["update-index", "--skip-worktree", "-z", "--stdin"],
              Buffer.from(request.index.skipWorktreeInput),
            );
        }
        // Bound descriptors and fsync pressure while retaining parallelism. The
        // request already contains only paths touched by this publication cut.
        for (let offset = 0; offset < durability.length; offset += 128)
          await Promise.all(durability.slice(offset, offset + 128).map((settle) => settle()));
        Atomics.store(request.state, 0, 1);
      } catch (error) {
        consumeKnownError(error);
        const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error)),
          length = Math.min(bytes.length, request.errorBytes.length);
        request.errorBytes.set(bytes.subarray(0, length));
        Atomics.store(request.state, 1, length);
        Atomics.store(request.state, 0, 2);
      } finally {
        Atomics.notify(request.state, 0);
      }
    },
  );
  Atomics.store(ready, 0, 1);
  Atomics.notify(ready, 0);
}
let localGitProcesses = 0;
export function localGitProcessCount(): number {
  return localGitProcesses;
}
