import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import type { SquadRunAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function runSquadRun(
  command: ThinCommand,
  _writeActivity: (text: string) => void,
): Promise<JsonObject> {
  const action = command.action as SquadRunAction;
  let mission: string;
  try {
    mission = readSquadMission(command, action);
  } catch (error) {
    return runtimeRejected(
      "squad-run",
      "prompt_file_unreadable",
      `Could not read --prompt-file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { promptFile: _promptFile, ...daemonAction } = action;
  return runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action: { ...daemonAction, prompt: mission },
  });
}

export function readSquadMission(
  command: ThinCommand,
  action: SquadRunAction,
): string {
  return typeof action.prompt === "string"
    ? action.prompt
    : readFileSync(
        path.resolve(command.rootDir, String(action.promptFile)),
        "utf8",
      );
}
