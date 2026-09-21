import { taskActionHelpRows } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";

export interface TaskActionHelpRow {
  readonly usage: string;
  readonly summary: string;
  readonly help: string;
}

const byCommand = new Map(taskActionHelpRows.map((row) => [commandKey(row.usage), row]));

export function preferTaskActionHelp(row: TaskActionHelpRow): TaskActionHelpRow {
  return byCommand.get(commandKey(row.usage)) ?? row;
}

function commandKey(usage: string): string {
  return usage.split(/ (?=<|\[)/u, 1)[0]!;
}
