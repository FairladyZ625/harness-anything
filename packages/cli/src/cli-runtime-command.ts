import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import { renderRuntimeStatus, runRuntimeAuthCommand } from "./cli-runtime-auth.ts";
import { runRuntimeBatch } from "./cli-runtime-batch.ts";
import { detachedWaitGuidance, waitForRuntimeSessions, waitForSquadRun } from "./cli-runtime-wait.ts";
import { runSquadRun } from "./cli-squad-run.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { randomUUID } from "node:crypto";

export function isRuntimeFacadeCommand(command: ThinCommand): boolean {
  return (
    command.action.kind === "squad-run" ||
    (command.action.kind === "squad-status" && command.action.wait === true) ||
    command.method.startsWith("repo.agentRuntime.") ||
    command.method.startsWith("repo.runtimeInstance.auth.")
  );
}

export async function runRuntimeFacadeCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void = (text) => process.stderr.write(text),
  request: (command: ThinCommand) => Promise<JsonObject> = runCommandThroughDaemon,
): Promise<JsonObject> {
  if (command.action.claimNext === true) {
    const candidates = await request({
      ...command,
      method: "repo.tasks.claimable",
      action: { kind: "repository-read" },
    });
    if (candidates.ok === false) return candidates;
    // The daemon validates the claimable read schema; use its ordered, bounded snapshot once.
    const tasks = candidates.tasks as JsonObject[],
      { claimNext: _claimNext, ...action } = command.action;
    let taskId: string | undefined;
    for (const task of tasks) {
      const started = await request({
        ...command,
        method: "repo.task.run",
        action: { kind: "task-start", taskId: task.taskId },
      });
      if (started.outcome === "applied") {
        taskId = String(task.taskId);
        break;
      }
      const error = started.error as JsonObject | undefined;
      if ((started.code ?? error?.code) !== "lease_conflict") return started;
    }
    if (!taskId)
      return {
        ok: true,
        command: "runtime-run",
        outcome: "empty",
        exitCode: 0,
        summary: "agent run: no claimable task acquired from this candidate pool.",
      };
    command = { ...command, action: { ...action, taskId } };
  }
  const action = command.action;
  if (action.kind.startsWith("runtime-handoff-")) return runCommandThroughDaemon(command);
  if (command.method.startsWith("repo.runtimeInstance.auth.")) return runRuntimeAuthCommand(command, writeActivity);
  if (action.kind === "runtime-batch") return runRuntimeBatch(command);
  if (action.kind === "squad-run") return runSquadRun(command, writeActivity);
  if (action.kind === "squad-status") return waitForSquadRun(command, String(action.squadRunId));
  if (action.kind === "runtime-sessions-await") return waitForRuntimeSessions(command, writeActivity);
  if (action.kind === "runtime-status") {
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
    spawned = await request({
      ...command,
      action: {
        ...spawnAction,
        idempotencyKey: action.idempotencyKey ?? `runtime-cli-${randomUUID()}`,
      },
    });
  // --dry-run: the daemon returned the assembled dispatch preview; print the
  // injected prompt verbatim and never enter the wait/attach path.
  if (spawned.ok === true && spawned.schema === "agent-dispatch-preview/v1")
    return {
      ...spawned,
      command: "runtime-run",
      summary: String(spawned.prompt),
      exitCode: 0,
    };
  if (spawned.ok !== true || typeof spawned.runtimeSessionId !== "string") return spawned;
  if (detach === true) {
    const nextAction = `ha runtime status ${spawned.runtimeSessionId} --wait`;
    return {
      ...spawned,
      command: "runtime-run",
      outcome: "running",
      nextAction,
      summary: `runtime-run: detached ${String(spawned.dispatchId)}\n${detachedWaitGuidance(
        nextAction,
        typeof action.taskId === "string" ? action.taskId : undefined,
      )}`,
      exitCode: 0,
    };
  }
  return waitForRuntimeSessions(
    {
      ...command,
      method: "repo.agentRuntime.sessions.await",
      action: {
        kind: "runtime-sessions-await",
        runtimeSessionIds: [spawned.runtimeSessionId],
        ...(action.noStream === true ? { noStream: true } : {}),
      },
    },
    writeActivity,
    spawned,
    typeof action.taskId === "string" && typeof spawned.dispatchId === "string"
      ? { taskId: action.taskId, dispatchId: spawned.dispatchId }
      : undefined,
  );
}
