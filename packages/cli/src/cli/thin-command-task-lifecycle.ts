import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseTransition(
  args: readonly string[],
  taskId: string,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const status = args[3],
    allowed = ["planned", "active", "blocked", "cancelled"];
  if (!status || !allowed.includes(status))
    return rejected(
      "invalid_field",
      status === "done"
        ? "Use ha task complete; done requires reviewed evidence and consent."
        : status === "in_review"
          ? "Use ha task submit; in_review requires an Execution submission."
          : "Choose planned, active, blocked, or cancelled.",
      json,
    );
  const f = readFlags("task-transition", args.slice(4), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const reason = f.one.get("--reason"),
    force = f.booleans.has("--force");
  if (status === "cancelled" && !force)
    return rejected(
      "invalid_field",
      reason
        ? "Audited cancellation requires --force together with --reason."
        : "Audited cancellation requires --force and --reason together.",
      json,
    );
  if (status === "cancelled" && !reason)
    return rejected(
      "missing_field",
      "Audited cancellation requires --reason together with --force.",
      json,
    );
  if (status !== "cancelled" && force)
    return rejectInput(inputs, "task-transition", "--force", json);
  if (status === "planned" && !reason)
    return rejected(
      "missing_field",
      "Reinstating a cancelled task to planned requires --reason <why the cancellation is rolled back>.",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "task-transition",
    taskId,
    status,
    ...(force ? { force: true } : {}),
    ...(reason ? { reason } : {}),
  });
}

export function parseAmend(
  args: readonly string[],
  taskId: string,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-amend", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const patches = (f.many.get("--set") ?? []).map((value) => {
    const separator = value.indexOf(":");
    return {
      field: value.slice(0, separator),
      value: value.slice(separator + 1),
    };
  });
  return accepted(rootDir, repoId, json, {
    kind: "task-amend",
    taskId,
    patches,
  });
}

export function parseSupersede(
  args: readonly string[],
  oldTaskId: string,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-supersede", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const title = f.one.get("--title"),
    byTaskId = f.one.get("--by"),
    confirm = f.one.get("--confirm");
  if (
    Boolean(title) === Boolean(byTaskId) ||
    (byTaskId && confirm !== oldTaskId) ||
    (f.one.get("--slug") && !title)
  )
    return rejectInput(
      inputs,
      "task-supersede",
      byTaskId ? "--confirm" : "--title",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "task-supersede",
    oldTaskId,
    ...(title
      ? { title, ...(f.one.get("--slug") ? { slug: f.one.get("--slug") } : {}) }
      : { byTaskId, confirm }),
    reason: f.one.get("--reason"),
    ...(f.one.get("--deleted-by")
      ? { deletedBy: f.one.get("--deleted-by") }
      : {}),
    allowOpenFindings: f.booleans.has("--allow-open-findings"),
  });
}

export function parseRelate(
  args: readonly string[],
  taskId: string,
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const relationType = args[3],
    target = args[4],
    dependency = relationType === "depends-on" && nonEmpty(target),
    factRelation = relationType === "relates" && /^fact\/F-[0-9A-HJKMNP-TV-Z]{8}$/u.test(target ?? "");
  if (!dependency && !factRelation)
    return rejected(
      "invalid_field",
      [
        `Run ha task relate ${taskId} depends-on <target-task-id> --rationale <text>, `,
        `or ha task relate ${taskId} relates fact/F-XXXXXXXX --rationale <text>.`,
      ].join(""),
      json,
    );
  const f = readFlags("task-relate", args.slice(5), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  return accepted(rootDir, repoId, json, {
    kind: "task-relate",
    taskId,
    target: dependency ? `task/${target}` : target,
    relationType,
    rationale: f.one.get("--rationale"),
    ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
  });
}
