import {
  completionEvidenceBasis,
  completionEvidenceResults,
  localGitObjectRefStore,
  resolveHarnessLayout,
  type CiRunObservationEventV3,
  type CompletionEvidenceBasis,
  type CompletionEvidenceProvenance,
  type CompletionEvidenceResult,
  type CompletionEvidenceV1,
  type FrozenGateRequirement,
} from "../../kernel/src/index.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { Snapshot } from "./repo-cell-types.ts";

/**
 * The `github-actions` witness adapter: reads recorded CI run observations and judges them against
 * the adapter options frozen into the submission contract — workflows, branch, event, coverage
 * (exact SHA or descendant runs) and selection order. The private authored-ledger cut keeps its
 * separate `write-coordinator`/`ledger-publication` observation path; it has no GitHub run ordering.
 */
export function githubActionsWitnessEvidence(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  execution: Snapshot["executions"][number] | undefined,
): CompletionEvidenceV1 | null {
  if (
    requirement.witness.kind !== "adapter" ||
    requirement.witness.adapterId !== "github-actions" ||
    !execution?.submission?.commitSha
  )
    return null;
  const options = requirement.witness.adapterOptions;
  const observations = cell.projection.readCiRunObservations(2000);
  if (!cell.projectionReady(observations))
    throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
  // Newest GitHub run and attempt first; non-push runs are measurements, not delivery verdicts.
  // Never skip a red/unverified push for an older green; cancelled/skipped: no verdict.
  const submitted = execution.submission.commitSha,
    publicCut = localGitObjectRefStore.hasCommit(cell.rootDir, submitted),
    root = publicCut ? cell.rootDir : resolveHarnessLayout(cell.rootDir).authoredRoot,
    covers =
      options.coverage === "descendant"
        ? (event: CiRunObservationEventV3) =>
            event.payload.run.sha === submitted ||
            localGitObjectRefStore.isAncestor(root, submitted, event.payload.run.sha)
        : (event: CiRunObservationEventV3) => event.payload.run.sha === submitted;
  const events =
      publicCut && options.selection === "newest" ? newestGithubRuns(observations.events) : observations.events,
    workflows = publicCut ? options.workflows : [];
  for (const event of events) {
    if (!covers(event)) continue;
    const verification = event.payload.verification;
    if (publicCut && verification?.source === "github-actions" && verification.event !== options.event) continue;
    // Runs of workflows outside the frozen option list are measurements, not delivery
    // verdicts: they never shadow the configured workflow's runs, whichever conclusion.
    if (
      publicCut &&
      verification?.source === "github-actions" &&
      event.payload.run.branch === options.branch &&
      !workflows.includes(verification.workflow)
    )
      continue;
    if (
      !localGitObjectRefStore.hasCommit(root, submitted) ||
      !verification ||
      (publicCut
        ? verification.source !== "github-actions" || event.payload.run.branch !== options.branch
        : verification.source !== "write-coordinator" || verification.workflow !== "ledger-publication")
    )
      throw cell.cellCodedError(
        "invalid_proof",
        publicCut
          ? `Public delivery requires a verified ${workflows.join(" or ")} GitHub ${options.branch} run.`
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
        adapterId: "github-actions",
        runId: event.payload.run.runId,
        rawResult: `event:${event.opId}`,
      };
    return {
      schema: "completion-evidence/v1",
      evidenceId: `ci-${event.opId}`,
      checkerId: requirement.gateId,
      gateId: requirement.gateId,
      result,
      observed: true,
      basis,
      provenance,
    };
  }
  return null;
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
