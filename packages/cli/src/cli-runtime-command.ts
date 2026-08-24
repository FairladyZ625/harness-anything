import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runAgentCreate } from "./cli-agent-create.ts";
import {
  renderRuntimeStatus,
  runRuntimeAuthCommand,
  runtimeRejected,
} from "./cli-runtime-auth.ts";
import { runRuntimeBatch } from "./cli-runtime-batch.ts";
import { waitForRuntime, waitForTaskDispatches } from "./cli-runtime-wait.ts";
import { runSquadRun } from "./cli-squad-run.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

export function isRuntimeFacadeCommand(command: ThinCommand): boolean {
  return (
    command.method.startsWith("repo.agentRuntime.") ||
    command.method.startsWith("repo.runtimeInstance.auth.")
  );
}

export async function runRuntimeFacadeCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void = (text) => process.stderr.write(text),
): Promise<JsonObject> {
  const action = command.action;
  if (command.method.startsWith("repo.runtimeInstance.auth."))
    return runRuntimeAuthCommand(command, writeActivity);
  if (action.kind === "runtime-batch")
    return runRuntimeBatch(command, writeActivity);
  if (action.kind === "squad-run") return runSquadRun(command, writeActivity);
  if (action.kind === "agent-create")
    return runAgentCreate(command, writeActivity);
  if (action.kind === "runtime-status") {
    if (action.wait === true)
      return typeof action.taskId === "string"
        ? waitForTaskDispatches(command, action.taskId)
        : waitForRuntime(
            command,
            String(action.runtimeSessionId),
            !command.json && action.noStream !== true,
            writeActivity,
          );
    const { wait: _wait, noStream: _noStream, ...readAction } = action,
      result = await runCommandThroughDaemon({
        ...command,
        action: readAction,
      });
    return result.ok === true
      ? {
          ...result,
          command: action.kind,
          summary: renderRuntimeStatus(result),
        }
      : result;
  }
  if (action.kind === "runtime-cancel") {
    const { noStream: _noStream, ...rpcAction } = action;
    const result = await runCommandThroughDaemon({
      ...command,
      action: rpcAction,
    });
    return result.ok === true
      ? {
          ...result,
          summary: `runtime-cancel: ${String(result.detail ?? "cancelled")}`,
        }
      : result;
  }
  let prompt: string | undefined;
  try {
    prompt =
      typeof action.prompt === "string"
        ? action.prompt
        : typeof action.promptFile === "string"
          ? readFileSync(
              path.resolve(command.rootDir, action.promptFile),
              "utf8",
            )
          : undefined;
  } catch (error) {
    return runtimeRejected(
      action.kind,
      "prompt_file_unreadable",
      `Could not read --prompt-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const {
      promptFile: _promptFile,
      noStream: _noStream,
      detach = false,
      ...spawnAction
    } = action,
    spawned = await runCommandThroughDaemon({
      ...command,
      action: {
        ...spawnAction,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(typeof action.promptFile === "string"
          ? { promptSource: action.promptFile }
          : {}),
        idempotencyKey: action.idempotencyKey ?? `runtime-cli-${randomUUID()}`,
      },
    });
  if (spawned.ok !== true || typeof spawned.runtimeSessionId !== "string")
    return spawned;
  if (detach === true) {
    const nextAction = `ha runtime status ${spawned.runtimeSessionId} --wait`;
    return {
      ...spawned,
      command: "runtime-run",
      outcome: "running",
      nextAction,
      summary: `runtime-run: detached ${String(spawned.dispatchId)}; next: ${nextAction}`,
      exitCode: 0,
    };
  }
  return waitForRuntime(
    command,
    spawned.runtimeSessionId,
    !command.json && action.noStream !== true,
    writeActivity,
    spawned,
  );
}
