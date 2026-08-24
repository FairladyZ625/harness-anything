import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  optionalFlags,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseContractMigrate(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-contract-migrate", args.slice(3), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const dryRun = f.booleans.has("--dry-run"),
    apply = f.booleans.has("--apply");
  if (dryRun === apply)
    return rejectInput(inputs, "task-contract-migrate", "--dry-run", json);
  return accepted(rootDir, repoId, json, {
    kind: "task-contract-migrate",
    mode: dryRun ? "dry-run" : "apply",
    ...(f.one.get("--task") ? { taskId: f.one.get("--task") } : {}),
  });
}

export function parseTaskDelete(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("task-delete", args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const soft = f.one.get("--soft"),
    hard = f.one.get("--hard"),
    reason = f.one.get("--reason"),
    confirm = f.one.get("--confirm");
  if (
    Boolean(soft) === Boolean(hard) ||
    (soft && !reason) ||
    (hard && confirm !== hard)
  )
    return rejectInput(
      inputs,
      "task-delete",
      soft && !reason ? "--reason" : hard ? "--confirm" : "--soft",
      json,
    );
  return accepted(rootDir, repoId, json, {
    kind: "task-delete",
    taskId: soft ?? hard,
    mode: soft ? "soft" : "hard",
    ...(reason ? { reason } : {}),
    ...(confirm ? { confirm } : {}),
    ...(f.one.get("--deleted-by")
      ? { deletedBy: f.one.get("--deleted-by") }
      : {}),
  });
}

export function parseTaskArchive(
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const taskId = args[2]?.startsWith("--") ? undefined : args[2],
    f = readFlags("task-archive", args.slice(taskId ? 3 : 2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const ids = f.one.get("--ids"),
    filter = f.one.get("--filter"),
    selectors = [taskId, ids, filter].filter(Boolean);
  if (selectors.length !== 1 || (f.one.get("--before") && !filter))
    return rejectInput(inputs, "task-archive", "--ids", json);
  return accepted(rootDir, repoId, json, {
    kind: "task-archive",
    ...(taskId
      ? { taskId }
      : ids
        ? { taskIds: ids.split(",").filter(nonEmpty) }
        : { filter }),
    reason: f.one.get("--reason"),
    ...optionalFlags(f.one, [
      ["--before", "before"],
      ["--archived-by", "archivedBy"],
      ["--archive-field", "archiveField"],
    ]),
  });
}
