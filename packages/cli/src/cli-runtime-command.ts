import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import type { ThinCommand } from "./cli/thin-command.ts";

export function isRuntimeFacadeCommand(command: ThinCommand): boolean {
  return (
    command.action.kind === "task-submit" ||
    command.action.kind === "squad-run" ||
    (command.action.kind === "squad-status" && command.action.wait === true) ||
    command.method.startsWith("repo.agentRuntime.") ||
    command.method.startsWith("repo.runtimeInstance.auth.")
  );
}

export async function runRuntimeFacadeCommand(
  command: ThinCommand,
  writeActivity: (text: string) => void = (text) => process.stderr.write(text),
  request?: (command: ThinCommand) => Promise<JsonObject>,
): Promise<JsonObject> {
  const { cliContractPolicy } = await import("@harness-anything/kernel/internal/domain/cli-operational-policy.ts"),
    send = request ?? (await import("./daemon/client.ts")).runCommandThroughDaemon;
  if (command.action.claimNext === cliContractPolicy.defaultValue.claimNext) {
    const candidates = await send({
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
      const started = await send({
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
  if (action.kind === "task-submit") {
    const submitted = await send(command);
    if (submitted.ok !== true || submitted.outcome !== "pending") return submitted;
    return submitted;
  }
  if (action.kind.startsWith("runtime-handoff-")) {
    const { runCommandThroughDaemon } = await import("./daemon/client.ts");
    return runCommandThroughDaemon(command);
  }
  if (command.method.startsWith("repo.runtimeInstance.auth.")) {
    const { runRuntimeAuthCommand } = await import("./cli-runtime-auth.ts");
    return runRuntimeAuthCommand(command, writeActivity);
  }
  if (action.kind === "runtime-batch") {
    const { runRuntimeBatch } = await import("./cli-runtime-batch.ts");
    return runRuntimeBatch(command);
  }
  if (action.kind === "squad-run") {
    const { runSquadRun } = await import("./cli-squad-run.ts");
    return runSquadRun(command, writeActivity);
  }
  if (action.kind === "squad-status") {
    const { waitForSquadRun } = await import("./cli-runtime-wait.ts");
    return waitForSquadRun(command, String(action.squadRunId));
  }
  if (action.kind === "runtime-sessions-await") {
    const { waitForRuntimeSessions } = await import("./cli-runtime-wait.ts");
    return waitForRuntimeSessions(command, writeActivity);
  }
  if (action.kind === "runtime-status") {
    const [{ renderRuntimeStatus }, { runCommandThroughDaemon }] = await Promise.all([
        import("./cli-runtime-auth.ts"),
        import("./daemon/client.ts"),
      ]),
      { wait: _wait, noStream: _noStream, ...readAction } = action,
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
  if (action.kind === "runtime-cancel" || action.kind === "runtime-steer") {
    const { runCommandThroughDaemon } = await import("./daemon/client.ts"),
      { noStream: _noStream, ...rpcAction } = action,
      result = await runCommandThroughDaemon({
        ...command,
        action: rpcAction,
      });
    return result.ok === true
      ? {
          ...result,
          summary:
            action.kind === "runtime-cancel"
              ? `runtime-cancel: ${String(result.detail ?? "cancelled")}`
              : typeof result.summary === "string"
                ? result.summary
                : `runtime-steer: ${String(result.outcome ?? "applied")}`,
        }
      : result;
  }
  const { randomUUID } = await import("node:crypto"),
    { projectRuntimeSpawnRpcPayload } = await import("./cli/thin-command-runtime.ts"),
    detach = action.detach === true,
    spawnAction = projectRuntimeSpawnRpcPayload({
      ...action,
      // A caller idempotency key is the dispatch key; only a keyless run gets a fresh one.
      dispatchKey: typeof action.dispatchKey === "string" ? action.dispatchKey : `runtime-cli-${randomUUID()}`,
    }),
    spawned = await send({
      ...command,
      action: { kind: action.kind, ...spawnAction },
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
  const { detachedWaitGuidance, waitForRuntimeSessions } = await import("./cli-runtime-wait.ts");
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
