import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completionEvidenceBasis,
  gateAppliesToSubmission,
  isHumanAttestationWitness,
  isSamePerson,
  judgeCompletionEvidence,
  judgeGateWitnesses,
  OVERRIDE_RATIONALE_MIN_LENGTH,
  validOverrideRationale,
  waivableAutomatedFail,
  localGitObjectRefStore,
  submissionDigest,
  type CompletionEvidenceV1,
  type FrozenGateRequirement,
  type MappedWitnessAdapterId,
  type WriteReceiptDraft as WriteReceipt,
} from "../../kernel/src/index.ts";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { fetchCiObservations, ingestCiObservations } from "./ci-observation-actions.ts";
import { githubActionsWitnessEvidence } from "./repo-cell-ci-evidence.ts";
import { readDispatchStreamHeaders } from "./dispatch-stream.ts";
import { runProcessExitAsync, runProcessTextAsync } from "./process-port.ts";

type Execution = Snapshot["executions"][number];

/**
 * Observations collected outside the write queue ride on the action under this symbol; inside the
 * queue each adapter's evaluate re-judges them against the frozen cut before any canonical write.
 */
export const witnessCollections: unique symbol = Symbol("witnessCollections");

export type PendingWitnessCollections = ReadonlyMap<string, unknown>;

export function actionWitnessCollections(action: RepoTaskAction): PendingWitnessCollections | undefined {
  const carried = (action as Record<symbol, unknown>)[witnessCollections];
  return carried instanceof Map ? carried : undefined;
}

/** The latest automated (non-human-attestation) witness recorded for this gate on the cut. */
function recordedAutomatedWitness(
  snapshot: Snapshot,
  execution: Execution,
  gateId: string,
): Snapshot["gateWitnesses"][number] | undefined {
  return snapshot.gateWitnesses
    .filter(
      (candidate) =>
        candidate.executionId === execution.executionId &&
        candidate.gateId === gateId &&
        candidate.commitSha === execution.submission?.commitSha &&
        candidate.iteration === execution.iteration &&
        !isHumanAttestationWitness(candidate),
    )
    .at(-1);
}

/** Automated evidence the cut already recorded verbatim: publishing it again would only append a duplicate. */
export function recordedGateEvidence(snapshot: Snapshot, evidence: CompletionEvidenceV1): boolean {
  const recorded = snapshot.gateWitnesses
      .filter(
        (candidate) =>
          candidate.executionId === evidence.basis.executionId &&
          candidate.iteration === evidence.basis.iteration &&
          candidate.gateId === evidence.gateId &&
          !isHumanAttestationWitness(candidate),
      )
      .at(-1),
    recordedEvidence = recorded?.evidence;
  return (
    recorded?.result === evidence.result &&
    recordedEvidence?.kind === "observed" &&
    recordedEvidence.basis.submissionDigest === evidence.basis.submissionDigest &&
    recordedEvidence.provenance.runId === evidence.provenance.runId &&
    recordedEvidence.provenance.rawResult === evidence.provenance.rawResult
  );
}

/** A gate whose recorded automated fail is already waived on this cut needs no fresh observation. */
export function gateWaived(snapshot: Snapshot, execution: Execution, requirement: FrozenGateRequirement): boolean {
  return (
    requirement.allowOverride === true &&
    execution.schema === "execution/v1" &&
    judgeGateWitnesses(snapshot.gateWitnesses, execution, requirement.gateId, requirement).status === "waived"
  );
}

/** A witness the canonical write already accepted for this gate and cut needs no fresh evidence. */
export function acceptedGateWitness(
  snapshot: Snapshot,
  execution: Execution,
  gateId: string,
): Snapshot["gateWitnesses"][number] | null {
  const recorded = recordedAutomatedWitness(snapshot, execution, gateId);
  if (!recorded || recorded.evidence.kind !== "observed" || execution.schema !== "execution/v1") return null;
  const evidence = recorded.evidence;
  return judgeCompletionEvidence(
    {
      ...recorded,
      observed: evidence.observed,
      basis: evidence.basis,
      provenance: evidence.provenance,
      override: evidence.override,
    },
    { execution, gateId },
  ).accepted
    ? recorded
    : null;
}

export interface WitnessAdapter {
  /**
   * External collection: runs before the write queue. `ingest` (optional) appends durable
   * observations inside the queue; the collected value itself is carried on the action.
   */
  readonly collect?: (
    cell: RepoCellOperationalContext,
    requirement: FrozenGateRequirement,
    execution: Execution,
  ) => Promise<unknown>;
  readonly ingest?: (
    cell: RepoCellOperationalContext,
    binding: RepoCellBinding,
    collected: unknown,
  ) => WriteReceipt | void;
  /**
   * Judge the collected (or already-recorded) observations against the frozen cut inside the
   * canonical write. Returns null when nothing binding the current cut exists yet.
   */
  readonly evaluate: (
    cell: RepoCellOperationalContext,
    requirement: FrozenGateRequirement,
    execution: Execution | undefined,
    collected: unknown,
  ) => CompletionEvidenceV1 | null;
}

export const witnessAdapters: Readonly<Record<MappedWitnessAdapterId, WitnessAdapter>> = {
  "github-actions": {
    collect: (cell) => fetchCiObservations(cell, { kind: "ci-observe-pull" }),
    ingest: (cell, binding, collected) =>
      ingestCiObservations(cell, binding, collected as Parameters<typeof ingestCiObservations>[2]),
    evaluate: (cell, requirement, execution) => githubActionsWitnessEvidence(cell, requirement, execution),
  },
  "local-command": {
    collect: collectLocalCommand,
    evaluate: localCommandWitnessEvidence,
  },
  // manual-attest produces no runner observation: a human writes the witness through
  // `ha task attest`, judged by the same canonical admission as every other adapter.
  "manual-attest": { evaluate: () => null },
};

// -- local-command ------------------------------------------------------------

interface LocalCommandCollection {
  readonly kind: "local-command";
  readonly submissionDigest: string;
  readonly cutSha: string;
  readonly exitCode: number;
  readonly outputDigest: string;
  readonly outputTail: string;
}

/** A local command can still stall; ten minutes bounds the queue-external wait. */
const localCommandTimeoutMs = 600_000;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Materialize exactly the submitted commit into a scratch directory and run the frozen command
 * there. A commit that no reachable repository holds is unavailable evidence, not a verdict.
 */
async function collectLocalCommand(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  execution: Execution,
): Promise<LocalCommandCollection> {
  const submission = execution.submission!,
    witness = requirement.witness;
  if (witness.kind !== "adapter" || witness.adapterId !== "local-command")
    throw cell.cellCodedError(
      "invalid_command",
      `Gate ${requirement.gateId} has no local-command requirement in its frozen contract.`,
    );
  const command = witness.adapterOptions.command,
    cutSha = submission.commitSha;
  if (cutSha === null)
    throw cell.cellCodedError(
      "witness_unavailable",
      `Gate ${requirement.gateId} is witnessed by local-command, which requires a code commit cut; this submission is artifact-only.`,
    );
  const candidates = [
      cell.rootDir,
      ...readDispatchStreamHeaders(cell.rootDir)
        .filter(
          (dispatch) =>
            dispatch.taskId === execution.taskId && dispatch.executionId === execution.executionId && dispatch.cwd,
        )
        .map((dispatch) => dispatch.cwd!),
    ],
    root = [...new Set(candidates)].find((candidate) => localGitObjectRefStore.hasCommit(candidate, cutSha));
  if (!root)
    throw cell.cellCodedError(
      "witness_unavailable",
      `Submitted commit ${cutSha} is not materialized in a repository this node can read.`,
    );
  const workdir = mkdtempSync(path.join(tmpdir(), "ha-witness-local-"));
  try {
    await runProcessTextAsync(
      "sh",
      ["-c", `git -C ${shellQuote(root)} archive --format=tar ${cutSha} | tar -x -C ${shellQuote(workdir)}`],
      cell.rootDir,
      { PATH: process.env.PATH },
    );
    // A nonzero exit is the command's verdict — returned as a result, not thrown. Spawn failure,
    // signal, and timeout still reject as unavailable evidence, never a verdict.
    const { exitCode, stdout: output } = await runProcessExitAsync(
      "sh",
      ["-c", `${command} 2>&1`],
      workdir,
      {
        PATH: process.env.PATH,
        HARNESS_WITNESS_CUT: cutSha,
        HARNESS_WITNESS_GATE: requirement.gateId,
        // Repository-scoped observations (e.g. merged-to ancestry) read the source repo through
        // this handle; the extracted workdir carries no .git.
        HARNESS_WITNESS_REPO: root,
      },
      undefined,
      undefined,
      { timeoutMs: localCommandTimeoutMs },
    );
    return {
      kind: "local-command",
      submissionDigest: submissionDigest(submission),
      cutSha,
      exitCode,
      outputDigest: `sha256:${createHash("sha256").update(output).digest("hex")}`,
      outputTail: output.slice(-2000),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function localCommandWitnessEvidence(
  _cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  execution: Execution | undefined,
  collected: unknown,
): CompletionEvidenceV1 | null {
  const run = collected as LocalCommandCollection | undefined;
  if (run?.kind !== "local-command" || !execution?.submission) return null;
  // The observation binds the whole submitted cut: an amended digest or a different commit
  // makes a previously collected result stale evidence, and this adapter refuses it.
  if (run.cutSha !== execution.submission.commitSha || run.submissionDigest !== submissionDigest(execution.submission))
    return null;
  return {
    schema: "completion-evidence/v1",
    evidenceId: `local-${createHash("sha256").update(`${run.cutSha}\0${run.submissionDigest}`).digest("hex").slice(0, 24)}`,
    checkerId: requirement.gateId,
    gateId: requirement.gateId,
    result: run.exitCode === 0 ? "pass" : "fail",
    observed: true,
    basis: completionEvidenceBasis(execution),
    provenance: {
      source: "runner",
      adapterId: "local-command",
      runId: `local-${run.cutSha.slice(0, 12)}`,
      rawResult:
        `exit ${run.exitCode}; output ${run.outputDigest}; ` + `tail ${JSON.stringify(run.outputTail.slice(-500))}`,
    },
  };
}

// -- human attestation --------------------------------------------------------

const attestFields = ["kind", "taskId", "gateId", "result", "mode", "note", "rationale"];

/**
 * `ha task attest <task-id> --gate <gate-id> --result <pass|fail> [--mode approve|override]`: a human
 * principal's witness. `approve` witnesses a manual-attest gate or signs off a dual-control gate over
 * its recorded automated pass; `override` is the task owner's break-glass pass over the recorded
 * automated fail of a gate that allows it — or over the cut's absent automated receipt when the
 * environment never produced one. A runtime session carries an executor and never attests.
 * The canonical write entry still judges the evidence against the frozen contract.
 */
export function attestGateWitness(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    gateId = cell.requiredCellText(action.gateId, "gateId"),
    result = String(action.result ?? ""),
    mode = action.mode ?? "approve",
    read = cell.projection.read(taskId),
    snapshot = read.snapshot;
  const unknown = Object.keys(action).filter((field) => !attestFields.includes(field));
  if (unknown.length)
    throw cell.cellCodedError("invalid_command", `task-attest does not accept: ${unknown.join(", ")}.`);
  if (result !== "pass" && result !== "fail")
    throw cell.cellCodedError("invalid_field", "--result must be pass or fail.");
  if (mode !== "approve" && mode !== "override")
    throw cell.cellCodedError("invalid_field", "--mode must be approve or override.");
  if (mode === "override" && (result !== "pass" || !validOverrideRationale(action.rationale)))
    throw cell.cellCodedError(
      "invalid_field",
      `--mode override requires --result pass and a --rationale of at least ${OVERRIDE_RATIONALE_MIN_LENGTH} characters.`,
    );
  if (mode === "approve" && action.rationale !== undefined)
    throw cell.cellCodedError("invalid_field", "--rationale belongs to --mode override; use --note for approve.");
  if (binding.actor.executor !== null)
    throw cell.cellCodedError(
      "actor_unauthorized",
      `Gate attestation records a human principal; executor ${binding.actor.executor.id} cannot attest.`,
    );
  if (!cell.projectionReady(read) || !snapshot.task)
    throw cell.cellCodedError("content_not_ready", `Task ${taskId} is not ready for attestation.`);
  const execution = snapshot.executions.find(
      (candidate) => candidate.iteration === snapshot.task?.iteration && candidate.submission !== null,
    ),
    requirement = execution?.submission?.completionContract?.gates.find((gate) => gate.gateId === gateId);
  if (!execution?.submission)
    throw cell.cellCodedError("invalid_transition", "Attestation requires a submitted execution.");
  if (!requirement)
    throw cell.cellCodedError(
      "invalid_command",
      `Gate ${gateId} is not part of the frozen completion contract for this submission.`,
    );
  if (!gateAppliesToSubmission(requirement, execution.submission))
    throw cell.cellCodedError(
      "invalid_transition",
      `Gate ${gateId} applies to ${requirement.appliesTo}, which this submission does not deliver.`,
    );
  let override: CompletionEvidenceV1["override"];
  if (mode === "override") {
    if (!requirement.allowOverride)
      throw cell.cellCodedError("invalid_command", `Gate ${gateId} does not allow override in its frozen contract.`);
    if (!isSamePerson(snapshot.task.createdBy, binding.actor))
      throw cell.cellCodedError(
        "actor_unauthorized",
        `Override requires the task owner principal (personId=${snapshot.task.createdBy.principal.personId}).`,
      );
    const waivable =
      execution.schema === "execution/v1"
        ? waivableAutomatedFail(snapshot.gateWitnesses, execution, gateId)
        : undefined;
    if (waivable) {
      override = { rationale: String(action.rationale).trim(), waivedReceiptId: waivable.receiptId };
    } else if (recordedAutomatedWitness(snapshot, execution, gateId) === undefined) {
      // The environment never produced an automated receipt for this cut: the owner explicitly
      // waives the absent observation. Any receipt that lands later voids this waiver.
      override = { rationale: String(action.rationale).trim(), waivedReceiptId: null };
    } else {
      throw cell.cellCodedError(
        "invalid_transition",
        `Gate ${gateId} already has an automated witness on this cut; only a recorded fail can be waived.`,
      );
    }
  } else if (requirement.witness.kind !== "adapter" || requirement.witness.adapterId !== "manual-attest") {
    if (!requirement.mandatorySignoff)
      throw cell.cellCodedError(
        "invalid_command",
        requirement.witness.kind === "adapter"
          ? `Gate ${gateId} is witnessed by ${requirement.witness.adapterId}, not manual attestation.`
          : `Gate ${gateId} is a migration-preserved historical requirement; it cannot be attested.`,
      );
    if (!acceptedGateWitness(snapshot, execution, gateId))
      throw cell.cellCodedError(
        "invalid_transition",
        `Gate ${gateId} signoff requires its recorded automated pass on this cut; run ha task complete ${taskId} first.`,
      );
  }
  const actorId = binding.actor.principal.personId,
    note = typeof action.note === "string" && action.note ? `; ${action.note}` : "",
    evidence: CompletionEvidenceV1 = {
      schema: "completion-evidence/v1",
      evidenceId: `attest-${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${gateId}\0${result}\0${mode}`).digest("hex").slice(0, 24)}`,
      checkerId: gateId,
      gateId,
      result,
      observed: true,
      basis: completionEvidenceBasis(execution),
      provenance: {
        source: "human",
        adapterId: "manual-attest",
        runId: `${mode === "override" ? "override" : "attest"}:${actorId}`,
        rawResult: override
          ? override.waivedReceiptId === null
            ? `override with no automated receipt by ${actorId}: ${override.rationale}`
            : `override of ${override.waivedReceiptId} by ${actorId}: ${override.rationale}`
          : `${result} attested by ${actorId}${note}`,
      },
      ...(override ? { override } : {}),
    };
  return cell.publishGateWitness(taskId, execution.executionId, snapshot, read.packagePath, binding, evidence);
}
