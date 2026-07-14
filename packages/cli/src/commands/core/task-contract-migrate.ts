import { Effect } from "effect";
import { listTaskIndexPaths, resolveHarnessLayout } from "../../../../kernel/src/index.ts";
import type { CliResult } from "../../cli/types.ts";
import type { CommandRunner } from "../../cli/runner-registry.ts";
import { readProjectHarnessSettings } from "../settings.ts";
import { createAuthoredTaskCreationResolver, createHistoricalTaskContractResolver } from "./task-contract-history.ts";
import { planTaskContractMigration, readMigrationTaskId, type MigrationEntry, type PlannedSnapshot } from "./task-contract-migration-planner.ts";

type TaskContractMigrateAction = Extract<Parameters<CommandRunner>[1]["action"], { readonly kind: "task-contract-migrate" }>;

export const runTaskContractMigration: CommandRunner = (context, command) => Effect.gen(function* () {
  const action = command.action as TaskContractMigrateAction;
  const settingsResult = readProjectHarnessSettings(context.layoutInput, action.kind);
  if (!settingsResult.ok) return settingsResult.result;
  const locale = settingsResult.settings.locale ?? "zh-CN";
  const layout = resolveHarnessLayout(context.layoutInput);
  const rootDir = layout.rootDir;
  const resolveHistoricalTaskContract = createHistoricalTaskContractResolver(rootDir);
  const resolveAuthoredTaskCreation = createAuthoredTaskCreationResolver(layout.authoredRoot, layout.tasksRoot);
  const capturedAt = new Date().toISOString();
  const entries: MigrationEntry[] = [];
  const planned: PlannedSnapshot[] = [];
  const indexPaths = listTaskIndexPaths(context.layoutInput)
    .filter((indexPath) => !action.taskId || readMigrationTaskId(indexPath) === action.taskId);

  if (action.taskId && indexPaths.length === 0) {
    entries.push({ taskId: action.taskId, status: "manual", reason: "task_not_found" });
  }

  for (const indexPath of indexPaths) {
    const result = planTaskContractMigration({
      rootInput: context.layoutInput,
      rootDir,
      indexPath,
      locale,
      capturedAt,
      resolveHistorical: resolveHistoricalTaskContract,
      resolveAuthoredCreation: resolveAuthoredTaskCreation
    });
    entries.push(result.entry);
    if (result.planned) planned.push(result.planned);
  }

  if (action.mode === "apply") {
    for (const item of planned) {
      yield* context.engine.replaceTaskDocument({ taskId: item.taskId, path: "task-contract.json", body: item.body });
      const entry = entries.find((candidate) => candidate.taskId === item.taskId && candidate.status === "planned");
      if (entry) entries[entries.indexOf(entry)] = {
        taskId: item.taskId,
        status: "applied",
        path: item.path,
        ...(entry.preset ? { preset: entry.preset } : {}),
        ...(entry.provenance ? { provenance: entry.provenance } : {}),
        ...(entry.sourceCommit ? { sourceCommit: entry.sourceCommit } : {}),
        ...(entry.authoredCommit ? { authoredCommit: entry.authoredCommit } : {})
      };
    }
  }

  const counts = {
    examined: entries.length,
    planned: entries.filter((entry) => entry.status === "planned").length,
    applied: entries.filter((entry) => entry.status === "applied").length,
    current: entries.filter((entry) => entry.status === "current").length,
    manual: entries.filter((entry) => entry.status === "manual").length
  };
  return {
    ok: true,
    command: action.kind,
    report: {
      schema: "task-contract-migration-report/v1",
      mode: action.mode,
      counts,
      entries
    }
  } satisfies CliResult;
});
