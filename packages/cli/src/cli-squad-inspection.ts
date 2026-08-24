import { runtimeRejected } from "./cli-runtime-auth.ts";
import { parseRuntimeBatchDeclaration } from "./cli-runtime-batch-input.ts";
import { runtimeBatchDefaultConcurrency } from "./cli-types.ts";
import type {
  RuntimeBatchDeclaration,
  SquadDeclaration,
  SquadReadResult,
} from "./cli-types.ts";
import type { ThinCommand } from "./cli/thin-command.ts";
import { consumeKnownError, runCommandThroughDaemon } from "./daemon/client.ts";

export async function readSquadDeclarationThroughDaemon(
  command: ThinCommand,
  squadId: string,
): Promise<SquadReadResult> {
  const result = await runCommandThroughDaemon({
    ...command,
    method: "repo.task.run",
    action: { kind: "squad-inspect", squadId },
  });
  if (result.ok !== true) return { receipt: result };
  try {
    if (typeof result.evidence !== "string")
      throw new Error(`Squad ${squadId} inspection is malformed.`);
    const value = JSON.parse(result.evidence) as Record<string, unknown>,
      squad = value.squad;
    if (!squad || typeof squad !== "object" || Array.isArray(squad))
      throw new Error(`Squad ${squadId} inspection is malformed.`);
    const row = squad as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.leader !== "string" ||
      !Array.isArray(row.workers) ||
      row.workers.some((worker) => typeof worker !== "string") ||
      typeof row.roster !== "string"
    )
      throw new Error(`Squad ${squadId} inspection is malformed.`);
    return {
      squad: {
        id: row.id,
        name: row.name,
        leader: row.leader,
        workers: row.workers as string[],
        roster: row.roster,
      },
    };
  } catch (error) {
    consumeKnownError(error);
    return {
      receipt: runtimeRejected(
        "squad-run",
        "squad_inspection_invalid",
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export function squadLeaderPrompt(
  squad: SquadDeclaration,
  runtimeInstanceId: string,
  mission: string,
): string {
  return [
    `# Squad dispatch protocol`,
    `Return exactly one JSON object and no Markdown:`,
    `{"schema":"runtime-batch/v1","maxConcurrency":${runtimeBatchDefaultConcurrency},` +
      `"dispatches":[{"instance":"${runtimeInstanceId}","to":"worker-id",` +
      `"prompt":"worker mission"}]}`,
    `Choose workers only from the declared roster workers; harness owns every spawn. ` +
      `Each dispatch must contain instance, to, and prompt. Do not include unknown fields, ` +
      `prose, or code fences.`,
    `# Squad roster (load-bearing, human-editable)`,
    squad.roster,
    `# User mission`,
    mission,
  ].join("\n\n");
}

export function parseSquadPlan(
  text: string,
  instance: string,
  squad: SquadDeclaration,
): RuntimeBatchDeclaration {
  const raw = JSON.parse(text) as Record<string, unknown>,
    rawDispatches = Array.isArray(raw.dispatches) ? raw.dispatches : [],
    invalidAgent = rawDispatches.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        Object.hasOwn(entry, "agent"),
    );
  if (invalidAgent)
    throw new Error("Squad plan must leave agent ownership to the harness.");
  const dispatches = rawDispatches.map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? { ...(entry as Record<string, unknown>), agent: squad.leader }
        : entry,
    ),
    plan = parseRuntimeBatchDeclaration({ ...raw, dispatches }, "Squad plan"),
    seen = new Set<string>();
  if (
    plan.dispatches.some(
      (entry) =>
        entry.instance !== instance ||
        !entry.to ||
        !entry.prompt ||
        entry.agent !== squad.leader ||
        entry.promptFile !== undefined ||
        entry.task !== undefined ||
        entry.cwd !== undefined ||
        seen.has(entry.to) ||
        !squad.workers.includes(entry.to) ||
        (seen.add(entry.to), false),
    )
  )
    throw new Error(
      `Squad plan must name each worker at most once, use instance ${instance}, ` +
        `and select only declared roster workers.`,
    );
  return plan;
}

export async function readTaskPackagePath(
  command: ThinCommand,
  taskId: string,
): Promise<string | null> {
  try {
    const result = await runCommandThroughDaemon({
      ...command,
      method: "repo.task.run",
      action: { kind: "task-list" },
    });
    if (result.ok !== true || typeof result.evidence !== "string") return null;
    const value = JSON.parse(result.evidence) as Record<string, unknown>,
      rows = Array.isArray(value.rows) ? value.rows : [];
    const row = rows.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).taskId === taskId,
    ) as Record<string, unknown> | undefined;
    return typeof row?.packagePath === "string" ? row.packagePath : null;
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}
