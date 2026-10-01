import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveHarnessLayout } from "@harness-anything/kernel";
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

/**
 * A `run:` step still running after this long fails like any other: the start is refused and the step named. Every
 * process the step started stops with it, so nothing keeps writing the worktree after the refusal.
 */
const worktreeSetupStepTimeoutMs = 20 * 60 * 1000;

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
 * Links the ledger into the worktree, then runs every declared step that has not succeeded in this worktree yet;
 * stops at the first that fails.
 */
export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupResult> {
  linkWorktreeLedger(input.rootDir, input.cwd);
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
        input.stepTimeoutMs ?? worktreeSetupStepTimeoutMs,
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
// resolve only under the canonical checkout takes that checkout for its repository root (F-3AC0AFF0). Every managed
// worktree therefore holds, at the ledger's own repository-relative path, a directory of links to the ledger's
// directories: each path a worker is given resolves under its own root. The directory is a real one, so the ignore
// rule bootstrap wrote covers it and git reaches no path through a link; one link for the whole ledger would be a
// file to git, outside that rule. Only directories are linked: a junction needs no privilege on Windows, a file
// link does. The ledger's own git directory stays out.

function ledgerMirror(rootDir: string, cwd: string): { readonly authoredRoot: string; readonly mirror: string } {
  const layout = resolveHarnessLayout(rootDir);
  return {
    authoredRoot: layout.authoredRoot,
    mirror: path.join(cwd, path.relative(layout.rootDir, layout.authoredRoot)),
  };
}

/** The links a worktree holds; null when its ledger directory is a copy the repository tracks, not ours to touch. */
function mirrorLinks(mirror: string): readonly string[] | null {
  const entries = existsSync(mirror) ? readdirSync(mirror, { withFileTypes: true }) : [];
  return entries.every((entry) => entry.isSymbolicLink()) ? entries.map((entry) => entry.name) : null;
}

/** Links every ledger directory the worktree does not reach yet. A root without a ledger has nothing to link. */
function linkWorktreeLedger(rootDir: string, cwd: string): void {
  const { authoredRoot, mirror } = ledgerMirror(rootDir, cwd),
    linked = existsSync(authoredRoot) ? mirrorLinks(mirror) : null;
  if (linked === null) return;
  mkdirSync(mirror, { recursive: true });
  for (const entry of readdirSync(authoredRoot, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name !== ".git" && !linked.includes(entry.name))
      symlinkSync(path.join(authoredRoot, entry.name), path.join(mirror, entry.name), "junction");
}

/** Removes the links themselves before a worktree is reclaimed, so no removal ever walks into the ledger. */
export function unlinkWorktreeLedger(rootDir: string, cwd: string): void {
  const { mirror } = ledgerMirror(rootDir, cwd);
  for (const name of mirrorLinks(mirror) ?? []) unlinkSync(path.join(mirror, name));
}

/**
 * A ledger path as the worker reaches it: under its own root when the same file is there. A worker in the canonical
 * checkout, a cwd that does not reach this ledger (an explicitly requested directory, a checkout of a repository
 * that tracks its own copy) and a path outside the ledger keep the path as it is.
 */
export function workerLedgerPath(rootDir: string, cwd: string, target: string): string {
  const { authoredRoot, mirror } = ledgerMirror(rootDir, cwd);
  if (mirror === authoredRoot || !existsSync(authoredRoot) || !existsSync(target)) return target;
  const real = realpathSync(target),
    relative = path.relative(realpathSync(authoredRoot), real);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return target;
  const reached = path.join(mirror, relative);
  return existsSync(reached) && realpathSync(reached) === real ? reached : target;
}
