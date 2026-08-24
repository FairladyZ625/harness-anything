import { spawn,
  /* @gate-identity check-sync-subprocess/sync-subprocess-010 */
  spawnSync } from "node:child_process";
import type { CanonicalEventStore, TaskProjection } from "../../kernel/src/index.ts";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { PreparedRuntimeLaunch, RuntimeInstanceKind } from "./agent-runtime-instances.ts";
import { scrubProviderValue, type DispatchStreamWriter } from "./dispatch-stream.ts";
import { runtimeSpawnError } from "./runtime-spawn-errors.ts";
import { parseProviderFrame } from "./runtime-spawn-provider-frames.ts";
import type { ResumeProcessEvent, ResumeProcessObservation, RuntimeProcess } from "./runtime-spawn-types.ts";
import { exitNotificationTimeoutMs, providerErrorLimit, resumeAdmissionTimeoutMs } from "./runtime-spawner.ts";

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
export function terminateRuntimeProcess(child: ReturnType<typeof spawn>): void {
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

export function launchNative(input: PreparedRuntimeLaunch): RuntimeProcess {
  const command = nativeCommand(input),
    child = spawn(command.executablePath, command.args, {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: input.env,
      ...(process.platform === "win32" && command.executablePath.toLowerCase().endsWith("cmd.exe")
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdin.end(input.prompt);
  return {
    pid: child.pid ?? 0,
    onOutput: (listener) => {
      child.stdout.on("data", listener);
    },
    onErrorOutput: (listener) => {
      child.stderr.on("data", listener);
    },
    onExit: (listener) => {
      child.once("close", listener);
      child.once("error", () => listener(null));
    },
    terminate: () => {
      terminateRuntimeProcess(child);
    },
  };
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
