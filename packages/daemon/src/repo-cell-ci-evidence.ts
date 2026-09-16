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
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { Snapshot } from "./repo-cell-types.ts";

export function ciGateApplies(taskGateIds: readonly string[], commitSha: string | null | undefined): boolean {
  return completionGateIds(taskGateIds, commitSha).includes("ci");
}

function relatedCiObservation(root: string, event: CiRunObservationEventV3, submitted: string): boolean {
  return (
    event.payload.run.sha === submitted || localGitObjectRefStore.isAncestor(root, submitted, event.payload.run.sha)
  );
}

function githubRunOrder(event: CiRunObservationEventV3): readonly [bigint, bigint] | null {
  const match = /^(?<run>[1-9][0-9]*)\.(?<attempt>[1-9][0-9]*)$/u.exec(event.payload.run.runId);
  return match?.groups ? [BigInt(match.groups.run!), BigInt(match.groups.attempt!)] : null;
}

function newestGithubRuns(events: readonly CiRunObservationEventV3[]): readonly CiRunObservationEventV3[] {
  const ordered = events
      .map((event, index) => ({ event, index, order: githubRunOrder(event) }))
      .sort((left, right) => {
        if (left.order && right.order) {
          if (left.order[0] !== right.order[0]) return left.order[0] > right.order[0] ? -1 : 1;
          if (left.order[1] !== right.order[1]) return left.order[1] > right.order[1] ? -1 : 1;
        } else if (left.order || right.order) return left.order ? -1 : 1;
        return left.index - right.index;
      }),
    seen = new Set<string>();
  return ordered.flatMap(({ event, order }) => {
    if (!order) return [event];
    const key = `${order[0]}.${order[1]}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [event];
  });
}

export function readLatestCiEvidence(
  cell: RepoCellOperationalContext,
  execution: Snapshot["executions"][number] | undefined,
): CompletionEvidenceV1 | null {
  if (!execution?.submission?.commitSha) return null;
  const observations = cell.projection.readCiRunObservations(2000);
  if (!cell.projectionReady(observations))
    throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
  // Newest GitHub run and attempt first; non-push runs are measurements, not delivery verdicts.
  // Never skip a red/unverified push for an older green; cancelled/skipped: no verdict.
  const submitted = execution.submission.commitSha,
    publicCut = localGitObjectRefStore.hasCommit(cell.rootDir, submitted),
    root = publicCut ? cell.rootDir : resolveHarnessLayout(cell.rootDir).authoredRoot;
  const events = publicCut ? newestGithubRuns(observations.events) : observations.events,
    workflows = publicCut ? cell.settings.read().ci.workflows : [];
  for (const event of events) {
    if (!relatedCiObservation(root, event, submitted)) continue;
    const verification = event.payload.verification;
    if (publicCut && verification?.source === "github-actions" && verification.event !== "push") continue;
    // Runs of workflows outside settings.ci.workflows are measurements, not delivery
    // verdicts: they never shadow the configured workflow's runs, whichever conclusion.
    if (
      publicCut &&
      verification?.source === "github-actions" &&
      event.payload.run.branch === "main" &&
      !workflows.includes(verification.workflow)
    )
      continue;
    if (
      !localGitObjectRefStore.hasCommit(root, submitted) ||
      !verification ||
      (publicCut
        ? verification.source !== "github-actions" || event.payload.run.branch !== "main"
        : verification.source !== "write-coordinator" || verification.workflow !== "ledger-publication")
    )
      throw cell.cellCodedError(
        "invalid_proof",
        publicCut
          ? `Public delivery requires a verified ${workflows.join(" or ")} GitHub main run.`
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
