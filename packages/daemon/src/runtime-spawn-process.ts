import { spawn,
  /* @gate-identity check-sync-subprocess/sync-subprocess-010 */
  spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import {
  appendRuntimeWorkerRecord,
  readRuntimeWorkerChunk,
  scrubProviderValue,
  type DispatchStreamWriter,
} from "./dispatch-stream.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import type { ResumeProcessEvent, ResumeProcessObservation, RuntimeProcess } from "./runtime-spawn-types.ts";
import { exitNotificationTimeoutMs, providerErrorLimit, resumeAdmissionTimeoutMs } from "./runtime-spawner.ts";
import { runProcessTextAsync } from "./process-port.ts";

export function requiredRuntimeStore(input: { readonly store?: () => CanonicalEventStore }): CanonicalEventStore {
  if (!input.store)
    throw runtimeSpawnError("runtime_preconditions_unavailable", "Local runtime persistence is unavailable.");
  return input.store();
}

export function requiredRuntimeProjection(input: { readonly projection?: () => TaskProjection }): TaskProjection {
  if (!input.projection)
    throw runtimeSpawnError("runtime_preconditions_unavailable", "Local runtime projection is unavailable.");
  return input.projection();
}

// A resume receipt is an admission claim: the provider has accepted the old
// session, not merely that its executable started. Buffer the provider process
// until its structured stream binds the requested session, then replay every
// observed frame through the normal durable-session path.
export function observeResumeProcess(
  process: RuntimeProcess,
  kindId: RuntimeInstanceKind,
  expectedProviderSessionId: string,
): ResumeProcessObservation {
  let events: ResumeProcessEvent[] = [],
    sink: ((event: ResumeProcessEvent) => void) | null = null,
    buffer = "",
    stderr = "",
    failureText: string | null = null,
    settled = false,
    resolveReady!: () => void,
    rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    }),
    timer = setTimeout(
      () => rejectResume(`provider did not confirm the session within ${resumeAdmissionTimeoutMs}ms`, true),
      resumeAdmissionTimeoutMs,
    );
  timer.unref();
  const emit = (event: ResumeProcessEvent): void => {
    if (sink) sink(event);
    else events.push(event);
  };
  const rejectResume = (reason: string, terminate: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (terminate) process.terminate();
    rejectReady(
      runtimeSpawnError(
        "runtime_resume_failed",
        `${kindId} session ${expectedProviderSessionId} could not be resumed: ${reason}.`,
      ),
    );
  };
  process.onOutput((chunk) => {
    emit({ kind: "output", chunk });
    if (settled) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > providerErrorLimit) {
      rejectResume("provider emitted too much output before confirming the session", true);
      return;
    }
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const frame = parseProviderFrame(kindId, JSON.parse(line));
        if (frame.failureText) failureText = frame.failureText;
        if (!frame.sessionIdentity?.sessionId) continue;
        if (frame.sessionIdentity.sessionId !== expectedProviderSessionId) {
          rejectResume(`provider bound unexpected session ${frame.sessionIdentity.sessionId}`, true);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolveReady();
        return;
      } catch (error) {
        consumeKnownError(error);
      }
    }
  });
  process.onErrorOutput((chunk) => {
    emit({ kind: "error", chunk });
    if (settled || Buffer.byteLength(stderr) > providerErrorLimit) return;
    stderr += chunk;
    if (Buffer.byteLength(stderr) > providerErrorLimit) stderr = "";
  });
  process.onExit((code) => {
    emit({ kind: "exit", code });
    if (!settled) {
      const diagnostic = failureText ?? stderr.trim(),
        detail = diagnostic
          ? (scrubProviderValue(diagnostic) as string)
          : "provider exited before confirming the session";
      rejectResume(`${detail} (exit ${code === null ? "unknown" : String(code)})`, false);
    }
  });
  return {
    ready,
    activate: (handlers) => {
      sink = (event) => {
        if (event.kind === "output") handlers.output(event.chunk);
        else if (event.kind === "error") handlers.error(event.chunk);
        else handlers.exit(event.code);
      };
      const pending = events;
      events = [];
      for (const event of pending) sink(event);
    },
  };
}

// A runtime is not always the process we spawned. On Windows an executable discovered as a `.cmd`
// shim runs under cmd.exe, so the agent itself is a grandchild; SIGTERM there terminates only
// cmd.exe, and the surviving grandchild holds the inherited stdio pipes open, which keeps the
// daemon -- or a test process -- alive with a runtime it believes it stopped. taskkill /T ends the
// tree. Windows has no graceful signal to lose here: SIGTERM already terminates unconditionally.
export function terminateRuntimeProcess(child: Pick<ReturnType<typeof spawn>, "killed" | "pid" | "kill">): void {
  if (child.killed || child.pid === undefined) return;
  if (process.platform === "win32") {
    /* @gate-identity check-sync-subprocess/sync-subprocess-011 */
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

export function terminateRuntimePid(pid: number): void {
  if (!Number.isInteger(pid) || pid < 1) return;
  if (process.platform === "win32") {
    terminateRuntimeProcess({ killed: false, pid, kill: () => false });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (childProcessErrorCode(error) !== "ESRCH") throw error;
    consumeKnownError(error);
  }
}

type PosixProcessRow = {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly state: string;
};

async function readPosixProcessRows(): Promise<readonly PosixProcessRow[]> {
  const output = await runProcessTextAsync("ps", ["-axo", "pid=,ppid=,pgid=,stat="]);
  return output.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/u.exec(line);
    if (!match) return [];
    return [{ pid: Number(match[1]), parentPid: Number(match[2]), processGroupId: Number(match[3]), state: match[4]! }];
  });
}

function descendantProcessRows(rows: readonly PosixProcessRow[], rootPid: number): readonly PosixProcessRow[] {
  const selected = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (!selected.has(row.pid) && selected.has(row.parentPid)) {
      selected.add(row.pid);
      changed = true;
    }
  }
  return rows.filter((row) => selected.has(row.pid));
}

function signalRuntimeTargets(
  rows: readonly PosixProcessRow[],
  rootPid: number,
  ownProcessGroupId: number | null,
  signal: NodeJS.Signals,
): void {
  const groups = [...new Set(rows.map(({ processGroupId }) => processGroupId).filter((group) => group > 0))]
    .sort((left, right) => Number(left === rootPid) - Number(right === rootPid));
  for (const processGroupId of groups) {
    if (processGroupId === ownProcessGroupId) continue;
    try { process.kill(-processGroupId, signal); }
    catch (error) { if (childProcessErrorCode(error) !== "ESRCH") throw error; consumeKnownError(error); }
  }
  if (groups.includes(ownProcessGroupId ?? -1)) for (const { pid } of rows) {
    if (pid === process.pid) continue;
    try { process.kill(pid, signal); }
    catch (error) { if (childProcessErrorCode(error) !== "ESRCH") throw error; consumeKnownError(error); }
  }
}

async function survivingRuntimePids(pids: readonly number[]): Promise<readonly number[]> {
  const wanted = new Set(pids), rows = await readPosixProcessRows();
  return rows.filter(({ pid, state }) => wanted.has(pid) && !state.startsWith("Z")).map(({ pid }) => pid);
}

async function awaitRuntimeProcessExit(pids: readonly number[], timeoutMs: number): Promise<readonly number[]> {
  const deadline = Date.now() + timeoutMs;
  let survivors = await survivingRuntimePids(pids);
  while (survivors.length > 0 && Date.now() < deadline) {
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
    survivors = await survivingRuntimePids(pids);
  }
  return survivors;
}

export async function terminateRuntimeTree(rootDir: string, dispatchId: string, rootPid: number): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid < 1) return;
  if (process.platform === "win32") {
    terminateRuntimePid(rootPid);
    return;
  }
  let allRows: readonly PosixProcessRow[];
  try { allRows = await readPosixProcessRows(); }
  catch (error) { consumeKnownError(error); terminateRuntimePid(rootPid); return; }
  const rows = descendantProcessRows(allRows, rootPid), pids = rows.map(({ pid }) => pid),
    processGroupIds = [...new Set(rows.map(({ processGroupId }) => processGroupId))]
      .sort((left, right) => left - right),
    ownProcessGroupId = allRows.find(({ pid }) => pid === process.pid)?.processGroupId ?? null;
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "process_descendants",
    occurredAt: new Date().toISOString(),
    rootPid,
    pids,
    processGroupIds,
  });
  signalRuntimeTargets(rows, rootPid, ownProcessGroupId, "SIGTERM");
  let survivors = await awaitRuntimeProcessExit(pids, 500);
  if (survivors.length > 0) {
    signalRuntimeTargets(rows.filter(({ pid }) => survivors.includes(pid)), rootPid, ownProcessGroupId, "SIGKILL");
    survivors = await awaitRuntimeProcessExit(pids, 500);
  }
  appendRuntimeWorkerRecord(rootDir, dispatchId, {
    kind: "process_descendants_terminated",
    occurredAt: new Date().toISOString(),
    rootPid,
    survivorPids: survivors,
  });
  if (survivors.length > 0) throw runtimeSpawnError(
    "runtime_cancel_failed",
    `Runtime cancel left descendant processes alive: ${survivors.join(", ")}.`,
  );
}

export function runtimePidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return childProcessErrorCode(error) === "EPERM"; }
}

export function launchExitNotification(input: {
  readonly command: string;
  readonly cwd: string;
  readonly stream: Pick<DispatchStreamWriter, "appendExitNotification">;
  readonly payload: {
    readonly schema: "runtime-session-exited/v1";
    readonly runtimeSessionId: string;
    readonly outcome: "succeeded" | "failed" | "unknown" | "cancelled";
    readonly exitCode: number | null;
    readonly nextAction: string;
  };
  readonly now: () => string;
  readonly timeoutMs?: number;
}): void {
  const record = (value: Parameters<DispatchStreamWriter["appendExitNotification"]>[0]): void => {
    try {
      input.stream.appendExitNotification(value, input.now());
    } catch (error) {
      consumeKnownError(error);
    }
  };
  let child: ReturnType<typeof spawn>;
  try {
    const environment = exitNotificationEnvironment(),
      command = exitNotificationCommand(input.command, environment);
    child = spawn(command.executablePath, command.args, {
      cwd: input.cwd,
      env: environment,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    consumeKnownError(error);
    record({
      phase: "finished",
      started: false,
      exitCode: null,
      timedOut: false,
      errorCode: childProcessErrorCode(error),
    });
    return;
  }
  let started = false,
    settled = false,
    timedOut = false,
    timer: NodeJS.Timeout | undefined;
  const finish = (exitCode: number | null, errorCode?: string): void => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    record({
      phase: "finished",
      started,
      exitCode,
      timedOut,
      ...(errorCode ? { errorCode } : {}),
    });
  };
  child.once("spawn", () => {
    if (settled) return;
    started = true;
    record({
      phase: "started",
      started: true,
      exitCode: null,
      timedOut: false,
    });
    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminateRuntimeProcess(child);
      finish(null);
    }, input.timeoutMs ?? exitNotificationTimeoutMs);
    timer.unref();
  });
  child.once("error", (error) => finish(null, childProcessErrorCode(error)));
  child.once("close", (code) => finish(code));
  child.stdin?.on("error", (error) => consumeKnownError(error));
  child.stdin?.end(`${JSON.stringify(input.payload)}\n`);
  child.unref();
}

export function exitNotificationEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const names =
      process.platform === "win32"
        ? ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "TEMP", "TMP", "USERPROFILE"]
        : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "SHELL"],
    environment: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) environment[name] = source[name];
  return environment;
}

export function exitNotificationCommand(
  command: string,
  environment: NodeJS.ProcessEnv,
): {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly windowsVerbatimArguments: boolean;
} {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(command))
    return {
      executablePath: command,
      args: [],
      windowsVerbatimArguments: false,
    };
  return {
    executablePath: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", `""${command}""`],
    windowsVerbatimArguments: true,
  };
}

export function childProcessErrorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : "spawn_failed";
}

export function launchNative(
  input: PreparedRuntimeLaunch,
  persistence: { readonly rootDir: string; readonly dispatchId: string },
): RuntimeProcess {
  const command = nativeCommand(input);
  const workerHost = import.meta.url.endsWith(".js")
    ? "./runtime-worker-host.js"
    : "./runtime-worker-host.ts";
  const entry = fileURLToPath(new URL(workerHost, import.meta.url));
  const child = spawn(process.execPath, [entry, "--runtime-worker-host"], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
    env: process.env,
  });
  const pid = child.pid ?? 0;
  const observed = observeDispatchProcess(persistence.rootDir, persistence.dispatchId, pid);
  appendRuntimeWorkerRecord(persistence.rootDir, persistence.dispatchId, {
    kind: "process_started",
    occurredAt: new Date().toISOString(),
    pid,
  });
  child.stdin?.on("error", consumeKnownError);
  child.stdin?.end(JSON.stringify({
    ...persistence,
    executablePath: command.executablePath,
    args: command.args,
    cwd: input.cwd,
    env: input.env,
    prompt: input.prompt,
    windowsVerbatimArguments:
      process.platform === "win32" && command.executablePath.toLowerCase().endsWith("cmd.exe"),
  }));
  child.unref();
  return observed;
}

export function adoptNativeProcess(
  rootDir: string,
  dispatchId: string,
  pid: number,
  skipPersistedOutputRecords = 0,
): RuntimeProcess {
  return observeDispatchProcess(rootDir, dispatchId, pid, skipPersistedOutputRecords);
}

function observeDispatchProcess(
  rootDir: string,
  dispatchId: string,
  pid: number,
  skipPersistedOutputRecords = 0,
): RuntimeProcess {
  const outputs: Array<{ readonly chunk: string; readonly persisted: boolean }> = [];
  const errors: string[] = [];
  const decoder = new StringDecoder("utf8");
  let offset = 0;
  let skippedOutputRecords = 0;
  let buffer = "";
  let outputListener: ((chunk: string, persisted?: boolean) => void) | null = null;
  let errorListener: ((chunk: string) => void) | null = null;
  let exitListener: ((code: number | null) => void) | null = null;
  let exitCode: number | null = null;
  let exited = false;
  let released = false;
  const emitOutput = (chunk: string): void => {
    if (outputListener) outputListener(chunk, true);
    else outputs.push({ chunk, persisted: true });
  };
  const emitError = (chunk: string): void => {
    if (errorListener) errorListener(chunk);
    else errors.push(chunk);
  };
  const emitExit = (code: number | null): void => {
    if (exited) return;
    exited = true;
    exitCode = code;
    if (exitListener) exitListener(code);
  };
  const drain = (): void => {
    if (released) return;
    try {
      const bytes = readRuntimeWorkerChunk(rootDir, dispatchId, offset);
      if (bytes.length === 0) return;
      offset += bytes.length;
      buffer += decoder.write(bytes);
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const record = parseDispatchProcessRecord(line);
        if (record?.kind === "provider_event") {
          if (skippedOutputRecords < skipPersistedOutputRecords) skippedOutputRecords += 1;
          else emitOutput(`${JSON.stringify(record.event)}\n`);
        }
        else if (record?.kind === "provider_output_invalid") {
          if (skippedOutputRecords < skipPersistedOutputRecords) skippedOutputRecords += 1;
          else emitOutput(`${String(record.output)}\n`);
        }
        else if (record?.kind === "provider_stderr") emitError(String(record.chunk));
        else if (record?.kind === "process_exit") {
          emitExit(Number.isInteger(record.exitCode) ? Number(record.exitCode) : null);
        }
      }
    } catch (error) {
      consumeKnownError(error);
    }
  };
  const timer = setInterval(drain, 20);
  timer.unref();
  queueMicrotask(drain);
  return {
    pid,
    onOutput: (listener) => {
      outputListener = listener;
      for (const value of outputs.splice(0)) listener(value.chunk, value.persisted);
    },
    onErrorOutput: (listener) => {
      errorListener = listener;
      for (const value of errors.splice(0)) listener(value);
    },
    onExit: (listener) => {
      exitListener = listener;
      if (exited) queueMicrotask(() => listener(exitCode));
    },
    terminate: () => terminateRuntimePid(pid),
    terminateTree: () => terminateRuntimeTree(rootDir, dispatchId, pid),
    release: () => {
      released = true;
      clearInterval(timer);
    },
  };
}

function parseDispatchProcessRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

export function nativeCommand(input: PreparedRuntimeLaunch): {
  readonly executablePath: string;
  readonly args: readonly string[];
} {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/iu.test(input.executablePath))
    return { executablePath: input.executablePath, args: input.args };
  const command = `""${input.executablePath}" ${input.args.map(quoteWindowsArgument).join(" ")}"`;
  return {
    executablePath: input.env.ComSpec ?? input.env.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", command],
  };
}

export function quoteWindowsArgument(value: string): string {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}
