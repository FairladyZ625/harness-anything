import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
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

// `ha task rename` / `ha task move` are CLI aliases over the amend write path: one named patch each,
// forwarded as the shared task-amend action so authorization, idempotency, and receipts stay singular.
export function parseTaskRelocation(
  id: "task-rename" | "task-move",
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const positional = args[2]?.startsWith("--") ? undefined : args[2];
  if (!nonEmpty(positional))
    return rejected(
      "missing_field",
      id === "task-rename"
        ? "Run ha task rename <task-id> --title <new-title>."
        : "Run ha task move <task-id> --parent <parent-task-id>.",
      json,
    );
  const f = readFlags(id, args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  // readFlags already refuses an absent or empty required input, so the flag value is present.
  const value = f.one.get(id === "task-rename" ? "--title" : "--parent")!;
  return accepted(rootDir, repoId, json, {
    kind: "task-amend",
    taskId: positional,
    patches: [{ field: id === "task-rename" ? "title" : "parentTaskId", value }],
  });
}
