import type { PresetProcessService } from "@harness-anything/preset";
import { collectCommandWitness } from "./repo-cell-command-witness.ts";
import { createHash } from "node:crypto";
import {
  completionEvidenceBasis,
  currentGateRun,
  gateAppliesToSubmission,
  isHumanAttestationWitness,
  isSamePerson,
  judgeGateWitnesses,
  OVERRIDE_RATIONALE_MIN_LENGTH,
  validOverrideRationale,
  waivableAutomatedFail,
  type CompletionEvidenceV1,
  type FrozenGateRequirement,
  type WriteReceiptDraft as WriteReceipt,
} from "@harness-anything/kernel";
import type { RepoCellBinding, RepoTaskAction, Snapshot } from "./repo-cell-types.ts";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import { githubActionsWitnessEvidence } from "./repo-cell-ci-evidence.ts";

type Execution = Snapshot["executions"][number];

/** The latest automated (non-human-attestation) witness recorded for this gate on the cut. */
function recordedAutomatedWitness(
  snapshot: Snapshot,
  execution: Execution,
  gateId: string,
): Snapshot["gateWitnesses"][number] | undefined {
  if (execution.schema !== "execution/v1") return undefined;
  return snapshot.gateWitnesses
    .filter(
      (candidate) =>
        candidate.executionId === execution.executionId &&
        candidate.gateId === gateId &&
        candidate.commitSha === execution.submission?.commitSha &&
        candidate.iteration === execution.iteration &&
        candidate.provenance?.runId === currentGateRun(execution, gateId)?.runId &&
        !isHumanAttestationWitness(candidate),
    )
    .at(-1);
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
    process: PresetProcessService,
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

export const witnessAdapters: Readonly<Partial<Record<FrozenGateRequirement["witness"]["kind"], WitnessAdapter>>> = {
  "github-actions": {
    evaluate: (cell, requirement, execution) => githubActionsWitnessEvidence(cell, requirement, execution),
  },
  command: {
    collect: collectCommandWitness,
    evaluate: (_cell, _requirement, _execution, collected) => (collected as CompletionEvidenceV1 | undefined) ?? null,
  },
  manual: { evaluate: () => null },
  external: { evaluate: () => null },
};

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
  } else if (requirement.witness.kind !== "manual") {
    if (!requirement.mandatorySignoff)
      throw cell.cellCodedError(
        "invalid_command",
        `Gate ${gateId} is witnessed by ${requirement.witness.adapterId}, not manual attestation.`,
      );
    if (
      execution.schema !== "execution/v1" ||
      !["passed", "signoff_missing"].includes(
        judgeGateWitnesses(snapshot.gateWitnesses, execution, gateId, requirement).status,
      )
    )
      throw cell.cellCodedError(
        "invalid_transition",
        `Gate ${gateId} signoff requires its recorded automated pass on this cut; run ha task complete ${taskId} first.`,
      );
  }
  const actorId = binding.actor.principal.personId,
    note = typeof action.note === "string" && action.note ? `; ${action.note}` : "",
    evidence: CompletionEvidenceV1 = {
      schema: "completion-evidence/v1",
      subjects: [],
      predicateType: requirement.witness.kind === "internal" ? "" : requirement.witness.predicateType,
      predicate: {},
      diagnostic: String(action.note ?? action.rationale ?? "Human attestation"),
      evidenceId: `attest-${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${gateId}\0${result}\0${mode}`).digest("hex").slice(0, 24)}`,
      checkerId: gateId,
      gateId,
      result,
      observed: true,
      basis: completionEvidenceBasis(execution),
      provenance: {
        source: "human",
        adapterId: requirement.witness.adapterId,
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
