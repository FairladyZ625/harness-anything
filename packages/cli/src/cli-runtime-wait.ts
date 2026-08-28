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

type DaemonGone = { readonly kind: "daemon-gone"; readonly cause: string };
type RuntimeStreamSignal = "terminal" | "lost";

const fallbackPollBaseMs = 500,
  fallbackPollMaxMs = 2_000,
  settlementWaitMs = 5_000;

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
    streamAttempted = false,
    finishAfterRead = false,
    fallbackProgress: string | undefined,
    fallbackDelayMs = fallbackPollBaseMs,
    exitedAt: number | undefined;
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
      if (isDaemonGone(next)) {
        const runtime = current as unknown as AgentRuntimeSessionResult | undefined,
          status = runtime?.session.activity.outcome ?? (runtime?.session ? "running" : "unknown"),
          commandName = spawned ? "runtime-run" : "runtime-status";
        return daemonGoneReceipt(commandName, next.cause, status, {
          runtimeSessionId,
          ...(target ?? {}),
          ...(spawned ? { spawn: spawned } : {}),
          lastKnownDispatch: lastKnownRuntimeDispatch(runtimeSessionId, target, runtime, status),
        });
      }
      if (next.ok !== true) return next;
      current = next;
      const session = (current as unknown as AgentRuntimeSessionResult).session;
      if (session.activity.outcome !== null || finishAfterRead) break;
      if (stream && !streamAttempted && session.attachCapability === "supported") {
        streamAttempted = true;
        let streamAttached = false,
          resolveStreamSignal: (signal: RuntimeStreamSignal) => void = () => undefined;
        const streamSignal = new Promise<RuntimeStreamSignal>((resolve) => {
          resolveStreamSignal = resolve;
        });
        try {
          detach = await streamRuntimeThroughDaemon(
            command,
            runtimeSessionId,
            (value) => {
              renderRuntimeFrames(value, writeActivity);
              streamAttached ||= runtimeStreamAttached(value);
              const signal = runtimeStreamWakeSignal(value);
              if (signal) resolveStreamSignal(signal);
            },
            () => resolveStreamSignal("lost"),
          );
        } catch (error) {
          consumeKnownError(error);
          writeActivity(`[stream] ${error instanceof Error ? error.message : String(error)}\n`);
        }
        if (streamAttached) {
          const signal = await streamSignal;
          finishAfterRead = signal === "terminal";
          continue;
        }
      }
      if (session.liveness === "exited") {
        exitedAt ??= Date.now();
        if (Date.now() - exitedAt >= settlementWaitMs) break;
      } else exitedAt = undefined;
      const progress = runtimePollProgress(session);
      if (progress !== fallbackProgress) {
        fallbackProgress = progress;
        fallbackDelayMs = fallbackPollBaseMs;
      } else fallbackDelayMs = Math.min(fallbackDelayMs * 2, fallbackPollMaxMs);
      await new Promise((resolve) => setTimeout(resolve, fallbackDelayMs));
    }
  } finally {
    statusReader?.close();
    detach?.();
  }
  const result = current as unknown as AgentRuntimeSessionResult,
    text = result.result?.text ?? "",
    outcome = result.session.activity.outcome ?? "unknown",
    settlementFailed =
      result.session.activity.outcome === null ||
      (outcome === "unknown" && result.session.activity.reasonCode !== undefined),
    commandName = spawned ? "runtime-run" : "runtime-status",
    providerExit = Number.isInteger(result.session.activity.exitCode),
    failureCode = settlementFailed ? "runtime_settlement_failed" : providerExit ? "provider_exit" : "runtime_failed",
    reason =
      outcome === "succeeded"
        ? null
        : text ||
          (settlementFailed
            ? "runtime_settlement_failed: daemon reported the runtime exited but no terminal outcome became visible."
            : providerExit
              ? `Provider exited with code ${String(result.session.activity.exitCode)} without a diagnostic.`
              : `${commandName}: ${outcome}`);
  return {
    ...current,
    command: commandName,
    outcome,
    runtimeSessionId,
    ...(spawned ? { spawn: spawned } : {}),
    ...(reason ? { code: failureCode, reason } : {}),
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
    if (isDaemonGone(next)) {
      const dispatches = Array.isArray(current?.dispatches) ? current.dispatches : [],
        rows = `${dispatches.length} row${dispatches.length === 1 ? "" : "s"}`;
      return daemonGoneReceipt(
        "runtime-status",
        next.cause,
        rows,
        { taskId, lastKnownDispatches: dispatches },
        `runtime-status task ${taskId}`,
      );
    }
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt++, 5_000)));
    }
  }
}

function recoverableSubscriptionFailure(error: unknown): boolean {
  const code =
      error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
        ? String((error as { readonly code: string }).code)
        : null,
    message = error instanceof Error ? error.message : String(error);
  return (
    ["daemon_response_timeout", "daemon_closed", "ECONNREFUSED", "ECONNRESET", "ENOENT"].includes(String(code)) ||
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

function lastKnownRuntimeDispatch(
  runtimeSessionId: string,
  target: { readonly taskId: string; readonly dispatchId: string } | undefined,
  current: AgentRuntimeSessionResult | undefined,
  status: string,
): JsonObject | null {
  const session = current?.session;
  if (!session) return null;
  const activity = session.activity,
    attempt = session.attemptChain?.attempts.find((candidate) => candidate.runtimeSessionId === runtimeSessionId),
    association = session.associations[0];
  return {
    taskId: target?.taskId ?? association?.taskId ?? null,
    dispatchId: target?.dispatchId ?? attempt?.dispatchId ?? null,
    runtimeSessionId,
    status,
    liveness: session.liveness,
    outcome: activity.outcome ?? null,
    exitCode: activity.exitCode ?? null,
    classification: attempt?.classification ?? null,
    fallbackState: attempt?.fallbackState ?? null,
  };
}

function daemonGoneReceipt(
  command: string,
  cause: string,
  lastKnownStatus: string,
  details: JsonObject,
  summaryCommand = command,
): JsonObject {
  const hint =
    `The daemon process and socket are gone. Last known dispatch status: ${lastKnownStatus}. ` +
    "Restart the daemon, then inspect the recorded status before deciding whether to run again.";
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "op_rejected",
    origin: "cli",
    code: "daemon_gone",
    evidence: "rejection:daemon_gone",
    ...details,
    error: { code: "daemon_gone", hint, cause },
    nextAction: hint,
    summary: `${summaryCommand}: daemon_gone; last known dispatch status ${lastKnownStatus}`,
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

function runtimeStreamAttached(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === true && ["attached", "gap"].includes(String(record.status));
}

function runtimeStreamWakeSignal(value: unknown): RuntimeStreamSignal | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "exit") return "terminal";
  if (record.type === "gap" || record.status === "gap") return "lost";
  if (Array.isArray(record.events))
    for (const event of record.events) {
      const signal = runtimeStreamWakeSignal(event);
      if (signal) return signal;
    }
  return null;
}

function runtimePollProgress(session: AgentRuntimeSessionResult["session"]): string {
  return [session.liveness, session.semanticState ?? "", session.streamCursor, session.activity.outcome ?? ""].join(
    "\0",
  );
}
