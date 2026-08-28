import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { SquadRunAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

export async function runSquadRun(command: ThinCommand, _writeActivity: (text: string) => void): Promise<JsonObject> {
  const action = command.action as SquadRunAction;
  return runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action,
  });
}
