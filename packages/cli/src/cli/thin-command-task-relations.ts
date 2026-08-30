import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import type { ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

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
  if (Boolean(title) === Boolean(byTaskId) || (byTaskId && confirm !== oldTaskId) || (f.one.get("--slug") && !title))
    return rejectInput(inputs, "task-supersede", byTaskId ? "--confirm" : "--title", json);
  return accepted(rootDir, repoId, json, {
    kind: "task-supersede",
    oldTaskId,
    ...(title ? { title, ...(f.one.get("--slug") ? { slug: f.one.get("--slug") } : {}) } : { byTaskId, confirm }),
    reason: f.one.get("--reason"),
    ...(f.one.get("--deleted-by") ? { deletedBy: f.one.get("--deleted-by") } : {}),
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
  const target = args[4];
  if (args[3] !== "depends-on" || !nonEmpty(target))
    return rejected(
      "invalid_field",
      `Run ha task relate ${taskId} depends-on <target-task-id> --rationale <text>.`,
      json,
    );
  const f = readFlags("task-relate", args.slice(5), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  return accepted(rootDir, repoId, json, {
    kind: "task-relate",
    taskId,
    target: `task/${target}`,
    relationType: "depends-on",
    rationale: f.one.get("--rationale"),
    ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
  });
}
