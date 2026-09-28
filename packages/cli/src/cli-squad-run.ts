import type { JsonObject } from "@harness-anything/daemon/internal/protocol/json-rpc-types";
import type { SquadRunAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { detachedWaitGuidance, waitForSquadRun } from "./cli-runtime-wait.ts";

export async function runSquadRun(command: ThinCommand, _writeActivity: (text: string) => void): Promise<JsonObject> {
  const action = command.action as SquadRunAction;
  const spawned = await runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action,
  });
  if (spawned.ok !== true || typeof spawned.squadRunId !== "string") return spawned;
  if (action.detach === true) {
    const nextAction = `ha squad status ${spawned.squadRunId} --wait`;
    return {
      ...spawned,
      nextAction,
      summary: `${String(spawned.summary)}\n${detachedWaitGuidance(nextAction, action.taskId, true)}`,
    };
  }
  return waitForSquadRun(command, spawned.squadRunId);
}
