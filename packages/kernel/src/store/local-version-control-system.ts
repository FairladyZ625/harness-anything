import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { open as openAsync } from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { consumeKnownError } from "../error-consumption.ts";
import type { VcsCommitAuthor, VersionControlSystem } from "../ports/version-control-system.ts";
import { VcsCommandError } from "../ports/version-control-system.ts";

const gitMaxBuffer = 256 * 1024 * 1024;

export function makeLocalVersionControlSystem(): VersionControlSystem {
  return {
    normalizePath: normalizeLocalPath,
    topLevel: gitTopLevel,
    isIgnored: (repoRoot, relativePath) => {
      try {
        runGit(repoRoot, "check-ignore", "--no-index", "-q", "--", relativePath);
        return true;
      } catch {
        return false;
      }
    },
    add: (repoRoot, input) => {
      if (input.paths.length === 0) return;
      runGit(repoRoot, "add", "-A", ...(input.force ? ["-f"] : []), "--", ...input.paths);
    },
    workingTreeFiles: (repoRoot, paths) => runGit(repoRoot, "status", "--porcelain", "-uall", "--", ...paths),
    stagedFiles: (repoRoot, paths) => runGit(repoRoot, "diff", "--cached", "--name-only", "--", ...paths),
    commit: (repoRoot, message, author) => {
      runGitAs(repoRoot, author, "commit", "-m", message);
    },
    currentHead: (repoRoot) => {
      try {
        return runGit(repoRoot, "rev-parse", "HEAD").trim();
      } catch {
        return "no-git-head";
      }
    },
    currentBranch: (repoRoot) => {
      try {
        const name = runGit(repoRoot, "rev-parse", "--abbrev-ref", "HEAD").trim();
        return name.length > 0 && name !== "HEAD" ? name : null;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    },
    originHeadBranch: (repoRoot) => {
      try {
        const ref = runGit(repoRoot, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD").trim();
        if (ref.length === 0) return null;
        const slash = ref.indexOf("/");
        return slash >= 0 ? ref.slice(slash + 1) : ref;
      } catch (error) {
        consumeKnownError(error);
        return null;
      }
    },
    refExists: (repoRoot, ref) => {
      try {
        runGit(repoRoot, "rev-parse", "--verify", "--quiet", ref);
        return true;
      } catch {
        return false;
      }
    },
    commitExists: (repoRoot, sha) => {
      try {
        runGit(repoRoot, "cat-file", "-e", `${sha}^{commit}`);
        return true;
      } catch {
        return false;
      }
    },
    pathExistsAtCommit: (repoRoot, sha, relativePath) => {
      try {
        runGit(repoRoot, "cat-file", "-e", `${sha}:${relativePath}`);
        return true;
      } catch {
        return false;
      }
    },
    checkout: (repoRoot, ref) => {
      runGit(repoRoot, "checkout", ref);
    },
    createBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", branch);
    },
    mergeNoFf: (repoRoot, branch, message) => {
      runGit(repoRoot, "merge", "--no-ff", branch, "-m", message);
    },
    deleteBranch: (repoRoot, branch) => {
      runGit(repoRoot, "branch", "-d", branch);
    },
    abortMerge: (repoRoot) => {
      runGit(repoRoot, "merge", "--abort");
    },
    sessionBranches: (repoRoot) => runGit(repoRoot, "for-each-ref", "--sort=creatordate", "--format=%(refname:short)", "refs/heads/sessions")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter((entry) => entry.startsWith("sessions/")),
    commitsNotInTrunk: (repoRoot, trunkBranch, branch) => runGit(repoRoot, "log", `${trunkBranch}..${branch}`, "--oneline")
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .filter(Boolean),
    changedFilesBetween: (repoRoot, before, after) => {
      if (before === after) return [];
      return runGit(repoRoot, "diff", "--name-only", before, after)
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    resetQuiet: (repoRoot, pathspecs) => {
      if (pathspecs.length === 0) return;
      runGit(repoRoot, "reset", "-q", "--", ...pathspecs);
    }
  };
}

const geometricMaintenanceFloor = Object.freeze([2, 52, 0]);
export interface LedgerMaintenanceReceipt { readonly gitVersion: string | null; readonly strategy: "geometric" | null; readonly applied: readonly string[]; readonly degraded: string | null }
/** Pins the ledger repository's own maintenance policy so Git's automatic housekeeping stays out of the write path and repacks incrementally instead of rebuilding every pack from scratch. Repository config outranks the user's global config, so a global `gc.autoDetach=false` cannot drag a repack into a ledger write. Idempotent: only differing keys are written. */
export function configureLedgerMaintenance(repoRoot: string): LedgerMaintenanceReceipt {
  const version = readGitVersion(repoRoot), applied: string[] = [];
  const pin = (key: string, value: string): void => { if (readGitConfig(repoRoot, key) === value) return; runGit(repoRoot, "config", key, value); applied.push(`${key}=${value}`); };
  pin("maintenance.autoDetach", "true"); pin("gc.autoDetach", "true");
  const geometric = version !== null && atLeastGitVersion(version.parts, geometricMaintenanceFloor);
  if (geometric) pin("maintenance.strategy", "geometric");
  return { gitVersion: version?.text ?? null, strategy: geometric ? "geometric" : null, applied, degraded: geometric ? null : `git ${version?.text ?? "(version unreadable)"} predates the 2.52.0 geometric maintenance strategy; this ledger keeps Git's default repack cadence.` };
}
function readGitVersion(repoRoot: string): { readonly text: string; readonly parts: readonly number[] } | null {
  const raw = readGitText(repoRoot, ["version"]); if (raw === null) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/u.exec(raw); if (!match) return null;
  return { text: match[0], parts: [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] };
}
function readGitConfig(repoRoot: string, key: string): string | null { return readGitText(repoRoot, ["config", "--get", key]); }
function readGitText(repoRoot: string, args: readonly string[]): string | null { try { const value = runGit(repoRoot, ...args).trim(); return value.length > 0 ? value : null; } catch (error) { consumeKnownError(error); return null; } }
function atLeastGitVersion(actual: readonly number[], floor: readonly number[]): boolean { for (let at = 0; at < floor.length; at += 1) { const seen = actual[at] ?? 0, want = floor[at] ?? 0; if (seen !== want) return seen > want; } return true; }

function gitTopLevel(inputPath: string): string | null {
  try { let probe = path.resolve(inputPath); while (!existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
    return normalizeLocalPath(runGit(probe, "rev-parse", "--show-toplevel").trim()); } catch (error) {
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
  try {
    return execFileSync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: gitMaxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(author ? {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? author.name,
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? author.email
        } : {})
      }
    });
  } catch (error) {
    throw new VcsCommandError({
      command: args[0] ?? "command",
      cwd: repoRoot,
      exitCode: commandErrorCode(error),
      signal: commandErrorSignal(error),
      stderrSummary: commandErrorSummary(error)
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

export function localGitText(repoRoot: string, ...args: readonly string[]): string { return runGit(repoRoot, ...args); }
function localGitBytes(repoRoot: string, args: readonly string[], input?: Uint8Array): Buffer {
  localGitProcesses += 1;
  try { return execFileSync("git", ["-C", repoRoot, ...args], { input, encoding: "buffer", maxBuffer: gitMaxBuffer, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }); }
  catch (error) { throw new VcsCommandError({ command: args[0] ?? "command", cwd: repoRoot, exitCode: commandErrorCode(error), signal: commandErrorSignal(error), stderrSummary: commandErrorSummary(error) }); }
}
export const localGitObjectRefStore = Object.freeze({
  processCount: () => localGitProcesses, resolveCommit: (repoRoot: string, revision: string) => runGit(repoRoot, "rev-parse", revision).trim(),
  currentBranch: (repoRoot: string): string | null => { try { const dotGit = path.join(repoRoot, ".git"), gitDir = statSync(dotGit).isDirectory() ? dotGit : path.resolve(repoRoot, /^gitdir: (.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1] ?? ""), ref = /^ref: refs\/heads\/(.+)$/mu.exec(readFileSync(path.join(gitDir, "HEAD"), "utf8"))?.[1]; return ref ?? null; } catch (error) { consumeKnownError(error); return null; } },
  readPath: (repoRoot: string, commit: string, target: string): Buffer | null => { try { return localGitBytes(repoRoot, ["show", `${commit}:${target}`]); } catch (error) { try { if (localGitBytes(repoRoot, ["ls-tree", "--name-only", "-z", commit, "--", target]).length === 0) return null; } catch (classificationError) { consumeKnownError(classificationError); } throw error; } },
  isAncestor: (repoRoot: string, ancestor: string, current: string): boolean => { try { runGit(repoRoot, "merge-base", "--is-ancestor", ancestor, current); return true; } catch (error) { consumeKnownError(error); return false; } },
  batch: (repoRoot: string, input: string) => localGitBytes(repoRoot, ["cat-file", "--batch"], Buffer.from(input)),
  importCommit: (repoRoot: string, input: string) => localGitBytes(repoRoot, ["-c", "core.fsync=committed,reference", "-c", "core.fsyncMethod=fsync", "fast-import", "--quiet", "--force"], Buffer.from(input)),
  listRefs: (repoRoot: string, refs: readonly string[]) => runGit(repoRoot, "for-each-ref", "--format=%(refname) %(objectname)", ...refs),
  updateRef: (repoRoot: string, ref: string, sha: string, previous?: string) => { runGit(repoRoot, "-c", "core.fsync=reference", "-c", "core.fsyncMethod=fsync", "update-ref", ref, sha, ...(previous ? [previous] : [])); },
  updateRefs: (repoRoot: string, input: string) => { localGitBytes(repoRoot, ["-c", "core.fsync=reference", "-c", "core.fsyncMethod=fsync", "update-ref", "--stdin"], Buffer.from(input)); },
  deleteRef: (repoRoot: string, ref: string) => { runGit(repoRoot, "update-ref", "-d", ref); }
});
export const localGitWorktreeSettlement = Object.freeze({
  readNode,
  settle: (repoRoot: string, files: readonly ({ readonly target: string; readonly body: string; readonly mode?: "100644" | "120000" } | { readonly from: string; readonly to: string })[], hooks: { readonly whileFilesSync?: () => void; readonly beforeRename?: () => void; readonly afterRename?: () => void } = {}): number => { const directories = new Set<string>(), writes = files.filter((file): file is { readonly target: string; readonly body: string; readonly mode?: "100644" | "120000" } => "target" in file), renames = files.filter((file): file is { readonly from: string; readonly to: string } => "from" in file), pending = writes.map((file, index) => { const target = path.join(repoRoot, ...file.target.split("/")), directory = path.dirname(target), temporary = path.join(directory, `.ha-settle-${process.pid}-${index}`), mode = file.mode ?? "100644"; directories.add(directory); removeNode(temporary); return { target, temporary, body: file.body, mode, logical: file.target }; }), pendingRenames = renames.map((file) => { const from = path.join(repoRoot, ...file.from.split("/")), to = path.join(repoRoot, ...file.to.split("/")), source = readNode(from), destination = readNode(to); if (source === null && destination === null) throw new Error(`settlement rename is missing both ${file.from} and ${file.to}`); if (source !== null && destination !== null) throw new Error(`settlement rename target already exists at ${file.to}`); directories.add(path.dirname(from)); directories.add(path.dirname(to)); return { from, to, fromLogical: file.from, toLogical: file.to, node: source ?? destination!, pending: source !== null }; }); for (const directory of directories) mkdirSync(directory, { recursive: true }); const regular = pending.filter(({ mode }) => mode === "100644"), links = pending.filter(({ mode }) => mode === "120000"), fileSync = beginDurableSettlement({ files: regular }); try { hooks.whileFilesSync?.(); awaitDurableSettlement(fileSync); } catch (error) { try { awaitDurableSettlement(fileSync); } catch (syncError) { consumeKnownError(syncError); } for (const item of regular) removeNode(item.temporary); throw error; } for (const item of [...regular.map(({ temporary: from, target: to }) => ({ from, to })), ...pendingRenames.filter(({ pending }) => pending).map(({ from, to }) => ({ from, to }))]) { hooks.beforeRename?.(); renameSync(item.from, item.to); hooks.afterRename?.(); } const zero = "0".repeat(40), indexInput = `${pending.map((file) => `${file.mode} ${gitBlobOid(file.body)}\t${file.logical}\0`).join("")}${pendingRenames.map((file) => `0 ${zero}\t${file.fromLogical}\0${file.node.mode} ${gitBlobOid(file.node.body)}\t${file.toLogical}\0`).join("")}`; if (files.length) localGitProcesses += 1; awaitDurableSettlement(beginDurableSettlement({ index: files.length ? { repoRoot, input: indexInput } : undefined })); for (const item of links) { hooks.beforeRename?.(); runGit(repoRoot, "checkout-index", "--force", "--", item.logical); hooks.afterRename?.(); } awaitDurableSettlement(beginDurableSettlement({ directories: [...directories] })); return files.length + directories.size; },
  preserveConflict: (repoRoot: string, target: string, logical: string, commit: string): string => { const node = readNode(target); if (!node) throw new Error(`conflicting worktree node disappeared at ${logical}`); const extension = path.extname(target), stem = target.slice(0, target.length - extension.length), id = hashVcsBytes("sha256", `${logical}\0${commit}\0${node.mode}\0${hashVcsBytes("sha256", node.body)}`).slice(0, 8), scratch = `${stem}.conflict-${id}${extension}`, relative = path.relative(repoRoot, scratch).split(path.sep).join("/"); ensureConflictExclude(repoRoot); if (!readNode(scratch)) { if (node.mode === "120000") checkoutDetachedSymlink(repoRoot, relative, node.body); else durableWrite(scratch, Buffer.from(node.body)); } return relative; }
});
function readNode(target: string): { readonly mode: "100644" | "120000"; readonly body: string; readonly sha256: string; readonly size: number } | null { try { const info = lstatSync(target), mode = info.isSymbolicLink() ? "120000" as const : info.isFile() ? "100644" as const : null; if (mode === null) return null; const bytes = mode === "120000" ? readlinkSync(target, { encoding: "buffer" }) : readFileSync(target); return { mode, body: bytes.toString("utf8"), sha256: hashVcsBytes("sha256", bytes), size: bytes.byteLength }; } catch (error) { consumeKnownError(error); return null; } }
function removeNode(target: string): void { try { unlinkSync(target); } catch (error) { consumeKnownError(error); } }
function gitBlobOid(body: string): string { const bytes = Buffer.from(body); return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex"); }
function hashVcsBytes(algorithm: "sha256", body: string | Uint8Array): string { return createHash(algorithm).update(body).digest("hex"); }
function checkoutDetachedSymlink(repoRoot: string, relative: string, body: string): void { const rawGitDir = runGit(repoRoot, "rev-parse", "--git-dir").trim(), gitDir = path.isAbsolute(rawGitDir) ? rawGitDir : path.join(repoRoot, rawGitDir), index = path.join(gitDir, `ha-symlink-index-${process.pid}-${hashVcsBytes("sha256", relative).slice(0, 8)}`), env = { ...process.env, GIT_INDEX_FILE: index }; removeNode(index); try { runGitWithEnvironment(repoRoot, env, ["read-tree", "--empty"]); const oid = runGitWithEnvironment(repoRoot, env, ["hash-object", "-w", "--stdin"], Buffer.from(body)).trim(); runGitWithEnvironment(repoRoot, env, ["update-index", "--add", "--cacheinfo", `120000,${oid},${relative}`]); runGitWithEnvironment(repoRoot, env, ["checkout-index", "--force", "--", relative]); } finally { removeNode(index); } }
function runGitWithEnvironment(repoRoot: string, env: NodeJS.ProcessEnv, args: readonly string[], input?: Uint8Array): string { localGitProcesses += 1; try { return execFileSync("git", ["-C", repoRoot, ...args], { env, input, encoding: "utf8", maxBuffer: gitMaxBuffer, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] }); } catch (error) { throw new VcsCommandError({ command: args[0] ?? "command", cwd: repoRoot, exitCode: commandErrorCode(error), signal: commandErrorSignal(error), stderrSummary: commandErrorSummary(error) }); } }
function ensureConflictExclude(repoRoot: string): void { const raw = runGit(repoRoot, "rev-parse", "--git-path", "info/exclude").trim(), target = path.isAbsolute(raw) ? raw : path.join(repoRoot, raw), marker = "*.conflict-*\n"; mkdirSync(path.dirname(target), { recursive: true }); const current = existsSync(target) ? readFileSync(target, "utf8") : ""; if (!current.split(/\r?\n/u).includes("*.conflict-*")) writeFileSync(target, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${marker}`); }
function durableWrite(target: string, body: Uint8Array): void { const directory = path.dirname(target), temporary = `${target}.tmp-${process.pid}`; mkdirSync(directory, { recursive: true }); const descriptor = openSync(temporary, "w", 0o600); try { writeFileSync(descriptor, body); fsyncSync(descriptor); } finally { closeSync(descriptor); } renameSync(temporary, target); const parent = openSync(directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); } }

function commandErrorSummary(error: unknown): string | undefined {
  if (typeof error === "object" && error && "stderr" in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const text = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : typeof stderr === "string" ? stderr : "";
    const firstLine = text.trim().split(/\r?\n/u).find((line) => line.trim().length > 0);
    if (firstLine) return firstLine;
  }
  if (error instanceof Error) return error.message.split(/\r?\n/u)[0] ?? error.message;
  return String(error);
}
const settlementWorkerKind = "harness-durable-settlement/v1"; let settlementWorker: Worker | null = null;
interface DurableSettlementInput { readonly files?: readonly { readonly temporary: string; readonly body: string }[]; readonly directories?: readonly string[]; readonly index?: { readonly repoRoot: string; readonly input: string } } interface DurableSettlementWait { readonly state: Int32Array; readonly errorBytes: Uint8Array; readonly worker: Worker } function beginDurableSettlement(input: DurableSettlementInput): DurableSettlementWait | null { if (!input.files?.length && !input.directories?.length && !input.index) return null; const state = new Int32Array(new SharedArrayBuffer(8)), errorBytes = new Uint8Array(new SharedArrayBuffer(4096)), worker = getSettlementWorker(); worker.ref(); worker.postMessage({ ...input, state, errorBytes }); return { state, errorBytes, worker }; }
function awaitDurableSettlement(pending: DurableSettlementWait | null): void { if (!pending) return; const wait = Atomics.wait(pending.state, 0, 0, 30_000); pending.worker.unref(); if (wait === "timed-out") throw new Error("durable settlement worker timed out"); if (Atomics.load(pending.state, 0) !== 1) throw new Error(new TextDecoder().decode(pending.errorBytes.subarray(0, Atomics.load(pending.state, 1))) || "durable settlement worker failed"); }
function getSettlementWorker(): Worker { if (settlementWorker) return settlementWorker; const ready = new Int32Array(new SharedArrayBuffer(4)), worker = new Worker(new URL(import.meta.url), { execArgv: process.execArgv.filter((argument) => argument === "--experimental-strip-types" || argument === "--enable-source-maps"), workerData: { kind: settlementWorkerKind, ready } }); worker.unref(); if (Atomics.wait(ready, 0, 0, 5_000) === "timed-out") { void worker.terminate(); throw new Error("durable settlement worker failed to start"); } settlementWorker = worker; return worker; }
if (!isMainThread && workerData?.kind === settlementWorkerKind) { const ready = workerData.ready as Int32Array; parentPort!.on("message", async (request: DurableSettlementInput & { readonly state: Int32Array; readonly errorBytes: Uint8Array }) => { try { const durability = [...(request.files ?? []).map(async (file) => { const descriptor = await openAsync(file.temporary, "w", 0o644); try { await descriptor.writeFile(file.body); await descriptor.sync(); } finally { await descriptor.close(); } }), ...(request.directories ?? []).map(async (directory) => { const descriptor = await openAsync(directory, "r"); try { await descriptor.sync(); } finally { await descriptor.close(); } })]; if (request.index) execFileSync("git", ["-C", request.index.repoRoot, "update-index", "-z", "--index-info"], { input: Buffer.from(request.index.input), stdio: ["pipe", "pipe", "pipe"] }); await Promise.all(durability); Atomics.store(request.state, 0, 1); } catch (error) { consumeKnownError(error); const bytes = new TextEncoder().encode(error instanceof Error ? error.message : String(error)), length = Math.min(bytes.length, request.errorBytes.length); request.errorBytes.set(bytes.subarray(0, length)); Atomics.store(request.state, 1, length); Atomics.store(request.state, 0, 2); } finally { Atomics.notify(request.state, 0); } }); Atomics.store(ready, 0, 1); Atomics.notify(ready, 0); }
let localGitProcesses = 0;
export function localGitProcessCount(): number { return localGitProcesses; }
