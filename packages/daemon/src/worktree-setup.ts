import {
  appendFileSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  DEFAULT_WORKTREE_SETUP_STEP_TIMEOUT_MS,
  resolveHarnessLayout,
  type RepositorySettingsV1,
} from "@harness-anything/kernel";
import { posixShellFallback, runProcessExitAsync, runProcessTextAsync, startDetachedProcess } from "./process-port.ts";
import { nodeModulesSetupAdapter } from "./worktree-setup-node-modules.ts";

// dec_8B3FCCD256CAC5B0BF3CCEDE58 CH3: the repository declares in Settings `worktree.setup` what a fresh worktree
// needs; the node that checks the worktree out runs those steps once, in order, inside it. What ran is observed
// here only — the record and the step logs live in the worktree's own git directory, so `git worktree remove`
// takes them along and nothing is written back to the ledger.

const adapters: Readonly<
  Record<
    string,
    {
      readonly prepare: (input: { readonly rootDir: string; readonly cwd: string }) => void | Promise<void>;
      readonly cleanup: (cwd: string) => Promise<void>;
    }
  >
> = { "node-modules": nodeModulesSetupAdapter };

const worktreeLedgerMarker = "harness-ledger-mirror/v1\n";

/**
 * A `run:` step still running past Settings `worktree.setupStepTimeoutMs` fails like any other: the start is
 * refused and the step named. Every process the step started stops with it, so nothing keeps writing the worktree
 * after the refusal.
 */

/** The Settings `worktree` section whole: the steps and how long one step may run. */
export type WorktreeSetupSettings = RepositorySettingsV1["worktree"];

/** The section where no Settings reader exists: no steps, the declared default step timeout. */
export function noWorktreeSetup(): WorktreeSetupSettings {
  return { setup: [], setupStepTimeoutMs: DEFAULT_WORKTREE_SETUP_STEP_TIMEOUT_MS };
}

export interface WorktreeSetupInput {
  readonly rootDir: string;
  readonly cwd: string;
  /** The task the worktree serves, exported to every step as HARNESS_TASK_ID; null for a schedule occurrence. */
  readonly taskId: string | null;
  readonly steps: readonly string[];
  readonly stepTimeoutMs?: number;
}

export type WorktreeSetupResult =
  | { readonly ok: true; readonly ran: readonly string[] }
  | {
      readonly ok: false;
      readonly step: string;
      readonly position: number;
      readonly log: string;
      readonly detail: string;
    };

/**
 * Mirrors the task package into the worktree, then runs every declared step that has not succeeded in this worktree
 * yet; stops at the first that fails.
 */
export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupResult> {
  linkWorktreeLedger(input.rootDir, input.cwd, input.taskId);
  if (input.steps.length === 0) return { ok: true, ran: [] };
  const directory = await setupDirectory(input.cwd),
    succeeded = readSucceeded(directory),
    ran: string[] = [];
  mkdirSync(directory, { recursive: true });
  for (const [index, step] of input.steps.entries()) {
    if (succeeded.includes(step)) continue;
    const log = path.join(directory, `step-${index + 1}.log`);
    writeFileSync(log, `$ ${step}\n`);
    const failure = await runStep(input, step, log);
    if (failure !== null) return { ok: false, step, position: index + 1, log, detail: failure };
    succeeded.push(step);
    writeFileSync(path.join(directory, "succeeded.json"), `${JSON.stringify(succeeded)}\n`);
    ran.push(step);
  }
  return { ok: true, ran };
}

/** One sentence naming the failed step, its log, and how to run what is left again. */
export function worktreeSetupFailure(
  cwd: string,
  failure: Extract<WorktreeSetupResult, { readonly ok: false }>,
  retry: string,
  baseRef: string | null = null,
): string {
  return (
    `Worktree ${cwd} was checked out${baseRef ? ` from ${baseRef}` : ""} but setup step ${failure.position} ` +
    `(${failure.step}) failed: ${failure.detail}. ` +
    `Log: ${failure.log}. The worktree is kept; fix the cause, then ${retry} — only the steps that have not ` +
    "succeeded run again."
  );
}

/** Before a worktree is reclaimed, each built-in adapter that prepared it removes what it made. */
export async function cleanupWorktreeSetup(cwd: string): Promise<void> {
  const directory = await setupDirectory(cwd),
    succeeded = readSucceeded(directory),
    kept = [];
  for (const step of succeeded) {
    const adapter = adapters[step];
    if (adapter) await adapter.cleanup(cwd);
    else kept.push(step);
  }
  if (kept.length !== succeeded.length)
    writeFileSync(path.join(directory, "succeeded.json"), `${JSON.stringify(kept)}\n`);
}

async function runStep(input: WorktreeSetupInput, step: string, log: string): Promise<string | null> {
  const environment = {
    ...process.env,
    ...(input.taskId ? { HARNESS_TASK_ID: input.taskId } : {}),
    HARNESS_WORKTREE: input.cwd,
    HARNESS_REPO_ROOT: input.rootDir,
  };
  try {
    if (step.startsWith("run: ")) {
      const { exitCode } = await runShell(
        step.slice("run: ".length),
        input.cwd,
        log,
        environment,
        input.stepTimeoutMs ?? DEFAULT_WORKTREE_SETUP_STEP_TIMEOUT_MS,
      );
      return exitCode === 0 ? null : `exit code ${exitCode}`;
    }
    const adapter = adapters[step];
    if (!adapter) return `${step} is not a built-in adapter`;
    await adapter.prepare(input);
    return null;
  } catch (error) {
    // The failure is the step's result: the caller refuses the start and names this step and its log.
    const detail = error instanceof Error ? error.message : String(error);
    appendFileSync(log, `${detail}\n`);
    return detail;
  }
}

/** The shell writes the step's own output straight to its log, so a long install never passes through memory. */
async function runShell(command: string, cwd: string, log: string, environment: NodeJS.ProcessEnv, timeoutMs: number) {
  try {
    return await spawnShell(command, cwd, log, environment, timeoutMs);
  } catch (error) {
    if ((error as { readonly killed?: boolean }).killed !== true) throw error;
    throw new Error(`timed out after ${timeoutMs / 1000}s`);
  }
}

function spawnShell(command: string, cwd: string, log: string, environment: NodeJS.ProcessEnv, timeoutMs: number) {
  if (process.platform === "win32")
    return runProcessExitAsync(
      environment.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `"${command} >> "${log}" 2>&1"`],
      cwd,
      environment,
      undefined,
      undefined,
      { windowsVerbatimArguments: true, timeoutMs },
    );
  // The shell leads its own process group, and the timeout kills that whole group: what the step started (an
  // install) goes with it. Until the exit event the shell is at least unreaped, so its group still exists.
  const shell = startDetachedProcess(
    posixShellFallback,
    ["-c", `exec >>"$HARNESS_SETUP_LOG" 2>&1\n${command}`],
    { ...environment, HARNESS_SETUP_LOG: log },
    undefined,
    cwd,
  );
  return new Promise<{ readonly exitCode: number }>((resolve, reject) => {
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      process.kill(-shell.pid!, "SIGKILL");
    }, timeoutMs);
    shell.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    shell.once("exit", (exitCode, signal) => {
      clearTimeout(timer);
      if (exitCode === null) reject(Object.assign(new Error(`${command} ended by ${signal}`), { killed }));
      else resolve({ exitCode });
    });
  });
}

/**
 * The steps recorded as succeeded in a worktree checked out on this node, read without spawning git so a task read
 * stays synchronous: a managed worktree is a linked one, whose `.git` file names its git directory.
 */
export function readWorktreeSetupSucceeded(cwd: string): string[] {
  const gitDir = /^gitdir: (.+)$/mu.exec(readFileSync(path.join(cwd, ".git"), "utf8"))![1]!;
  return readSucceeded(path.join(path.resolve(cwd, gitDir.trim()), "harness-setup"));
}

/**
 * Whether a managed worktree is materialized at the path: a linked checkout holds a `.git` file. Residue a late
 * writer left at a reclaimed path (a Node compile cache recreated after the removal) is not a worktree — a reader
 * takes it as already reclaimed instead of failing on the missing `.git`.
 */
export function isLinkedWorktree(cwd: string): boolean {
  return existsSync(cwd) && existsSync(path.join(cwd, ".git"));
}

function setupDirectory(cwd: string): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"]).then((gitDir) =>
    path.join(gitDir.trim(), "harness-setup"),
  );
}

function readSucceeded(directory: string): string[] {
  const file = path.join(directory, "succeeded.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
}

// The project repository ignores its ledger, so a worktree checks none out, and a worker handed ledger paths that
// resolve only under the canonical checkout takes that checkout for its repository root (F-3AC0AFF0). The worker
// gets a real task-package directory containing hard links to its existing files: edits to those files remain the
// doc-sync channel (the daemon scans the canonical working copy), while `..` stays inside the worker checkout and
// cannot walk from the package into sibling ledger directories. New artifacts are created locally and published
// through the task artifact command. Other ledger files handed to a runtime are copied into an ignored private
// directory inside the worktree, so consumers can read and mutate them without reaching the canonical ledger or
// being told the canonical checkout path. Worktrees materialized while every ledger directory was linked are swept
// to this layout at the next setup.

function ledgerMirror(rootDir: string, cwd: string): { readonly authoredRoot: string; readonly mirror: string } {
  const layout = resolveHarnessLayout(rootDir);
  return {
    authoredRoot: layout.authoredRoot,
    mirror: path.join(cwd, path.relative(layout.rootDir, layout.authoredRoot)),
  };
}

/** The dispatch's own task package in the ledger, named by the unique `<taskId>-` prefix of its compiled path. */
function ownPackageDirectory(authoredRoot: string, taskId: string): string | null {
  const tasksRoot = path.join(authoredRoot, "tasks"),
    name = existsSync(tasksRoot) ? readdirSync(tasksRoot).find((entry) => entry.startsWith(`${taskId}-`)) : undefined;
  return name === undefined ? null : path.join(tasksRoot, name);
}

/**
 * Whether the mirror at a worktree is this daemon's to manage: absent, the old layout of links for every ledger
 * directory, or the current layout marked in this worktree's private directory. A real, unmarked ledger
 * directory that the repository tracks is not ours to touch.
 */
function mirrorOwnership(mirror: string, marker: string | null): "absent" | "legacy" | "ours" | "foreign" {
  const markerEntry = marker === null ? null : lstatSync(marker, { throwIfNoEntry: false });
  if (markerEntry !== null && markerEntry !== undefined)
    return markerEntry.isFile() &&
      !markerEntry.isSymbolicLink() &&
      readFileSync(marker!, "utf8") === worktreeLedgerMarker
      ? "ours"
      : "foreign";
  const mirrorEntry = lstatSync(mirror, { throwIfNoEntry: false });
  if (!mirrorEntry) return "absent";
  if (!mirrorEntry.isDirectory() || mirrorEntry.isSymbolicLink()) return "foreign";
  const entries = readdirSync(mirror, { withFileTypes: true });
  if (entries.length === 0) return "absent";
  return entries.every((entry) => entry.isSymbolicLink()) ? "legacy" : "foreign";
}

/** Clears this worktree's old ledger aliases and stale package mirrors, retaining only its current real package dir. */
function clearWorktreeLedgerMirror(mirror: string, keepPackage: string | null): void {
  const mirrorEntry = lstatSync(mirror, { throwIfNoEntry: false });
  if (!mirrorEntry) return;
  if (!mirrorEntry.isDirectory() || mirrorEntry.isSymbolicLink()) {
    removeMirrorEntry(mirror);
    return;
  }
  for (const entry of readdirSync(mirror, { withFileTypes: true })) {
    const entryPath = path.join(mirror, entry.name);
    if (entry.name !== "tasks") {
      removeMirrorEntry(entryPath);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      removeMirrorEntry(entryPath);
      continue;
    }
    for (const nested of readdirSync(entryPath, { withFileTypes: true })) {
      const nestedPath = path.join(entryPath, nested.name);
      if (nested.name === keepPackage && nested.isDirectory() && !nested.isSymbolicLink()) continue;
      removeMirrorEntry(nestedPath);
    }
    if (readdirSync(entryPath).length === 0) rmdirSync(entryPath);
  }
}

function removeMirrorEntry(target: string): void {
  const entry = lstatSync(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    unlinkSync(target);
    return;
  }
  for (const child of readdirSync(target)) removeMirrorEntry(path.join(target, child));
  rmdirSync(target);
}

/**
 * Mirrors the dispatch's own task package into the worktree, and nothing else: out-of-package ledger content must
 * not resolve under the worktree root, or a worker's writes there reach the canonical checkout. A root without a
 * ledger, an occurrence without a task, and a task without a package get no mirror.
 */
function linkWorktreeLedger(rootDir: string, cwd: string, taskId: string | null): void {
  const { authoredRoot, mirror } = ledgerMirror(rootDir, cwd);
  if (mirror === authoredRoot || !existsSync(authoredRoot)) return;
  const marker = worktreeLedgerMarkerPath(cwd);
  if (marker === null) return;
  ensureRealDirectory(cwd, path.dirname(marker));
  const legacyMarker = legacyWorktreeLedgerMarkerPath(cwd),
    ownershipMarker = lstatSync(marker, { throwIfNoEntry: false }) ? marker : legacyMarker,
    own = taskId === null ? null : ownPackageDirectory(authoredRoot, taskId),
    ownership = mirrorOwnership(mirror, ownershipMarker);
  if (ownership === "foreign") return;
  if (ownership === "legacy") {
    for (const entry of readdirSync(mirror)) unlinkSync(path.join(mirror, entry));
  } else if (ownership === "ours") {
    clearWorktreeLedgerMirror(mirror, own === null ? null : path.basename(own));
    clearWorktreeLedgerCopies(marker);
  }
  if (own === null) {
    if (existsSync(marker)) unlinkSync(marker);
    if (legacyMarker !== null && lstatSync(legacyMarker, { throwIfNoEntry: false })) unlinkSync(legacyMarker);
    return;
  }
  const packageMirror = path.join(mirror, "tasks", path.basename(own));
  mkdirSync(path.dirname(packageMirror), { recursive: true });
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, worktreeLedgerMarker);
  mirrorTaskPackage(own, packageMirror);
  if (legacyMarker !== null && legacyMarker !== marker && lstatSync(legacyMarker, { throwIfNoEntry: false })) {
    clearWorktreeLedgerCopies(legacyMarker);
    unlinkSync(legacyMarker);
  }
}

function mirrorTaskPackage(source: string, destination: string): void {
  if (!existsSync(destination)) mkdirSync(destination, { recursive: true });
  else if (lstatSync(destination).isSymbolicLink() || !lstatSync(destination).isDirectory())
    throw new Error(`Task package directory ${destination} must be a real directory.`);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      mirrorTaskPackage(from, to);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Task package entry ${from} is not a regular file or directory.`);
    if (!existsSync(to)) linkSync(from, to);
    else if (lstatSync(to).isSymbolicLink()) throw new Error(`Task package mirror ${to} must not be a symbolic link.`);
  }
}

function worktreeLedgerMarkerPath(cwd: string): string | null {
  const gitFile = path.join(cwd, ".git");
  // The worktree's own local root owns its mirror marker, so a repository that renamed localRoot
  // never gets a default `.harness` directory created in any of its worktrees.
  return existsSync(gitFile) && lstatSync(gitFile).isFile()
    ? path.join(resolveHarnessLayout(cwd).localRoot, "ledger-mirror")
    : null;
}

/** Marker path used by the old layout; it is cleaned after a worktree is next prepared or reclaimed. */
function legacyWorktreeLedgerMarkerPath(cwd: string): string | null {
  const gitFile = path.join(cwd, ".git");
  if (!existsSync(gitFile) || !lstatSync(gitFile).isFile()) return null;
  const match = /^gitdir: (.+)$/mu.exec(readFileSync(gitFile, "utf8"));
  return match === null ? null : path.join(path.resolve(cwd, match[1]!.trim()), "harness-ledger-mirror");
}

/** Removes the worker-local mirror before a worktree is reclaimed; hard links leave canonical files untouched. */
export function unlinkWorktreeLedger(rootDir: string, cwd: string): void {
  const { authoredRoot, mirror } = ledgerMirror(rootDir, cwd);
  if (mirror === authoredRoot) return;
  const marker = worktreeLedgerMarkerPath(cwd),
    legacyMarker = legacyWorktreeLedgerMarkerPath(cwd),
    ownershipMarker = marker !== null && lstatSync(marker, { throwIfNoEntry: false }) ? marker : legacyMarker,
    ownership = mirrorOwnership(mirror, ownershipMarker);
  if (ownership === "legacy") {
    for (const entry of readdirSync(mirror)) unlinkSync(path.join(mirror, entry));
  } else if (ownership === "ours") {
    clearWorktreeLedgerMirror(mirror, null);
    if (marker !== null) clearWorktreeLedgerCopies(marker);
  }
  if (ownership === "ours" && marker !== null && lstatSync(marker, { throwIfNoEntry: false })) unlinkSync(marker);
  if (legacyMarker !== null && legacyMarker !== marker && lstatSync(legacyMarker, { throwIfNoEntry: false })) {
    clearWorktreeLedgerCopies(legacyMarker);
    unlinkSync(legacyMarker);
  }
}

function clearWorktreeLedgerCopies(marker: string): void {
  const copies = path.join(
    path.dirname(marker),
    path.basename(marker) === "ledger-mirror" ? "ledger-files" : "harness-ledger-files",
  );
  if (lstatSync(copies, { throwIfNoEntry: false })) removeMirrorEntry(copies);
}

/**
 * A ledger path as the worker reaches it: its task package is the doc-sync channel; other files are worker-local
 * copies so a runtime given a private skill path cannot write through to the canonical ledger. A worker in the
 * canonical checkout, a cwd that does not reach this ledger, and a path outside the ledger keep the path as it is.
 */
export function workerLedgerPath(rootDir: string, cwd: string, target: string): string {
  const { authoredRoot, mirror } = ledgerMirror(rootDir, cwd);
  if (mirror === authoredRoot || !existsSync(authoredRoot) || !existsSync(target)) return target;
  const real = realpathSync(target),
    relative = path.relative(realpathSync(authoredRoot), real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return target;
  const marker = worktreeLedgerMarkerPath(cwd),
    parts = relative.split(path.sep),
    packagePath = path.join(mirror, relative);
  if (marker === null || mirrorOwnership(mirror, marker) !== "ours") return target;
  if (
    parts[0] === "tasks" &&
    parts.length >= 2 &&
    existsSync(path.join(mirror, "tasks", parts[1]!)) &&
    existsSync(packagePath)
  )
    return packagePath;
  const reached = workerLedgerCopyPath(marker, relative);
  ensureRealDirectory(path.dirname(marker), path.dirname(reached));
  copyWorkerLedgerEntry(real, reached);
  return reached;
}

function workerLedgerCopyPath(marker: string, relative: string): string {
  return path.join(path.dirname(marker), "ledger-files", relative);
}

/** Creates a worker-owned copy path without following directories a worker may have replaced with symlinks. */
function ensureRealDirectory(root: string, directory: string): void {
  if (directory === root) return;
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(`Worker ledger copy ${directory} escapes ${root}.`);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) unlinkSync(current);
    else if (entry && !entry.isDirectory())
      throw new Error(`Worker ledger copy parent ${current} must be a directory.`);
    if (!entry || entry.isSymbolicLink()) mkdirSync(current);
  }
}

function copyWorkerLedgerEntry(source: string, destination: string): void {
  const sourceEntry = lstatSync(source),
    destinationEntry = lstatSync(destination, { throwIfNoEntry: false });
  if (destinationEntry?.isFile() && sourceEntry.isFile()) return;
  if (destinationEntry?.isDirectory() && sourceEntry.isDirectory()) {
    for (const entry of readdirSync(source))
      copyWorkerLedgerEntry(path.join(source, entry), path.join(destination, entry));
    return;
  }
  if (destinationEntry) removeMirrorEntry(destination);
  if (sourceEntry.isFile()) {
    copyFileSync(source, destination);
    return;
  }
  if (!sourceEntry.isDirectory()) throw new Error(`Worker ledger path ${source} is not a regular file or directory.`);
  mkdirSync(destination);
  for (const entry of readdirSync(source))
    copyWorkerLedgerEntry(path.join(source, entry), path.join(destination, entry));
}
