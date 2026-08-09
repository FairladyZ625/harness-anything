import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsProcessTreeTerminationDependencies {
  readonly runTaskkill: (pid: number) => Promise<void>;
  readonly isProcessAlive: (pid: number) => boolean;
}

export async function ownedProcessTree(rootPid: number): Promise<ReadonlyArray<number>> {
  if (process.platform === "win32") return [rootPid];
  const parentByPid = process.platform === "linux"
    ? readLinuxProcessParents()
    : await readPosixProcessParents();
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parentPid] of parentByPid) {
      if (owned.has(parentPid) && !owned.has(pid)) {
        owned.add(pid);
        changed = true;
      }
    }
  }
  return [...owned].sort((left, right) => processDepth(right, parentByPid) - processDepth(left, parentByPid));
}

export function signalOwnedProcesses(pids: ReadonlyArray<number>, signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") continue;
      throw error;
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
    throw error;
  }
}

export async function waitForOwnedProcessesToClose(
  pids: ReadonlyArray<number>,
  childClosed: () => boolean,
  timeoutMs: number
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (childClosed() && pids.every((pid) => !isProcessAlive(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return childClosed() && pids.every((pid) => !isProcessAlive(pid));
}

export async function terminateWindowsProcessTree(
  pid: number,
  dependencies: WindowsProcessTreeTerminationDependencies = {
    runTaskkill: runWindowsTaskkill,
    isProcessAlive
  }
): Promise<void> {
  try {
    await dependencies.runTaskkill(pid);
  } catch (error) {
    // taskkill exits 128 when the target wins the race and closes first. Only
    // the verified postcondition is benign; a still-live target remains fatal.
    if (!dependencies.isProcessAlive(pid)) return;
    throw new Error(
      [
        "AUTHORITY_GIT_OBJECT_BATCH_TASKKILL_FAILED",
        `pid=${pid}`,
        `exitCode=${commandFailureField(error, "code")}`,
        `stdout=${JSON.stringify(commandFailureOutput(error, "stdout"))}`,
        `stderr=${JSON.stringify(commandFailureOutput(error, "stderr"))}`,
        `failure=${failureMessage(error)}`
      ].join(";"),
      { cause: error }
    );
  }
}

function readLinuxProcessParents(): ReadonlyMap<number, number> {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      parents.set(Number(entry), Number(fields[1]));
    } catch {
      // Processes may exit between /proc enumeration and stat reads.
    }
  }
  return parents;
}

async function readPosixProcessParents(): Promise<ReadonlyMap<number, number>> {
  const { stdout } = await execFileAsync("ps", ["-A", "-o", "pid=,ppid="], {
    encoding: "utf8",
    windowsHide: true
  });
  const parents = new Map<number, number>();
  for (const line of String(stdout).split(/\r?\n/u)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

function processDepth(pid: number, parentByPid: ReadonlyMap<number, number>): number {
  let depth = 0;
  let current = pid;
  const visited = new Set<number>();
  while (!visited.has(current)) {
    visited.add(current);
    const parent = parentByPid.get(current);
    if (parent === undefined) break;
    depth += 1;
    current = parent;
  }
  return depth;
}

async function runWindowsTaskkill(pid: number): Promise<void> {
  await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 1_000
  });
}

function commandFailureField(error: unknown, field: string): string | number {
  if (typeof error !== "object" || error === null || !(field in error)) return "unknown";
  const value = (error as Record<string, unknown>)[field];
  return typeof value === "string" || typeof value === "number" ? value : "unknown";
}

function commandFailureOutput(error: unknown, field: string): string {
  if (typeof error !== "object" || error === null || !(field in error)) return "";
  const value = (error as Record<string, unknown>)[field];
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return value === undefined || value === null ? "" : String(value);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
