import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { posixShellFallback, runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";
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

export interface WorktreeSetupInput {
  readonly rootDir: string;
  readonly cwd: string;
  /** The task the worktree serves, exported to every step as HARNESS_TASK_ID; null for a schedule occurrence. */
  readonly taskId: string | null;
  readonly steps: readonly string[];
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
      const { exitCode } = await runShell(step.slice("run: ".length), input.cwd, log, environment);
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
function runShell(command: string, cwd: string, log: string, environment: NodeJS.ProcessEnv) {
  if (process.platform === "win32")
    return runProcessExitAsync(
      environment.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `"${command} >> "${log}" 2>&1"`],
      cwd,
      environment,
      undefined,
      undefined,
      { windowsVerbatimArguments: true },
    );
  return runProcessExitAsync(posixShellFallback, ["-c", `exec >>"$HARNESS_SETUP_LOG" 2>&1\n${command}`], cwd, {
    ...environment,
    HARNESS_SETUP_LOG: log,
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
