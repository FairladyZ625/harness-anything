import {
  documentPath,
  sha256Bytes,
  type TaskProjectionQueries,
  type WriteReceiptDraft,
} from "@harness-anything/kernel";
import { scanFleetMirrorWorktree, type FleetMirrorView } from "./fleet-edge-mirror.ts";
import type { DocCandidateRow } from "./doc-sync-candidate-scanner.ts";
import type { RepoTaskAction } from "./repo-cell-types.ts";
import { cellCodedError } from "./repo-cell-errors.ts";

/** A preview observes this edge's files against the already-authorized cut; it never pulls or materializes. */
export function readEdgeDocWorkspace(
  rootDir: string,
  view: FleetMirrorView,
  projection: TaskProjectionQueries,
  action: RepoTaskAction,
): WriteReceiptDraft & { readonly rows: readonly DocCandidateRow[]; readonly summary: string } {
  const taskId = typeof action.taskId === "string" ? action.taskId : null;
  if (taskId !== null && Array.isArray(action.paths) && action.paths.length > 0)
    throw cellCodedError("invalid_command", "Use a task id or document paths, not both.");
  const task = taskId === null ? null : projection.read(taskId);
  if (taskId !== null && (!task?.snapshot.task || !task.packagePath))
    throw cellCodedError("task_not_found", `Task ${taskId} has no package at this replica cut.`);
  if (taskId === null && (!Array.isArray(action.paths) || action.paths.some((value) => typeof value !== "string")))
    throw cellCodedError("invalid_command", "Document preview requires authored-root-relative paths or a task id.");
  const selection =
      Array.isArray(action.paths) && action.paths.length
        ? action.paths.map((value) => documentPath(String(value)))
        : undefined,
    scan = scanFleetMirrorWorktree(view, rootDir, selection),
    prefix = task?.packagePath ? `${task.packagePath}/` : null,
    selected = (logical: string) => prefix === null || logical.startsWith(prefix),
    deleted = new Set(scan.deletedPaths),
    rows: DocCandidateRow[] = [];
  const row = (
    logical: string,
    state: DocCandidateRow["state"],
    candidateBlobSha256: string | null,
    reason: string | null,
    size: number | null,
  ): DocCandidateRow => ({
    path: logical,
    state,
    reason,
    size,
    baseBlobSha256: view.entries.get(logical)?.sha256 ?? null,
    candidateBlobSha256,
    mediaType: null,
    conflicts: [],
  });
  for (const logical of scan.cleanPaths)
    rows.push(row(logical, "clean", view.entries.get(logical)!.sha256, null, view.entries.get(logical)!.size));
  for (const change of scan.changes)
    rows.push(row(change.path, "eligible", sha256Bytes(change.bytes), null, change.bytes.byteLength));
  for (const blocked of scan.blocked)
    rows.push(
      row(blocked.path, deleted.has(blocked.path) ? "deletion" : "blocked", null, blocked.reason, blocked.size ?? null),
    );
  const scoped = rows.filter(({ path }) => selected(path)).sort((a, b) => a.path.localeCompare(b.path));
  for (const logical of selection ?? [])
    if (!scoped.some((candidate) => candidate.path === logical))
      throw cellCodedError("document_not_found", `Document ${logical} is absent from the workspace and replica cut.`);
  return {
    outcome: "applied",
    opId: `read:${action.kind}:${view.headDigest}`,
    revision: view.revision,
    rows: scoped,
    evidence: `doc-scan:${JSON.stringify({ baseLedgerSha: { revision: view.revision, headDigest: view.headDigest }, rows: scoped })}`,
    summary: [
      `边缘本地工作区 vs 副本 cut revision=${view.revision}`,
      ...scoped.map(
        (candidate) => `${candidate.path}\t${candidate.state}${candidate.reason ? `\t${candidate.reason}` : ""}`,
      ),
      `clean=${scoped.filter(({ state }) => state === "clean").length} changed=${scoped.filter(({ state }) => state === "eligible").length} deleted=${scoped.filter(({ state }) => state === "deletion").length}`,
    ].join("\n"),
  };
}
