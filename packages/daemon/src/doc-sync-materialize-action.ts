import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { stableStringify } from "@harness-anything/kernel";
import { touch } from "./doc-sync-details.ts";
import { docSyncError, hasExactDocSyncActionFields, proof, rejectDocSyncAction } from "./doc-sync-files.ts";
import { workspacePathOf } from "./doc-sync-settlement.ts";
import type { DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";

/**
 * `doc materialize` never settles the worktree by implication. Bare, it previews what a whole-closure
 * restore would touch and demands an explicit confirmation; `paths` restores one named selection;
 * `all` runs the previewed whole-closure pass. Every confirmed run reports each settled path and,
 * where the overwritten local bytes were kept, the conflict copy beside it.
 */
export function runDocMaterialize(input: Input): DocSettlementReceipt {
  const paths = materializePaths(input),
    workspacePath = workspacePathOf(input);
  const result =
    paths === undefined
      ? input.store.materialize({ preview: true })
      : paths === null
        ? input.store.materialize()
        : input.store.materialize({ paths });
  const revision = input.store.readHead()?.revision ?? 0,
    visible = input.store.followerStatus().worktree.status === "verified",
    settlements = result.settlements.map((row) => ({
      ...row,
      path: workspacePath(row.path),
      // `copy` is already repository-root-relative (`.harness/conflicts/...`); it is not a ledger
      // document, so prefixing the authored root here would point at a file that does not exist.
      copy: row.copy,
    })),
    conflicts = result.conflicts.map(workspacePath);
  if (paths === undefined && settlements.length > 0) {
    const summary = [
      "doc-materialize: op_rejected",
      "restoring the canonical cut to the worktree requires explicit confirmation for:",
      ...settlements.map((row) =>
        row.copy === null
          ? `${row.path}\t${row.action}`
          : `${row.path}\t${row.action}\tlocal bytes kept at ${row.copy}`,
      ),
      ...(conflicts.length > 0 ? ["left untouched because a concurrent local edit owns them:", ...conflicts] : []),
      "rerun with --path <path>... for an explicit selection or --all for the whole cut",
    ].join("\n");
    return Object.assign(
      rejectDocSyncAction(
        `materialize:${result.commitSha?.sha ?? `cut-${revision}`}`,
        "doc_materialize_confirmation_required",
        {
          kind: "doc_sync",
          code: "doc_materialize_confirmation_required",
          baseLedgerSha: input.store.currentCut(),
          currentLedgerSha: input.store.currentCut(),
          paths: settlements.map((row) => ({
            path: row.path,
            baseBlobSha256: null,
            currentBlobSha256: null,
            candidateBlobSha256: null,
          })),
          holder: null,
          differences: [],
          unresolvedTouches: settlements.map((row) =>
            touch(row.path, "doc-materialize", `would ${row.action} this path`),
          ),
          deletions: [],
        },
      ),
      // rejectionExplanation is the field the CLI's human hint chain promotes, so the confirmation
      // list itself — not just the code — reaches the operator.
      { summary, rejectionExplanation: summary },
    );
  }
  return {
    // A named selection is settled when every named path now holds its canonical bytes, regardless
    // of the rest of the worktree; the whole cut reports the follower's own visibility. Neither
    // outcome is "no changes": a whole-closure pass may still create or retire directories, which
    // the file settlements do not list.
    outcome: paths !== null && conflicts.length === 0 ? "applied" : visible ? "applied" : "pending",
    opId: `materialize:${result.commitSha?.sha ?? `cut-${revision}`}`,
    revision,
    acceptance: null,
    evidence: `doc-materialize:${stableStringify({ settlements, conflicts })}`,
    visibility: "center",
    proof: proof(revision, revision, true, visible),
    ...(paths !== undefined && settlements.length > 0
      ? {
          summary: [
            `doc-materialize: ${paths === null ? "restored the whole cut" : "restored the named paths"}`,
            ...settlements.map((row) =>
              row.copy === null
                ? `${row.path}\t${row.action}`
                : `${row.path}\t${row.action}\tlocal bytes kept at ${row.copy}`,
            ),
            ...(conflicts.length > 0 ? ["left untouched:", ...conflicts] : []),
          ].join("\n"),
        }
      : {}),
  };
}

/** undefined = preview (bare), null = whole cut (--all), otherwise the explicit --path selection. */
function materializePaths(input: Input): readonly string[] | null | undefined {
  const action = input.action;
  if (typeof action.taskId === "string") {
    const taskFields = Object.hasOwn(action, "paths") ? ["kind", "paths", "taskId"] : ["kind", "taskId"];
    if (
      !hasExactDocSyncActionFields(action, taskFields) ||
      (Object.hasOwn(action, "paths") && (!Array.isArray(action.paths) || action.paths.length > 0))
    )
      throw docSyncError(
        "invalid_command",
        `doc materialize --task cannot be combined with another selection (fields: ${Object.keys(action).sort().join(", ")})`,
      );
    const task = input.projection.read(action.taskId);
    if (!task.snapshot.task || task.packagePath === null)
      throw docSyncError("entity_not_found", `Task ${action.taskId} has no materialized package path`);
    const paths: string[] = [];
    let afterPath: string | undefined;
    for (;;) {
      const documents = input.projection.readDocuments(`${task.packagePath}/`, {
        limit: storageReadPolicy.defaultValue.pageSizes.standard,
        includeHistory: true,
        ...(afterPath === undefined ? {} : { afterPath }),
      });
      if (documents.status !== "ready" || documents.watermark !== documents.sourceRevision)
        throw docSyncError("projection_pending", `Task ${action.taskId} document projection is still catching up`);
      paths.push(...documents.documents.map(({ path }) => path));
      if (documents.page!.nextPath === null) break;
      afterPath = documents.page!.nextPath;
    }
    return paths;
  }
  const selection = (fields: readonly string[]): readonly string[] | null | undefined => {
    if (!Array.isArray(action.paths) || action.paths.some((p) => typeof p !== "string"))
      throw docSyncError("invalid_command", "doc materialize --path takes document paths");
    if (fields.includes("all")) {
      if (action.all !== true) throw docSyncError("invalid_command", "doc materialize --all must be true");
      if (action.paths.length > 0)
        throw docSyncError("invalid_command", "doc materialize takes --path <path>... or --all, not both");
      return null;
    }
    return action.paths.length === 0 ? undefined : action.paths;
  };
  if (hasExactDocSyncActionFields(action, ["kind", "paths"])) return selection([]);
  if (hasExactDocSyncActionFields(action, ["kind", "paths", "all"])) return selection(["all"]);
  throw docSyncError("invalid_command", "doc materialize takes --path <path>... or --all, nothing else");
}
