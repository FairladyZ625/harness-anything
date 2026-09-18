import type { AgentRuntimeSessionResult } from "../../daemon/src/agent-runtime-contract.ts";
import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { cliErrorMessage } from "./cli-error.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import {
  consumeKnownError,
  openRuntimeStatusReader,
  runCommandThroughDaemon,
  streamRuntimeThroughDaemon,
} from "./daemon/client.ts";

type DaemonGone = { readonly kind: "daemon-gone"; readonly cause: string };
type DaemonStoppedByOperator = { readonly kind: "daemon-stopped"; readonly stoppedAt: string };
type DaemonWaitFailure = DaemonGone | DaemonStoppedByOperator;

const subscriptionReconnectAttemptLimit = 5;

/** Every terminal wait — one session, several sessions, or a task's dispatch set — is one
 * long-lived repo.agentRuntime.sessions.await request. The daemon owns the settle decision and
 * answers with the settled/in-flight/unavailable split plus the authoritative outcome and exit
 * code; this side only attaches the optional activity stream, retries the idempotent request
 * across daemon restarts, reports an operator stop honestly without reconnecting, and renders the
 * receipt. */
export async function waitForRuntimeSessions(
  command: ThinCommand,
  writeActivity: (text: string) => void,
  spawned?: JsonObject,
  target?: { readonly taskId: string; readonly dispatchId: string },
): Promise<JsonObject> {
  const action = command.action,
    runtimeSessionIds = Array.isArray(action.runtimeSessionIds) ? (action.runtimeSessionIds as readonly string[]) : [],
    taskIds = Array.isArray(action.taskIds) ? (action.taskIds as readonly string[]) : [],
    singleId = runtimeSessionIds.length === 1 ? runtimeSessionIds[0] : undefined;
  let detach: (() => void) | undefined,
    statusReader: Awaited<ReturnType<typeof openRuntimeStatusReader>> | undefined,
    lastKnown: AgentRuntimeSessionResult | undefined;
  try {
    if (singleId !== undefined) {
      // One capability probe decides whether an interactive stream can decorate the wait; the
      // daemon-side await is the settle authority either way.
      const initial = await readDaemonSubscription(
        async () => {
          statusReader ??= await openRuntimeStatusReader(command, singleId, target);
          return statusReader.read();
        },
        () => {
          statusReader?.close();
          statusReader = undefined;
        },
        operatorStoppedAt,
      );
      if (isDaemonStopped(initial)) return runtimeWaitFailureReceipt(initial, undefined, singleId, target, spawned);
      if (isDaemonGone(initial)) return runtimeDaemonGoneReceipt(initial, undefined, singleId, target, spawned);
      if (initial.ok !== true) return initial;
      lastKnown = initial as unknown as AgentRuntimeSessionResult;
      if (
        !command.json &&
        action.noStream !== true &&
        lastKnown.settlement === null &&
        lastKnown.session.attachCapability === "supported"
      )
        detach = await waitForStreamedRuntime(command, singleId, writeActivity);
    }
    const { noStream: _noStream, ...rpcAction } = action,
      result = await readDaemonSubscription(
        () =>
          // The wait is a parked read, not an operator launch: it must never spawn a daemon.
          runCommandThroughDaemon({ ...command, action: rpcAction }, () => undefined, { autostart: false }),
        () => undefined,
        operatorStoppedAt,
      );
    if (isDaemonStopped(result))
      return spawned || singleId
        ? runtimeWaitFailureReceipt(result, lastKnown, singleId ?? String(runtimeSessionIds[0] ?? ""), target, spawned)
        : daemonStoppedReceipt(
            "runtime-status",
            "unknown",
            {
              ...(taskIds.length > 0 ? { taskIds } : { runtimeSessionIds }),
            },
            result.stoppedAt,
          );
    if (isDaemonGone(result))
      return spawned || singleId
        ? runtimeDaemonGoneReceipt(result, lastKnown, singleId ?? String(runtimeSessionIds[0] ?? ""), target, spawned)
        : daemonGoneReceipt("runtime-status", result.cause, "unknown", {
            ...(taskIds.length > 0 ? { taskIds } : { runtimeSessionIds }),
          });
    return runtimeAwaitReceipt(result, spawned);
  } finally {
    statusReader?.close();
    detach?.();
  }
}

/** The operator's stop marker, when present, is the honest verdict for a lost connection: the
 * daemon is not coming back until the operator says so, and reconnecting would only burn the
 * budget before saying the same thing. */
async function operatorStoppedAt(): Promise<string | null> {
  const { readDaemonStoppedAt } = await import("../../daemon/src/client/daemon-autostart.ts"),
    { daemonIdFromEnv, daemonUserRoot } = await import("../../daemon/src/client/local-daemon-target.ts");
  return readDaemonStoppedAt(daemonUserRoot(), daemonIdFromEnv());
}

/** The daemon receipt is already authoritative; the only decoration left is the runtime-run
 * envelope around a spawned session's verdict. */
function runtimeAwaitReceipt(result: JsonObject, spawned: JsonObject | undefined): JsonObject {
  if (result.ok !== true || !spawned) return result;
  const sessions = Array.isArray(result.sessions) ? result.sessions : [],
    winner = sessions[0] as Record<string, unknown> | undefined,
    winnerCode = typeof winner?.code === "string" ? winner.code : null;
  return {
    ...result,
    command: "runtime-run",
    spawn: spawned,
    ...(typeof winner?.runtimeSessionId === "string" ? { runtimeSessionId: winner.runtimeSessionId } : {}),
    ...(typeof winner?.reason === "string" ? { code: winnerCode, reason: winner.reason } : {}),
    summary:
      (typeof winner?.resultText === "string" && winner.resultText) ||
      (typeof winner?.reason === "string" && winner.reason) ||
      `runtime-run: ${String(result.outcome)}`,
  };
}

/** The attach stream renders live activity while the daemon await runs. Its terminal signal no
 * longer drives the wait — settlement is read back by the daemon — so a lost stream only earns a
 * note, never a fallback poll. */
async function waitForStreamedRuntime(
  command: ThinCommand,
  runtimeSessionId: string,
  writeActivity: (text: string) => void,
): Promise<(() => void) | undefined> {
  try {
    return await streamRuntimeThroughDaemon(
      command,
      runtimeSessionId,
      (value) => renderRuntimeFrames(value, writeActivity),
      () => writeActivity("[stream] lost; the daemon-side wait continues\n"),
    );
  } catch (error) {
    consumeKnownError(error);
    writeActivity(`[stream] ${cliErrorMessage(error)}\n`);
    return undefined;
  }
}

function runtimeDaemonGoneReceipt(
  gone: DaemonGone,
  current: JsonObject | AgentRuntimeSessionResult | undefined,
  runtimeSessionId: string,
  target: { readonly taskId: string; readonly dispatchId: string } | undefined,
  spawned: JsonObject | undefined,
): JsonObject {
  const runtime = current as unknown as AgentRuntimeSessionResult | undefined,
    status = runtime?.settlement?.outcome ?? (runtime?.session ? "running" : "unknown"),
    commandName = spawned ? "runtime-run" : "runtime-status";
  return daemonGoneReceipt(commandName, gone.cause, status, {
    runtimeSessionId,
    ...(target ?? {}),
    ...(spawned ? { spawn: spawned } : {}),
    lastKnownDispatch: lastKnownRuntimeDispatch(runtimeSessionId, target, runtime, status),
  });
}

function runtimeWaitFailureReceipt(
  stopped: DaemonStoppedByOperator,
  current: JsonObject | AgentRuntimeSessionResult | undefined,
  runtimeSessionId: string,
  target: { readonly taskId: string; readonly dispatchId: string } | undefined,
  spawned: JsonObject | undefined,
): JsonObject {
  const runtime = current as unknown as AgentRuntimeSessionResult | undefined,
    status = runtime?.settlement?.outcome ?? (runtime?.session ? "running" : "unknown"),
    commandName = spawned ? "runtime-run" : "runtime-status";
  return daemonStoppedReceipt(
    commandName,
    status,
    {
      runtimeSessionId,
      ...(target ?? {}),
      ...(spawned ? { spawn: spawned } : {}),
      lastKnownDispatch: lastKnownRuntimeDispatch(runtimeSessionId, target, runtime, status),
    },
    stopped.stoppedAt,
  );
}

function daemonStoppedReceipt(
  command: string,
  lastKnownStatus: string,
  details: JsonObject,
  stoppedAt: string,
): JsonObject {
  const hint =
    `The daemon was stopped by the operator at ${stoppedAt}. Run \`ha daemon start --service\` to start it, ` +
    "then inspect the recorded dispatch status before deciding whether to wait again.";
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: command,
    outcome: "op_rejected",
    origin: "cli",
    code: "daemon_stopped_by_operator",
    evidence: "rejection:daemon_stopped_by_operator",
    ...details,
    error: { code: "daemon_stopped_by_operator", hint },
    nextAction: hint,
    summary: `${command}: daemon_stopped_by_operator; last known dispatch status ${lastKnownStatus}`,
    exitCode: 1,
  };
}

export async function waitForSquadRun(command: ThinCommand, squadRunId: string): Promise<JsonObject> {
  const readCommand = {
    ...command,
    method: "repo.task.read",
    action: { kind: "squad-status", squadRunId },
  };
  for (;;) {
    const status = await readDaemonSubscription(() =>
      runCommandThroughDaemon(readCommand, () => undefined, { autostart: false }),
    );
    if (isDaemonStopped(status)) return daemonStoppedReceipt("squad-run", "running", { squadRunId }, status.stoppedAt);
    if (isDaemonGone(status))
      return daemonGoneReceipt("squad-run", status.cause, "running", { squadRunId }, `squad-run ${squadRunId}`);
    if (status.ok !== true) return status;
    // The daemon stamps outcome/exitCode once the run's phase is terminal; the transport only
    // waits for that verdict to appear.
    if (typeof status.outcome === "string" && Number.isInteger(status.exitCode))
      return { ...status, command: "squad-run" };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function readDaemonSubscription(
  read: () => Promise<JsonObject>,
  reset: () => void = () => undefined,
  stopped: () => Promise<string | null> = async () => null,
): Promise<JsonObject | DaemonWaitFailure> {
  let attempt = 0;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      consumeKnownError(error);
      reset();
      const stoppedAt = await stopped();
      if (stoppedAt !== null) return { kind: "daemon-stopped", stoppedAt };
      if (!recoverableSubscriptionFailure(error)) throw error;
      if (attempt >= subscriptionReconnectAttemptLimit)
        return {
          kind: "daemon-gone",
          cause: `reconnect budget exhausted after ${String(attempt)} attempts: ${cliErrorMessage(error)}`,
        };
      await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt++, 5_000)));
    }
  }
}

function recoverableSubscriptionFailure(error: unknown): boolean {
  const code =
      error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
        ? String((error as { readonly code: string }).code)
        : null,
    message = cliErrorMessage(error);
  return (
    ["daemon_response_timeout", "daemon_closed", "ECONNREFUSED", "ECONNRESET", "ENOENT"].includes(String(code)) ||
    message === "daemon_unavailable" ||
    message === "daemon_stream_unavailable"
  );
}

function isDaemonGone(value: JsonObject | DaemonWaitFailure): value is DaemonGone {
  return "kind" in value && value.kind === "daemon-gone";
}

function isDaemonStopped(value: JsonObject | DaemonWaitFailure): value is DaemonStoppedByOperator {
  return "kind" in value && value.kind === "daemon-stopped";
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
    `The daemon connection could not be restored within its reconnect budget. ` +
    `Last known dispatch status: ${lastKnownStatus}. ` +
    "Restart the daemon, then inspect the recorded status before deciding whether to run again.";
  return {
    schema: "command-receipt/v2",
    ok: false,
    command: command,
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
