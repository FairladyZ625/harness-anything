import type { AgentRuntimeSessionResult } from "../../daemon/src/agent-runtime-contract.ts";
import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import {
  consumeKnownError,
  openRuntimeStatusReader,
  resolveLocalDaemonTarget,
  runCommandThroughDaemon,
  streamRuntimeThroughDaemon,
} from "./daemon/client.ts";

const reconnectBaseDelayMs = 250,
  reconnectMaxDelayMs = 5_000;

interface DaemonGone {
  readonly kind: "daemon-gone";
  readonly cause: string;
}

export async function waitForRuntime(
  command: ThinCommand,
  runtimeSessionId: string,
  stream: boolean,
  writeActivity: (text: string) => void,
  spawned?: JsonObject,
  target?: { readonly taskId: string; readonly dispatchId: string },
): Promise<JsonObject> {
  let statusReader: Awaited<ReturnType<typeof openRuntimeStatusReader>> | undefined;
  let current: JsonObject | undefined,
    detach: (() => void) | undefined,
    streamStarted = false;
  try {
    for (;;) {
      const next = await readDaemonSubscription(
        command,
        async () => {
          statusReader ??= await openRuntimeStatusReader(command, runtimeSessionId, target);
          return statusReader.read();
        },
        () => {
          statusReader?.close();
          statusReader = undefined;
        },
      );
      if (isDaemonGone(next))
        return runtimeDaemonGone(
          runtimeSessionId,
          spawned,
          target,
          current as unknown as AgentRuntimeSessionResult | undefined,
          next.cause,
        );
      if (next.ok !== true) return next;
      current = next;
      if (stream && !streamStarted) {
        streamStarted = true;
        try {
          detach = await streamRuntimeThroughDaemon(command, runtimeSessionId, (value) =>
            renderRuntimeFrames(value, writeActivity),
          );
        } catch (error) {
          consumeKnownError(error);
          writeActivity(`[stream] ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
      if ((current as unknown as AgentRuntimeSessionResult).session.activity.outcome !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    statusReader?.close();
    detach?.();
  }
  const result = current as unknown as AgentRuntimeSessionResult,
    outcome = result.session.activity.outcome!,
    text = result.result?.text ?? "",
    commandName = spawned ? "runtime-run" : "runtime-status",
    providerExit = Number.isInteger(result.session.activity.exitCode),
    reason =
      outcome === "succeeded"
        ? null
        : text ||
          (providerExit
            ? `Provider exited with code ${String(result.session.activity.exitCode)} without a diagnostic.`
            : `${commandName}: ${outcome}`);
  return {
    ...current,
    command: commandName,
    outcome,
    runtimeSessionId,
    ...(spawned ? { spawn: spawned } : {}),
    ...(reason ? { code: providerExit ? "provider_exit" : "runtime_failed", reason } : {}),
    summary: text || reason || `${commandName}: ${outcome}`,
    exitCode: outcome === "succeeded" ? 0 : 1,
  };
}

export async function waitForTaskDispatches(command: ThinCommand, taskId: string): Promise<JsonObject> {
  const readCommand = {
    ...command,
    method: "repo.task.dispatches",
    action: { kind: "task-dispatches", taskId },
  };
  let current: JsonObject | undefined;
  for (;;) {
    const next = await readDaemonSubscription(command, () =>
      runCommandThroughDaemon(readCommand, () => undefined, { autostart: false }),
    );
    if (isDaemonGone(next)) return taskDispatchDaemonGone(taskId, current, next.cause);
    current = next;
    if (current.ok !== true) return current;
    if (current.status !== "pending" && taskDispatchesSettled(current)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const dispatches: readonly unknown[] = Array.isArray(current.dispatches) ? current.dispatches : [],
    finalDispatches = dispatches.filter(
      (row: unknown) => (row as Record<string, unknown>).fallbackState !== "dispatched",
    ),
    noDispatches = finalDispatches.length === 0,
    cancelled = finalDispatches.some((row: unknown) => (row as Record<string, unknown>).status === "cancelled"),
    lost = finalDispatches.some((row: unknown) => {
      const status = row && typeof row === "object" ? (row as Record<string, unknown>).status : undefined;
      return status === "lost";
    }),
    failed = finalDispatches.some((row: unknown) => {
      const status = row && typeof row === "object" ? (row as Record<string, unknown>).status : undefined;
      return status === "failed";
    }),
    outcome = noDispatches
      ? "unknown"
      : lost || finalDispatches.some((row: unknown) => (row as Record<string, unknown>).status === "unknown")
        ? "unknown"
        : failed
          ? "failed"
          : cancelled
            ? "cancelled"
            : "succeeded";
  return {
    ...current,
    command: "runtime-status",
    taskId,
    outcome,
    summary: [
      `runtime-status task ${taskId}:`,
      `${dispatches.length} dispatch${dispatches.length === 1 ? "" : "es"}`,
      outcome,
    ].join(" "),
    exitCode: outcome === "succeeded" ? 0 : 1,
  };
}

async function readDaemonSubscription(
  command: ThinCommand,
  read: () => Promise<JsonObject>,
  reset: () => void = () => undefined,
): Promise<JsonObject | DaemonGone> {
  let attempt = 0;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      consumeKnownError(error);
      reset();
      if (!recoverableSubscriptionFailure(error)) throw error;
      if (await daemonGone(command))
        return { kind: "daemon-gone", cause: error instanceof Error ? error.message : String(error) };
      await new Promise((resolve) => setTimeout(resolve, reconnectDelayMs(attempt++)));
    }
  }
}

function reconnectDelayMs(attempt: number): number {
  return Math.min(reconnectBaseDelayMs * 2 ** attempt, reconnectMaxDelayMs);
}

function recoverableSubscriptionFailure(error: unknown): boolean {
  const code =
      error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
        ? String((error as { readonly code: string }).code)
        : null,
    message = error instanceof Error ? error.message : String(error);
  return (
    ["daemon_response_timeout", "daemon_closed", "ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "ETIMEDOUT"].includes(
      String(code),
    ) ||
    message === "daemon_unavailable" ||
    message === "daemon_stream_unavailable"
  );
}

async function daemonGone(command: ThinCommand): Promise<boolean> {
  const target = resolveLocalDaemonTarget({ rootDir: command.rootDir, repoIdOverride: command.repoId }),
    { daemonProcessAlive, daemonSocketProbe, readDaemonPid } = await import("../../daemon/src/daemon-singleton.ts"),
    pid = readDaemonPid(target.userRoot, target.daemonId),
    livePid = pid !== null && daemonProcessAlive(pid),
    liveSocket = await daemonSocketProbe(target.socketPath);
  return !livePid && !liveSocket;
}

function isDaemonGone(value: JsonObject | DaemonGone): value is DaemonGone {
  return "kind" in value && value.kind === "daemon-gone";
}

function runtimeDaemonGone(
  runtimeSessionId: string,
  spawned: JsonObject | undefined,
  target: { readonly taskId: string; readonly dispatchId: string } | undefined,
  current: AgentRuntimeSessionResult | undefined,
  cause: string,
): JsonObject {
  const session = current?.session,
    activity = session?.activity,
    attempts = session?.attemptChain?.attempts ?? [],
    attempt = attempts.find((candidate) => candidate.runtimeSessionId === runtimeSessionId),
    association = session?.associations[0],
    status = activity?.outcome ?? (session ? "running" : "unknown"),
    lastKnownDispatch = session
      ? {
          taskId: target?.taskId ?? association?.taskId ?? null,
          dispatchId: target?.dispatchId ?? attempt?.dispatchId ?? null,
          runtimeSessionId,
          status,
          liveness: session.liveness,
          outcome: activity?.outcome ?? null,
          exitCode: activity?.exitCode ?? null,
          classification: attempt?.classification ?? null,
          fallbackState: attempt?.fallbackState ?? null,
        }
      : null,
    commandName = spawned ? "runtime-run" : "runtime-status",
    hint =
      `The daemon process and socket are gone. Last known dispatch status: ${status}. ` +
      "Restart the daemon, then inspect the dispatch before deciding whether to run it again.";
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: commandName,
    outcome: "op_rejected",
    origin: "cli",
    code: "daemon_gone",
    evidence: "rejection:daemon_gone",
    runtimeSessionId,
    ...(target ?? {}),
    ...(spawned ? { spawn: spawned } : {}),
    lastKnownDispatch,
    error: { code: "daemon_gone", hint, cause },
    nextAction: hint,
    summary: `${commandName}: daemon_gone; last known dispatch status ${status}`,
    exitCode: 1,
  };
}

function taskDispatchDaemonGone(taskId: string, current: JsonObject | undefined, cause: string): JsonObject {
  const dispatches = Array.isArray(current?.dispatches) ? current.dispatches : [],
    hint =
      `The daemon process and socket are gone. ${dispatches.length} last-known task dispatch status ` +
      `row${dispatches.length === 1 ? " is" : "s are"} attached. ` +
      "Restart the daemon, then inspect the task dispatches before deciding whether to run them again.";
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: "runtime-status",
    outcome: "op_rejected",
    origin: "cli",
    code: "daemon_gone",
    evidence: "rejection:daemon_gone",
    taskId,
    lastKnownDispatches: dispatches,
    error: { code: "daemon_gone", hint, cause },
    nextAction: hint,
    summary:
      `runtime-status task ${taskId}: daemon_gone; ` +
      `${dispatches.length} last-known dispatch status row${dispatches.length === 1 ? "" : "s"}`,
    exitCode: 1,
  };
}

function taskDispatchesSettled(value: JsonObject): boolean {
  if (!Array.isArray(value.dispatches)) return false;
  const rows = value.dispatches as readonly unknown[],
    dispatchIds = rows.flatMap((row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      typeof (row as Record<string, unknown>).dispatchId === "string"
        ? [String((row as Record<string, unknown>).dispatchId)]
        : [],
    );
  return rows.every((row: unknown) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const record = row as Record<string, unknown>,
      status = String(record.status);
    if (record.fallbackState === "scheduled") return false;
    if (
      record.fallbackState === "dispatched" &&
      (typeof record.nextDispatchId !== "string" || !dispatchIds.includes(record.nextDispatchId))
    )
      return false;
    if (["succeeded", "failed", "cancelled", "lost"].includes(status)) return true;
    // A just-exited process can briefly have status=unknown while its outcome event is
    // still being projected. Only an explicit unknown outcome is terminal.
    return status === "unknown" && record.outcome === "unknown";
  });
}

export function renderRuntimeFrames(value: unknown, write: (text: string) => void): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.events)) {
    for (const event of record.events) renderRuntimeFrames(event, write);
    return;
  }
  if (record.type === "activity" && typeof record.content === "string")
    write(`[${String(record.activity)}] ${record.content}\n`);
}
