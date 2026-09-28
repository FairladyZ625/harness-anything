import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
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

/** Runs every declared step that has not succeeded in this worktree yet; stops at the first that fails. */
export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupResult> {
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

function setupDirectory(cwd: string): Promise<string> {
  return runProcessTextAsync("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"]).then((gitDir) =>
    path.join(gitDir.trim(), "harness-setup"),
  );
}

function readSucceeded(directory: string): string[] {
  const file = path.join(directory, "succeeded.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
}
