import { readFileSync } from "node:fs";
import path from "node:path";
import { runStorageMigration, type StorageMigrationLocation } from "@harness-anything/storage";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { RepoTaskAction, RepoCellBinding } from "./repo-cell-types.ts";

/** Host-local admin Action, authorized before this handler and serialized by the repository writer. */
export async function runStorageMigrationAction(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
) {
  if (cell.mode !== "local" && cell.mode !== "remote-center")
    throw cell.cellCodedError(
      "repo_mode_read_only",
      "storage migration runs on the authority node, never an edge replica",
    );
  const load = (field: string, backend: unknown): StorageMigrationLocation => {
    const file = cell.requiredCellText(action[field], field),
      location = JSON.parse(readFileSync(path.resolve(cell.rootDir, file), "utf8")) as StorageMigrationLocation;
    if (!location.storage || (location.storage.backend ?? "sqlite") !== backend)
      throw cell.cellCodedError("invalid_field", `${field} backend differs from --from/--to`);
    return location;
  };
  const mode = action.mode ?? "migrate";
  if (!["preflight", "migrate", "resume", "abort"].includes(String(mode)))
    throw cell.cellCodedError("invalid_field", "invalid storage migration mode");
  const result = await runStorageMigration({
    repoId: cell.input.repoId,
    runId: cell.requiredCellText(action.runId, "runId"),
    source: load("sourceLocation", action.from),
    target: load("targetLocation", action.to),
    exportDirectory: path.resolve(cell.rootDir, cell.requiredCellText(action.exportDirectory, "exportDirectory")),
    mode: mode as "preflight" | "migrate" | "resume" | "abort",
  });
  return cell.readResult(
    cell.operationId(action, binding, cell.input.repoId, cell.store.readHead()?.revision ?? 0),
    result,
    cell.store.readHead()?.revision ?? 0,
    true,
  );
}
