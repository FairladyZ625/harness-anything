import { parseArgs } from "../../../cli/src/cli/parse-args.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../../cli/test/helpers/production-authority-connection.ts";
import {
  encodeRepoWriteCommand,
  type RepoWriteCommandDto
} from "../../src/index.ts";

type FixtureCommandName =
  | "decision-propose"
  | "new-task"
  | "record-fact"
  | "task-claim";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";

/** Build transport fixtures through the same CLI parser and daemon encoder as production. */
export function repoWriteProductionCommandFixture(
  commandName: FixtureCommandName = "decision-propose",
  label = ""
): RepoWriteCommandDto {
  const parsed = parseArgs([
    ...commandArgs(commandName, label),
    "--root", "/repo",
    "--json"
  ]);
  if (!parsed.ok || parsed.value.action.kind !== commandName) {
    throw new Error(`REPO_WRITE_PRODUCTION_FIXTURE_PARSE_FAILED:${commandName}`);
  }
  const actor = productionAuthorityActor();
  return encodeRepoWriteCommand({
    command: parsed.value as unknown as Readonly<Record<string, unknown>>,
    context: {
      actor,
      authorityConnection: productionAuthorityConnection(actor),
      currentSession: {
        runtime: "codex",
        sessionId: "session-repo-write-transport",
        source: "manual",
        detectedAt: "2026-08-05T00:00:00.000Z"
      },
      executor: { kind: "agent", id: "codex" }
    }
  });
}

function commandArgs(
  commandName: FixtureCommandName,
  label: string
): ReadonlyArray<string> {
  const text = label || "transport-command";
  switch (commandName) {
    case "decision-propose":
      return [
        "decision", "propose",
        "--title", text,
        "--question", "Does the transport preserve this submission?",
        "--chosen", "Preserve it",
        "--rejected", "Drop it",
        "--why-not", "Dropping loses the request"
      ];
    case "new-task":
      return ["task", "create", "--title", text];
    case "record-fact":
      return [
        "fact", "record",
        "--task", taskId,
        "--statement", text,
        "--confidence", "high"
      ];
    case "task-claim":
      return ["task", "claim", taskId];
  }
}
