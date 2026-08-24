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
): Promise<JsonObject> {
  const readCommand = {
      ...command,
      method: "repo.agentRuntime.sessions.read",
      action: { kind: "runtime-status", runtimeSessionId },
    },
    read = () => runCommandThroughDaemon(readCommand),
    attaching = stream
      ? streamRuntimeThroughDaemon(command, runtimeSessionId, (value) =>
          renderRuntimeFrames(value, writeActivity),
        ).then(
          (detach) => ({ detach }),
          (error: unknown) => ({ error }),
        )
      : undefined;
  let current = await read();
  if (current.ok !== true) {
    const attached = await attaching;
    if (attached && "detach" in attached) attached.detach();
    return current;
  }
  let detach: (() => void) | undefined;
  if (attaching) {
    const attached = await attaching;
    if ("detach" in attached) detach = attached.detach;
    else
      try {
        detach = await streamRuntimeThroughDaemon(
          command,
          runtimeSessionId,
          (value) => renderRuntimeFrames(value, writeActivity),
        );
      } catch (error) {
        consumeKnownError(error);
        writeActivity(
          `[stream] ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
  }
  let statusReader:
    | Awaited<ReturnType<typeof openRuntimeStatusReader>>
    | undefined;
  if (
    (current as unknown as AgentRuntimeSessionResult).session.activity
      .outcome === null
  )
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
    while (
      (current as unknown as AgentRuntimeSessionResult).session.activity
        .outcome === null
    ) {
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
    ...(reason
      ? { code: providerExit ? "provider_exit" : "runtime_failed", reason }
      : {}),
    summary: text || reason || `${commandName}: ${outcome}`,
    exitCode: outcome === "succeeded" ? 0 : 1,
  };
}

export function renderRuntimeFrames(
  value: unknown,
  write: (text: string) => void,
): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.events)) {
    for (const event of record.events) renderRuntimeFrames(event, write);
    return;
  }
  if (record.type === "activity" && typeof record.content === "string")
    write(`[${String(record.activity)}] ${record.content}\n`);
}
