import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runAgentCreate } from "./cli-agent-create.ts";
import { renderRuntimeStatus, runRuntimeAuthCommand } from "./cli-runtime-auth.ts";
import { runRuntimeBatch } from "./cli-runtime-batch.ts";
import { waitForRuntime, waitForTaskDispatches } from "./cli-runtime-wait.ts";
import { runSquadRun } from "./cli-squad-run.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

export function isRuntimeFacadeCommand(command: ThinCommand): boolean {
  return (
    command.action.kind === "squad-run" ||
    command.method.startsWith("repo.agentRuntime.") ||
    command.method.startsWith("repo.runtimeInstance.auth.")
  );
}

export async function runRuntimeFacadeCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void = (text) => process.stderr.write(text),
): Promise<JsonObject> {
  const action = command.action;
  if (command.method.startsWith("repo.runtimeInstance.auth.")) return runRuntimeAuthCommand(command, writeActivity);
  if (action.kind === "runtime-batch") return runRuntimeBatch(command, writeActivity);
  if (action.kind === "squad-run") return runSquadRun(command, writeActivity);
  if (action.kind === "agent-create") return runAgentCreate(command, writeActivity);
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
  const { noStream: _noStream, detach = false, ...spawnAction } = action,
    spawned = await runCommandThroughDaemon({
      ...command,
      action: {
        ...spawnAction,
        idempotencyKey: action.idempotencyKey ?? `runtime-cli-${randomUUID()}`,
      },
    });
  if (spawned.ok !== true || typeof spawned.runtimeSessionId !== "string") return spawned;
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
    typeof action.taskId === "string" && typeof spawned.dispatchId === "string"
      ? { taskId: action.taskId, dispatchId: spawned.dispatchId }
      : undefined,
  );
}
