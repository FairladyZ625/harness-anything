import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import type { SquadRunAction } from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { runCommandThroughDaemon } from "./daemon/client.ts";

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
  for (;;) {
    const status = await runCommandThroughDaemon({
      ...command,
      method: "repo.task.read",
      action: { kind: "squad-status", squadRunId: spawned.squadRunId },
    });
    if (status.ok !== true) return status;
    const phase = (status.run as Record<string, unknown> | undefined)?.phase;
    if (phase === "converged" || phase === "failed" || phase === "cancelled")
      return { ...status, command: "squad-run", outcome: phase, exitCode: phase === "converged" ? 0 : 1 };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
