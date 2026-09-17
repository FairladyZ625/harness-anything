import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import { parseProjected } from "./thin-command-projection.ts";
import { parseContractMigrate, parseTaskArchive, parseTaskDelete } from "./thin-command-task-admin.ts";
import { parseCodeDoc, parseCodeDocRepoint, parseProgress, parseTaskAttest } from "./thin-command-task-evidence.ts";
import { parseAmend, parseSupersede } from "./thin-command-task-relations.ts";
import { parseRematerialize } from "./thin-command-rematerialize.ts";
import { renderCliGuidance } from "./guidance-plane.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseTask(
  id: string,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const verb = args[1],
    delegated: Partial<Record<string, () => ThinParseResult>> = {
      "task-list": () => parseProjected(id, args.slice(2), rootDir, repoId, json, inputs),
      "task-contract-migrate": () => parseContractMigrate(args, rootDir, repoId, json, inputs),
      "task-delete": () => parseTaskDelete(args, rootDir, repoId, json, inputs),
      "task-archive": () => parseTaskArchive(args, rootDir, repoId, json, inputs),
      "task-dispatch-review": () => parseTaskDispatchReview(args, rootDir, repoId, json, inputs),
      "task-attest": () => parseTaskAttest(args, rootDir, repoId, json, inputs),
      "task-rematerialize": () => parseRematerialize(id, "taskId", args, rootDir, repoId, json, inputs),
    },
    delegatedParse = delegated[id]?.();
  if (delegatedParse !== undefined) return delegatedParse;
  if (id === "task-show") {
    const positional = args[2]?.startsWith("--") ? undefined : args[2],
      f = readFlags(id, args.slice(positional ? 3 : 2), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const flagged = f.one.get("--id");
    if (positional && flagged)
      return rejected("duplicate_field", "Use either ha task show <task-id> or --id <task-id>, not both.", json);
    return nonEmpty(positional ?? flagged)
      ? accepted(rootDir, repoId, json, {
          kind: "task-show",
          verb,
          taskId: positional ?? flagged,
        })
      : rejected("missing_field", "Run ha task show <task-id>.", json);
  }
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
    id === "task-settle" ||
    id === "task-review-execution" ||
    id === "task-complete" ||
    id === "task-release" ||
    id === "task-reopen" ||
    id === "task-read-set" ||
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
  if (id === "task-annotate") {
    const f = readFlags(id, args.slice(3), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, {
          kind: id,
          taskId,
          executionId: f.one.get("--execution-id"),
          note: f.one.get("--note"),
          ...(f.one.get("--kind") ? { annotationKind: f.one.get("--kind") } : {}),
        })
      : rejected(f.code, f.nextAction, json);
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
  return rejected(
    "unsupported_command",
    renderCliGuidance("run-help", { helpCommand: inputs.get(id)!.helpCommand }),
    json,
  );
}

function parseTaskDispatchReview(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const first = args[2];
  if (!nonEmpty(first)) return rejected("missing_field", "Run ha task dispatch-review <task-id>.", json);
  const f = readFlags("task-dispatch-review", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  return accepted(rootDir, repoId, json, {
    kind: "task-dispatch-review",
    taskIds: [first, ...(f.many.get("--task") ?? [])],
    ...(f.one.get("--agent") ? { agentId: f.one.get("--agent") } : {}),
    ...(f.one.get("--execution-id") ? { executionId: f.one.get("--execution-id") } : {}),
    ...(f.one.get("--instance") ? { runtimeInstanceId: f.one.get("--instance") } : {}),
    ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
    ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
    ...(f.booleans.has("--fast") ? { fast: true } : {}),
  });
}
