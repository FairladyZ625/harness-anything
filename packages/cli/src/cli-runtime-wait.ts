import type { AgentRuntimeSessionResult } from "../../daemon/src/agent-runtime-contract.ts";
import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import {
  consumeKnownError,
  openRuntimeStatusReader,
  runCommandThroughDaemon,
  streamRuntimeThroughDaemon,
} from "./daemon/client.ts";

export async function waitForRuntime(
  command: ThinCommand,
  runtimeSessionId: string,
  stream: boolean,
  writeActivity: (text: string) => void,
  spawned?: JsonObject,
  target?: { readonly taskId: string; readonly dispatchId: string },
): Promise<JsonObject> {
  const readCommand = {
      ...command,
      method: "repo.agentRuntime.sessions.read",
      action: {
        kind: "runtime-status",
        ...(target ? target : { runtimeSessionId }),
      },
    },
    read = () => runCommandThroughDaemon(readCommand);
  let current = await read();
  let detach: (() => void) | undefined;
  if (current.ok !== true) return current;
  if (stream)
    try {
      detach = await streamRuntimeThroughDaemon(command, runtimeSessionId, (value) =>
        renderRuntimeFrames(value, writeActivity),
      );
    } catch (error) {
      consumeKnownError(error);
      writeActivity(`[stream] ${error instanceof Error ? error.message : String(error)}\n`);
    }
  let statusReader: Awaited<ReturnType<typeof openRuntimeStatusReader>> | undefined;
  if ((current as unknown as AgentRuntimeSessionResult).session.activity.outcome === null)
    try {
      statusReader = await openRuntimeStatusReader(command, runtimeSessionId);
    } catch (error) {
      consumeKnownError(error);
    }
  const readNext = async (): Promise<JsonObject> => {
    if (!statusReader) return read();
    try {
      return await statusReader.read();
    } catch (error) {
      consumeKnownError(error);
      statusReader.close();
      statusReader = undefined;
      return read();
    }
  };
  try {
    while ((current as unknown as AgentRuntimeSessionResult).session.activity.outcome === null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = await readNext();
      if (current.ok !== true) return current;
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
  let current = await runCommandThroughDaemon(readCommand);
  if (current.ok !== true) return current;
  while (current.status === "pending" || !taskDispatchesSettled(current)) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    current = await runCommandThroughDaemon(readCommand);
    if (current.ok !== true) return current;
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
