import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WindowsProcessTreeTerminationDependencies {
  readonly runTaskkill?: (pid: number) => Promise<void>;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly ownedPids?: ReadonlyArray<number>;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export async function ownedProcessTree(rootPid: number): Promise<ReadonlyArray<number>> {
  const parentByPid = process.platform === "win32"
    ? await readWindowsProcessParents()
    : process.platform === "linux"
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

export function signalOwnedProcesses(
  pids: ReadonlyArray<number>,
  signal: NodeJS.Signals,
  signalProcess: (pid: number, signal: NodeJS.Signals) => void = (pid, nextSignal) => {
    process.kill(pid, nextSignal);
  }
): void {
  for (const pid of pids) {
    try {
      signalProcess(pid, signal);
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
  timeoutMs: number,
  processAlive: (pid: number) => boolean = isProcessAlive
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (childClosed() && pids.every((pid) => !processAlive(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return childClosed() && pids.every((pid) => !processAlive(pid));
}

export async function terminateWindowsProcessTree(
  pid: number,
  dependencies: WindowsProcessTreeTerminationDependencies = {}
): Promise<void> {
  const runTaskkill = dependencies.runTaskkill ?? runWindowsTaskkill;
  const processAlive = dependencies.isProcessAlive ?? isProcessAlive;
  const ownedPids = dependencies.ownedPids ?? [pid];
  try {
    await runTaskkill(pid);
  } catch (error) {
    const remaining = ownedPids.filter(processAlive);
    if (isWindowsTaskkillNotFound(error)) {
      if (remaining.length === 0) return;
      signalOwnedProcesses(
        remaining,
        "SIGKILL",
        dependencies.signalProcess
      );
      if (await waitForOwnedProcessesToClose(remaining, () => true, 250, processAlive)) return;
    }
    throw new Error(
      [
        "AUTHORITY_GIT_OBJECT_BATCH_TASKKILL_FAILED",
        `pid=${pid}`,
        `remaining=${remaining.join(",") || "none"}`,
        `exitCode=${commandFailureField(error, "code")}`,
        `stdout=${JSON.stringify(commandFailureOutput(error, "stdout"))}`,
        `stderr=${JSON.stringify(commandFailureOutput(error, "stderr"))}`,
        `failure=${failureMessage(error)}`
      ].join(";"),
      { cause: error }
    );
  }
}

async function readWindowsProcessParents(): Promise<ReadonlyMap<number, number>> {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }"
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 2_000
    }
  );
  return parseProcessParents(String(stdout));
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
  return parseProcessParents(String(stdout));
}

function parseProcessParents(output: string): ReadonlyMap<number, number> {
  const parents = new Map<number, number>();
  for (const line of output.split(/\r?\n/u)) {
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

function isWindowsTaskkillNotFound(error: unknown): boolean {
  return commandFailureField(error, "code") === 128;
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
