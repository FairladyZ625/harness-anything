import type { CommandRunner } from "../../cli/runner-registry.ts";
import { runProjectionReaderCommand } from "./projection-readers.ts";
import { runTaskQueryCommand } from "./task-query.ts";

export const runTaskViewCommand: CommandRunner = (context, command) =>
  command.action.kind === "task-show" && command.action.view === "trace"
    ? runProjectionReaderCommand(context, command)
    : runTaskQueryCommand(context, command);
