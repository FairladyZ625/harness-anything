import {
  completionEvidenceBasis,
  currentGateRun,
  completionEvidenceResults,
  consumeKnownError,
  localGitObjectRefStore,
  resolveHarnessLayout,
  type CiObservationRead,
  type CompletionEvidenceBasis,
  type CompletionEvidenceProvenance,
  type CompletionEvidenceResult,
  type CompletionEvidenceV1,
  type FrozenGateRequirement,
  type SubmissionV1,
} from "@harness-anything/kernel";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { makeGitReadinessSource } from "./process-port.ts";
import type { Snapshot } from "./repo-cell-types.ts";

/**
 * A cut whose delivery commit no run on its frozen CI branch can ever cover: the commit is gone
 * from the canonical repository, or every commit of its unpublished fork already landed on the
 * branch under another SHA (cherry-pick, rebase). A fork that is merely unmerged still has patches to land.
 */
export function strandedDelivery(rootDir: string, submission: SubmissionV1 | null | undefined): boolean {
  const commitSha = submission?.commitSha,
    branch = submission?.completionContract?.gates.flatMap(({ witness }) =>
      witness.kind === "github-actions" ? [witness.adapterOptions.branch] : [],
    )[0];
  if (!commitSha || branch === undefined) return false;
  const git = makeGitReadinessSource(),
    target = `refs/remotes/origin/${branch}`;
  if (!git.run(rootDir, ["rev-parse", "--verify", "--quiet", `${target}^{commit}`]).ok) return false;
  if (!git.run(rootDir, ["cat-file", "-e", `${commitSha}^{commit}`]).ok) return true;
  // `git cherry` lists the fork's commits: "-" already upstream by patch id, "+" not yet landed.
  const cherry = git.run(rootDir, ["cherry", target, commitSha]),
    lines = cherry.stdout.split("\n").filter(Boolean);
  return cherry.ok && lines.length > 0 && lines.every((line) => line.startsWith("- "));
}

/**
 * The submitted execution of the task's current iteration and the github-actions requirement its
 * frozen contract judges, if the cut froze one. Callers that only need "is a passing witness
 * already recorded" pair this with githubActionsWitnessEvidence and stop before any provider IO.
 */
export function submittedGithubActionsRequirement(
  snapshot: Snapshot,
): { readonly requirement: FrozenGateRequirement; readonly execution: Snapshot["executions"][number] } | null {
  const execution = snapshot.executions.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    ),
    submission = execution?.submission,
    requirement = submission?.completionContract.gates.find((gate) => gate.witness.kind === "github-actions");
  return execution && submission && requirement ? { requirement, execution } : null;
}

/** A terminal run keeps its verdict until an explicit rerun; observations only judge a running run. */
export function githubActionsGateResult(
  cell: Parameters<typeof githubActionsWitnessEvidence>[0],
  requirement: FrozenGateRequirement,
  execution: Snapshot["executions"][number],
): CompletionEvidenceResult | null {
  if (!execution.submission?.commitSha) return null;
  const run = currentGateRun(execution, requirement.gateId);
  return run?.state === "completed"
    ? run.result
    : (githubActionsWitnessEvidence(cell, requirement, execution)?.result ?? null);
}

/**
 * The `github-actions` witness adapter: reads recorded CI run observations and judges them against
 * the adapter options frozen into the submission contract — workflows, branch, event, coverage
 * (exact SHA or descendant runs) and selection order. The private authored-ledger cut keeps its
 * separate `write-coordinator`/`ledger-publication` observation path; it has no GitHub run ordering.
 */
export function githubActionsWitnessEvidence(
  cell: Pick<RepoCellOperationalContext, "rootDir" | "projection" | "projectionReady" | "cellCodedError">,
  requirement: FrozenGateRequirement,
  execution: Snapshot["executions"][number] | undefined,
): CompletionEvidenceV1 | null {
  if (requirement.witness.kind !== "github-actions" || !execution?.submission?.commitSha) return null;
  const gateRun = currentGateRun(execution, requirement.gateId);
  if (!gateRun || gateRun.state !== "running") return null;
  const options = requirement.witness.adapterOptions;
  // Newest GitHub run and attempt first; non-push runs are measurements, not delivery verdicts.
  // Never skip a red/unverified push for an older green; cancelled/skipped: no verdict.
  const submitted = execution.submission.commitSha,
    publicCut = localGitObjectRefStore.hasCommit(cell.rootDir, submitted),
    root = publicCut ? cell.rootDir : resolveHarnessLayout(cell.rootDir).authoredRoot;
  if (publicCut && options.coverage === "descendant") {
    const readiness = cell.projection.readCiRunObservations(1);
    if (!cell.projectionReady(readiness))
      throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
    const targetHead = targetBranchHead(root, options.branch);
    if (targetHead !== null && !localGitObjectRefStore.isAncestor(root, submitted, targetHead)) return null;
  }
  const observations = cell.projection.readCiRunObservations(2000);
  if (!cell.projectionReady(observations))
    throw cell.cellCodedError("content_not_ready", "CI observation projection is not ready.");
  const covers =
    options.coverage === "descendant"
      ? (event: CiObservationRead) =>
          event.payload.run.sha === submitted ||
          localGitObjectRefStore.isAncestor(root, submitted, event.payload.run.sha)
      : (event: CiObservationRead) => event.payload.run.sha === submitted;
  const events =
      publicCut && options.selection === "newest"
        ? newestGithubRuns(
            observations.events.filter((event) => event.payload.scope !== "job" && event.payload.scope !== "attempt"),
          )
        : observations.events.filter((event) => event.payload.scope !== "job" && event.payload.scope !== "attempt"),
    workflows = publicCut ? options.workflows : [];
  for (const event of events) {
    if (!covers(event)) continue;
    const verification = event.payload.verification;
    if (publicCut && verification?.source === "github-actions" && verification.event !== options.event) continue;
    // Runs on other branches are measurements too: a pull-request branch rebased onto this delivery
    // descends from it, and its run must neither witness the delivery nor shadow the frozen branch's.
    if (publicCut && verification?.source === "github-actions" && event.payload.run.branch !== options.branch) continue;
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
        adapterId: requirement.witness.adapterId,
        runId: gateRun.runId,
        claimFence: gateRun.claimFence,
        rawResult: `event:${event.opId}`,
      };
    return {
      schema: "completion-evidence/v1",
      subjects: [],
      predicateType: requirement.witness.predicateType,
      predicate: {},
      diagnostic: `CI ${event.payload.run.runId}: ${result}`,
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

function targetBranchHead(root: string, branch: string): string | null {
  try {
    return localGitObjectRefStore.resolveCommit(root, `refs/remotes/origin/${branch}`);
  } catch (error) {
    consumeKnownError(error);
    return null;
  }
}

function githubRunOrder(event: CiObservationRead): readonly [bigint, bigint] | null {
  const match = /^(?<run>[1-9][0-9]*)\.(?<attempt>[1-9][0-9]*)$/u.exec(event.payload.run.runId);
  return match?.groups ? [BigInt(match.groups.run!), BigInt(match.groups.attempt!)] : null;
}

function newestGithubRuns(events: readonly CiObservationRead[]): readonly CiObservationRead[] {
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
