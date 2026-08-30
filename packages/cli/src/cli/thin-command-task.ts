import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import { parseContractMigrate, parseTaskArchive, parseTaskDelete } from "./thin-command-task-admin.ts";
import { parseCodeDoc, parseCodeDocRepoint, parseProgress } from "./thin-command-task-evidence.ts";
import { parseAmend, parseRelate, parseSupersede } from "./thin-command-task-relations.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseTask(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const verb = args[1];
  if (id === "task-list") return parseProjected(id, args.slice(2), rootDir, repoId, json, inputs);
  if (id === "task-contract-migrate") return parseContractMigrate(args, rootDir, repoId, json, inputs);
  if (id === "task-delete") return parseTaskDelete(args, rootDir, repoId, json, inputs);
  if (id === "task-archive") return parseTaskArchive(args, rootDir, repoId, json, inputs);
  if (id === "task-show" && nonEmpty(args[2]) && args.length === 3)
    return accepted(rootDir, repoId, json, {
      kind: "task-show",
      verb,
      taskId: args[2],
    });
  if (id === "task-progress-append") return parseProgress(rootDir, repoId, json, args, inputs);
  if (id === "task-artifact-add") {
    const taskId = args[3];
    return nonEmpty(taskId)
      ? parseProjected(id, args.slice(4), rootDir, repoId, json, inputs, {
          taskId,
        })
      : rejected("missing_field", "Run ha task artifact add <task-id>.", json);
  }
  const taskId = args[id === "task-code-doc-reconcile" || id === "task-code-doc-repoint" ? 3 : 2];
  if (!nonEmpty(taskId)) return rejected("missing_field", `Run ha task ${verb ?? "<verb>"} <task-id>.`, json);
  if (
    id === "task-start" ||
    id === "task-submit" ||
    id === "task-review-execution" ||
    id === "task-complete" ||
    id === "task-release" ||
    id === "task-reopen" ||
    id === "task-review"
  )
    return parseProjected(id, args.slice(3), rootDir, repoId, json, inputs, {
      taskId,
    });
  if (id === "task-transition") {
    const status = args[3];
    return nonEmpty(status)
      ? parseProjected(id, args.slice(4), rootDir, repoId, json, inputs, { taskId, status })
      : rejected("missing_field", `Run ha task transition ${taskId} <status>.`, json);
  }
  if (id === "task-amend") return parseAmend(args, taskId, rootDir, repoId, json, inputs);
  if (id === "task-pin" || id === "task-unpin")
    return accepted(rootDir, repoId, json, {
      kind: "task-amend",
      taskId,
      patches: [{ field: "pinned", value: id === "task-pin" ? "true" : "false" }],
    });
  if (id === "task-supersede") return parseSupersede(args, taskId, rootDir, repoId, json, inputs);
  if (id === "task-relate") return parseRelate(args, taskId, rootDir, repoId, json, inputs);
  if (id === "task-closeout") {
    const f = readFlags(id, args.slice(3), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const fromFile = f.one.get("--from-file"),
      printTemplate = f.booleans.has("--print-template"),
      printSchema = f.booleans.has("--print-schema"),
      modes = Number(fromFile !== undefined) + Number(printTemplate) + Number(printSchema);
    if (modes !== 1)
      return rejected(
        modes === 0 ? "missing_field" : "invalid_field",
        "Choose exactly one of --from-file <judgment.json>, --print-template, or --print-schema.",
        json,
      );
    const executionId = f.one.get("--execution-id");
    if (printSchema && executionId)
      return rejected("invalid_field", "--execution-id does not apply to --print-schema.", json);
    return accepted(rootDir, repoId, json, {
      kind: id,
      taskId,
      ...(executionId ? { executionId } : {}),
      ...(fromFile ? { fromFile } : {}),
      ...(printTemplate ? { printTemplate: true } : {}),
      ...(printSchema ? { printSchema: true } : {}),
    });
  }
  if (id === "task-declare-executor") {
    const f = readFlags(id, args.slice(3), inputs),
      executionId = f.ok ? f.one.get("--execution-id") : undefined;
    return f.ok
      ? accepted(rootDir, repoId, json, {
          kind: id,
          taskId,
          ...(executionId ? { executionId } : {}),
          ...(f.one.get("--agent") ? { agent: f.one.get("--agent") } : {}),
          reason: f.one.get("--reason"),
        })
      : rejected(f.code, f.nextAction, json);
  }
  if (id === "task-review-consent")
    return parseProjected(id, args.slice(3), rootDir, repoId, json, inputs, {
      taskId,
      commandType: "RecordReviewConsent",
    });
  if (id === "task-code-doc-reconcile") return parseCodeDoc(rootDir, repoId, json, args, taskId, inputs);
  if (id === "task-code-doc-repoint") return parseCodeDocRepoint(rootDir, repoId, json, args, taskId, inputs);
  return rejected("unsupported_command", `Run ${inputs.get(id)!.helpCommand}.`, json);
}
