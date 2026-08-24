import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-014 */
  execFileSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openAsync } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { consumeKnownError } from "../error-consumption.ts";
import type { VcsCommitAuthor, VersionControlSystem } from "../ports/version-control-system.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";
import { makeLocalVersionControlCommands } from "./local-version-control-commands.ts";

const gitMaxBuffer = 256 * 1024 * 1024;

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
/** Pins the ledger repository's own maintenance policy so Git's automatic housekeeping stays out of the write path and repacks incrementally instead of rebuilding every pack from scratch, and pins `core.autocrlf=false` so committed blobs stay byte-identical to the documents written to disk (Git for Windows defaults `core.autocrlf=true` globally, which would rewrite CRLF documents to LF and break content-hash readback). Repository config outranks the user's global config, so a global `gc.autoDetach=false` cannot drag a repack into a ledger write. Idempotent: only differing keys are written. */
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
function localGitBytes(repoRoot: string, args: readonly string[], input?: Uint8Array): Buffer {
  localGitProcesses += 1;
  const invocation = gitInvocation(repoRoot, args);
  try {
    return (
      /* @gate-identity check-sync-subprocess/sync-subprocess-016 */
      execFileSync(invocation.command, invocation.args, {
        input,
        encoding: "buffer",
        maxBuffer: gitMaxBuffer,
        stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
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
export const localGitObjectRefStore = Object.freeze({
  processCount: () => localGitProcesses,
  blobOid: (body: string | Uint8Array) => gitBlobOidBytes(typeof body === "string" ? Buffer.from(body) : body),
  resolveCommit: (repoRoot: string, revision: string) => runGit(repoRoot, "rev-parse", revision).trim(),
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
  batch: (repoRoot: string, input: string) => localGitBytes(repoRoot, ["cat-file", "--batch"], Buffer.from(input)),
  listTree: (
    repoRoot: string,
    commit: string,
    target?: string,
  ): readonly { readonly mode: "100644" | "120000"; readonly oid: string; readonly target: string }[] => {
    const output = localGitBytes(repoRoot, ["ls-tree", "-r", "-z", commit, ...(target ? ["--", target] : [])]);
    return output
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .flatMap((record) => {
        const tab = record.indexOf("\t"),
          header = tab < 0 ? "" : record.slice(0, tab),
          logical = tab < 0 ? "" : record.slice(tab + 1);
        const [mode, type, oid] = header.split(" ");
        return (mode === "100644" || mode === "120000") &&
          type === "blob" &&
          /^[0-9a-f]{40}$/u.test(oid ?? "") &&
          logical
          ? [{ mode, oid: oid!, target: logical }]
          : [];
      });
  },
  importCommit: (repoRoot: string, input: string) =>
    localGitBytes(
      repoRoot,
      ["-c", "core.fsync=committed,reference", "-c", "core.fsyncMethod=fsync", "fast-import", "--quiet", "--force"],
      Buffer.from(input),
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
  visible: (
    repoRoot: string,
    files: readonly {
      readonly target: string;
      readonly body: string;
      readonly mode?: "100644" | "120000";
    }[],
    hooks: {
      readonly beforeRename?: () => void;
      readonly afterRename?: () => void;
    } = {},
  ): void => {
    const pending = files.map((file, index) => {
      const target = path.join(repoRoot, ...file.target.split("/"));
      const temporary = path.join(path.dirname(target), `.ha-visible-${process.pid}-${index}`);
      /* @gate-identity check-bypass-write-boundary/bypass-write-076 */
      mkdirSync(path.dirname(target), { recursive: true });
      removeNode(temporary);
      if (file.mode === "120000")
        /* @gate-identity check-bypass-write-boundary/bypass-write-077 */
        symlinkSync(file.body, temporary);
      else
        /* @gate-identity check-bypass-write-boundary/bypass-write-084 */
        writeFileSync(temporary, file.body, { encoding: "utf8", mode: 0o644 });
      return { target, temporary };
    });
    for (const item of pending) {
      hooks.beforeRename?.();
      /* @gate-identity check-bypass-write-boundary/bypass-write-082 */
      renameSync(item.temporary, item.target);
      hooks.afterRename?.();
    }
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
          readonly body: string;
          readonly mode?: "100644" | "120000";
        }
      | { readonly delete: string }
    )[],
  ): number => {
    if (files.length === 0) return 0;
    const zero = "0".repeat(40),
      indexInput = files
        .map((file) =>
          "delete" in file
            ? `0 ${zero}\t${file.delete}\0`
            : `${file.mode ?? "100644"} ${gitBlobOid(file.body)}\t${file.target}\0`,
        )
        .join("");
    localGitProcesses += 1;
    awaitDurableSettlement(beginDurableSettlement({ index: { repoRoot, input: indexInput } }));
    return 1;
  },
  settle: (
    repoRoot: string,
    files: readonly (
      | {
          readonly target: string;
          readonly body: string;
          readonly mode?: "100644" | "120000";
        }
      | { readonly from: string; readonly to: string }
      | { readonly delete: string }
    )[],
    hooks: {
      readonly whileFilesSync?: () => void;
      readonly beforeRename?: () => void;
      readonly afterRename?: () => void;
    } = {},
  ): number => {
    const directories = new Set<string>(),
      writes = files.filter(
        (
          file,
        ): file is {
          readonly target: string;
          readonly body: string;
          readonly mode?: "100644" | "120000";
        } => "target" in file,
      ),
      renames = files.filter((file): file is { readonly from: string; readonly to: string } => "from" in file),
      deletions = files
        .filter((file): file is { readonly delete: string } => "delete" in file)
        .map((file) => {
          const target = path.join(repoRoot, ...file.delete.split("/"));
          directories.add(path.dirname(target));
          return { target, logical: file.delete };
        }),
      pending = writes.map((file, index) => {
        const target = path.join(repoRoot, ...file.target.split("/")),
          directory = path.dirname(target),
          temporary = path.join(directory, `.ha-settle-${process.pid}-${index}`),
          mode = file.mode ?? "100644";
        directories.add(directory);
        removeNode(temporary);
        return {
          target,
          temporary,
          body: file.body,
          mode,
          logical: file.target,
        };
      }),
      pendingRenames = renames.map((file) => {
        const from = path.join(repoRoot, ...file.from.split("/")),
          to = path.join(repoRoot, ...file.to.split("/")),
          source = readNode(from),
          destination = readNode(to);
        if (source === null && destination === null)
          throw new Error(`settlement rename is missing both ${file.from} and ${file.to}`);
        if (source !== null && destination !== null)
          throw new Error(`settlement rename target already exists at ${file.to}`);
        directories.add(path.dirname(from));
        directories.add(path.dirname(to));
        return {
          from,
          to,
          fromLogical: file.from,
          toLogical: file.to,
          node: source ?? destination!,
          pending: source !== null,
        };
      });
    for (const directory of directories) {
      /* @gate-identity check-bypass-write-boundary/bypass-write-083 */
      mkdirSync(directory, { recursive: true });
    }
    const regular = pending.filter(({ mode }) => mode === "100644"),
      links = pending.filter(({ mode }) => mode === "120000"),
      fileSync = beginDurableSettlement({ files: regular });
    try {
      hooks.whileFilesSync?.();
      awaitDurableSettlement(fileSync);
    } catch (error) {
      try {
        awaitDurableSettlement(fileSync);
      } catch (syncError) {
        consumeKnownError(syncError);
      }
      for (const item of regular) removeNode(item.temporary);
      throw error;
    }
    for (const item of [
      ...regular.map(({ temporary: from, target: to }) => ({ from, to })),
      ...pendingRenames.filter(({ pending }) => pending).map(({ from, to }) => ({ from, to })),
    ]) {
      hooks.beforeRename?.();
      /* @gate-identity check-bypass-write-boundary/bypass-write-093 */
      renameSync(item.from, item.to);
      hooks.afterRename?.();
    }
    for (const item of deletions) removeNode(item.target);
    const zero = "0".repeat(40);
    const indexInput = `${pending
      .map((file) => `${file.mode} ${gitBlobOid(file.body)}\t${file.logical}\0`)
      .join("")}${pendingRenames
      .map(
        (file) =>
          `0 ${zero}\t${file.fromLogical}\0${file.node.mode} ${gitBlobOid(file.node.body)}\t${file.toLogical}\0`,
      )
      .join("")}${deletions.map((file) => `0 ${zero}\t${file.logical}\0`).join("")}`;
    if (files.length) localGitProcesses += 1;
    awaitDurableSettlement(
      beginDurableSettlement({
        index: files.length ? { repoRoot, input: indexInput } : undefined,
      }),
    );
    for (const item of links) {
      hooks.beforeRename?.();
      runGit(repoRoot, "checkout-index", "--force", "--", item.logical);
      hooks.afterRename?.();
    }
    awaitDurableSettlement(beginDurableSettlement({ directories: [...directories] }));
    return files.length + directories.size;
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
    id = hashVcsBytes("sha256", `${logical}\0${identity}\0${node.mode}\0${hashVcsBytes("sha256", node.body)}`).slice(
      0,
      8,
    ),
    scratch = `${stem}.conflict-${id}${extension}`,
    relative = path.relative(repoRoot, scratch).split(path.sep).join("/");
  ensureConflictExclude(repoRoot);
  if (!readNode(scratch)) {
    if (node.mode === "120000")
      /* @gate-identity check-bypass-write-boundary/bypass-write-078 */
      symlinkSync(node.body, scratch);
    else if (durable) durableWrite(scratch, Buffer.from(node.body));
    else
      /* @gate-identity check-bypass-write-boundary/bypass-write-089 */
      writeFileSync(scratch, node.body, { encoding: "utf8", mode: 0o600 });
  }
  return relative;
}
function readNode(
  target: string,
): {
  readonly mode: "100644" | "120000";
  readonly body: string;
  readonly sha256: string;
  readonly gitOid: string;
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
      sha256: hashVcsBytes("sha256", bytes),
      gitOid: gitBlobOidBytes(bytes),
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
function gitBlobOid(body: string): string {
  return gitBlobOidBytes(Buffer.from(body));
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
  readonly files?: readonly { readonly temporary: string; readonly body: string }[];
  readonly directories?: readonly string[];
  readonly index?: { readonly repoRoot: string; readonly input: string };
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
          ...(request.files ?? []).map(async (file) => {
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
            : (request.directories ?? []).map(async (directory) => {
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
        }
        await Promise.all(durability);
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
