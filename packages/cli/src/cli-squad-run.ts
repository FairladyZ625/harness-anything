import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { SquadRunAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { waitForSquadRun } from "./cli-runtime-wait.ts";

export async function runSquadRun(command: ThinCommand, _writeActivity: (text: string) => void): Promise<JsonObject> {
  const action = command.action as SquadRunAction;
  const spawned = await runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action,
  });
  if (spawned.ok !== true || typeof spawned.squadRunId !== "string" || action.detach === true) {
    return action.detach === true && spawned.ok === true
      ? { ...spawned, outcome: "running", nextAction: `ha squad status ${spawned.squadRunId} --wait` }
      : spawned;
  }
  return waitForSquadRun(command, spawned.squadRunId);
}
