import { stableStringify } from "@harness-anything/kernel";
import { touch } from "./doc-sync-details.ts";
import { docSyncError, hasExactDocSyncActionFields, proof, rejectDocSyncAction } from "./doc-sync-files.ts";
import { workspacePathOf } from "./doc-sync-settlement.ts";
import type { Action, DocSettlementReceipt, Input } from "./doc-sync-command-actions.ts";

/**
 * `doc materialize` never settles the worktree by implication. Bare, it previews what a whole-closure
 * restore would touch and demands an explicit confirmation; `paths` restores one named selection;
 * `all` runs the previewed whole-closure pass. Every confirmed run reports each settled path and,
 * where the overwritten local bytes were kept, the conflict copy beside it.
 */
export function runDocMaterialize(input: Input): DocSettlementReceipt {
  const paths = materializePaths(input.action),
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
      copy: row.copy === null ? null : workspacePath(row.copy),
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
function materializePaths(action: Action): readonly string[] | null | undefined {
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
