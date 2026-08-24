import type { JsonObject } from "../../daemon/src/protocol/json-rpc-types.ts";
import { runtimeRejected } from "./cli-runtime-auth.ts";
import { runRuntimeBatchDeclaration } from "./cli-runtime-batch.ts";
import { runRuntimeFacadeCommand } from "./cli-runtime-command.ts";
import {
  parseSquadPlan,
  readSquadDeclarationThroughDaemon,
  readTaskPackagePath,
  squadLeaderPrompt,
} from "./cli-squad-inspection.ts";
import { squadReportRow, squadRosterCoverage } from "./cli-squad-report.ts";
import type {
  RuntimeBatchDeclaration,
  SquadRunAction,
  SquadRunDispatch,
} from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError } from "./daemon/client.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

export async function runSquadRun(
  command: ThinCommand,
  writeActivity: (text: string) => void,
): Promise<JsonObject> {
  const action = command.action as SquadRunAction,
    inspected = await readSquadDeclarationThroughDaemon(
      command,
      action.squadId,
    );
  if ("receipt" in inspected)
    return { ...inspected.receipt, command: "squad-run", exitCode: 1 };
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
  const squad = inspected.squad,
    leaderPrompt = squadLeaderPrompt(squad, action.runtimeInstanceId, mission),
    leader = await runRuntimeFacadeCommand(
      {
        ...command,
        method: "repo.agentRuntime.spawn",
        action: {
          kind: "runtime-run",
          runtimeInstanceId: action.runtimeInstanceId,
          agentId: squad.leader,
          prompt: leaderPrompt,
          cwd: action.cwd,
          taskId: action.taskId,
          ...(action.effort ? { effort: action.effort } : {}),
          ...(action.model ? { model: action.model } : {}),
          noStream: true,
        },
      },
      writeActivity,
    ),
    leaderResult =
      leader.result && typeof leader.result === "object"
        ? (leader.result as Record<string, unknown>)
        : null,
    leaderText =
      typeof leaderResult?.text === "string" ? leaderResult.text : "";
  if (leader.outcome !== "succeeded" || !leaderText)
    return {
      ...runtimeRejected(
        "squad-run",
        "squad_leader_failed",
        String(
          leader.reason ??
            leader.summary ??
            "Leader did not produce a structured plan.",
        ),
      ),
      leader,
      squadId: squad.id,
      leaderAgentId: squad.leader,
    };
  let plan: RuntimeBatchDeclaration;
  try {
    plan = parseSquadPlan(leaderText, action.runtimeInstanceId, squad);
  } catch (error) {
    consumeKnownError(error);
    return {
      ...runtimeRejected(
        "squad-run",
        "squad_plan_invalid",
        error instanceof Error ? error.message : String(error),
      ),
      leader,
      squadId: squad.id,
      leaderAgentId: squad.leader,
      rawPlan: leaderText,
    };
  }
  const rosterCoverage = squadRosterCoverage(squad, plan),
    declaration = {
      maxConcurrency: plan.maxConcurrency,
      dispatches: plan.dispatches.map((entry) => ({
        ...entry,
        agent: squad.leader,
        task: action.taskId,
        cwd: action.cwd,
      })),
    },
    workers = await runRuntimeBatchDeclaration(
      command,
      declaration,
      writeActivity,
    ),
    packagePath = await readTaskPackagePath(command, action.taskId),
    dispatches = Array.isArray(workers.dispatches)
      ? workers.dispatches.map((row) => squadReportRow(row, packagePath, squad))
      : [],
    unknown = dispatches.some((row) => row.status === "unknown"),
    failed = dispatches.some((row) => row.status !== "succeeded"),
    outcome = failed ? (unknown ? "unknown" : "partial_failure") : "succeeded";
  return {
    schema: "command-receipt/v2",
    ok: true,
    command: "squad-run",
    outcome,
    squadId: squad.id,
    leaderAgentId: squad.leader,
    leader,
    leaderPlan: leaderText,
    rosterCoverage,
    dispatches,
    summary: squadRunSummary(squad.id, dispatches),
    exitCode: outcome === "succeeded" ? 0 : 1,
  };
}

function squadRunSummary(
  squadId: string,
  dispatches: readonly SquadRunDispatch[],
): string {
  const succeeded = dispatches.filter(
    (row) => row.status === "succeeded",
  ).length;
  return `squad-run ${squadId}: ${succeeded} succeeded, ${dispatches.length - succeeded} failed`;
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
