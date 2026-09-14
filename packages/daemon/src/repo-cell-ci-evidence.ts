import {
  completionGateIds,
  completionEvidenceBasis,
  completionEvidenceResults,
  localGitObjectRefStore,
  resolveHarnessLayout,
  type CiRunObservationEventV3,
  type CompletionEvidenceBasis,
  type CompletionEvidenceProvenance,
  type CompletionEvidenceResult,
  type CompletionEvidenceV1,
} from "../../kernel/src/index.ts";

export function ciGateApplies(taskGateIds: readonly string[], commitSha: string | null | undefined): boolean {
  return completionGateIds(taskGateIds, commitSha).includes("ci");
}
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { Snapshot } from "./repo-cell-types.ts";

function relatedCiObservation(root: string, event: CiRunObservationEventV3, submitted: string): boolean {
  return (
    event.payload.run.sha === submitted || localGitObjectRefStore.isAncestor(root, submitted, event.payload.run.sha)
  );
}

export function readLatestCiEvidence(
  cell: RepoCellOperationalContext,
  execution: Snapshot["executions"][number] | undefined,
): CompletionEvidenceV1 | null {
  if (!execution?.submission?.commitSha) return null;
  const observations = cell.projection.readCiRunObservations(2000);
  if (!cell.projectionReady(observations))
    throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
  // Newest observation first; never skip a red/unverified run for an older green; cancelled/skipped: no verdict.
  const submitted = execution.submission.commitSha,
    publicCut = localGitObjectRefStore.hasCommit(cell.rootDir, submitted),
    root = publicCut ? cell.rootDir : resolveHarnessLayout(cell.rootDir).authoredRoot;
  for (const event of observations.events) {
    if (!relatedCiObservation(root, event, submitted)) continue;
    const verification = event.payload.verification;
    if (
      !localGitObjectRefStore.hasCommit(root, submitted) ||
      !verification ||
      (publicCut
        ? verification.source !== "github-actions" ||
          !cell.settings.read().ci.workflows.includes(verification.workflow) ||
          event.payload.run.branch !== "main"
        : verification.source !== "write-coordinator" || verification.workflow !== "ledger-publication")
    )
      throw cell.cellCodedError(
        "invalid_proof",
        publicCut
          ? `Public delivery requires a verified ${cell.settings.read().ci.workflows.join(" or ")} GitHub main run.`
          : "Private delivery requires a verified ledger-publication observation for its authored cut.",
      );
    if (verification.conclusion === "cancelled" || verification.conclusion === "skipped") continue;
    const result: CompletionEvidenceResult = verification.conclusion === "success" ? "pass" : "fail";
    if (!completionEvidenceResults.includes(result)) return null;
    const basis: CompletionEvidenceBasis = {
        ...completionEvidenceBasis(execution),
        ledgerCut: event.workspaceRevision,
      },
      provenance: CompletionEvidenceProvenance = {
        source: "runner",
        runId: event.payload.run.runId,
        rawResult: `event:${event.opId}`,
      };
    return {
      schema: "completion-evidence/v1",
      evidenceId: `ci-${event.opId}`,
      checkerId: "ci",
      gateId: "ci",
      result,
      observed: true,
      basis,
      provenance,
    };
  }
  return null;
}

export function readApplicableCiEvidence(
  cell: RepoCellOperationalContext,
  execution: Snapshot["executions"][number] | undefined,
  taskGateIds: readonly string[],
): CompletionEvidenceV1 | null {
  return ciGateApplies(taskGateIds, execution?.submission?.commitSha) ? readLatestCiEvidence(cell, execution) : null;
}
