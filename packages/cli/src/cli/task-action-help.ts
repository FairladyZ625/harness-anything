import { taskActionHelpRows } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";

export interface TaskActionHelpRow {
  readonly usage: string;
  readonly summary: string;
  readonly help: string;
}

const byCommand = new Map(taskActionHelpRows.map((row) => [commandKey(row.usage), row]));

export function preferTaskActionHelp(row: TaskActionHelpRow): TaskActionHelpRow {
  return byCommand.get(commandKey(row.usage)) ?? row;
}

export function projectedTaskActionHelpRows(): readonly TaskActionHelpRow[] {
  return taskActionHelpRows;
}

function commandKey(usage: string): string {
  return usage.split(/ (?=<|\[)/u, 1)[0]!;
}
