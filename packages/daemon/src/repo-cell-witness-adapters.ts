import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  completionEvidenceBasis,
  consumeKnownError,
  gateAppliesToSubmission,
  judgeCompletionEvidence,
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
import { runProcessTextAsync } from "./process-port.ts";

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

/** A witness the canonical write already accepted for this gate and cut needs no fresh evidence. */
export function acceptedGateWitness(
  snapshot: Snapshot,
  execution: Execution,
  gateId: string,
): Snapshot["gateWitnesses"][number] | null {
  const recorded = snapshot.gateWitnesses.find(
    (candidate) =>
      candidate.executionId === execution.executionId &&
      candidate.gateId === gateId &&
      candidate.commitSha === execution.submission?.commitSha &&
      candidate.iteration === execution.iteration,
  );
  return recorded?.basis &&
    recorded.provenance &&
    recorded.observed !== undefined &&
    execution.schema === "execution/v1" &&
    judgeCompletionEvidence(
      { ...recorded, basis: recorded.basis, provenance: recorded.provenance, observed: recorded.observed },
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
    command = (requirement.witness.adapterOptions as { readonly command: string }).command,
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
    let exitCode: number, output: string;
    try {
      output = await runProcessTextAsync(
        "sh",
        ["-c", `${command} 2>&1`],
        workdir,
        {
          PATH: process.env.PATH,
          HARNESS_WITNESS_CUT: cutSha,
          HARNESS_WITNESS_GATE: requirement.gateId,
        },
        undefined,
        undefined,
        { timeoutMs: localCommandTimeoutMs },
      );
      exitCode = 0;
    } catch (error) {
      const failure = error as { status?: number; stdout?: string },
        spawnExit = typeof failure.status === "number" ? failure.status : undefined;
      // Spawn failure, signal, or timeout is unavailable evidence, never a verdict.
      if (spawnExit === undefined) throw error;
      // A nonzero exit is the command's verdict — consumed as evidence, not a swallowed failure.
      consumeKnownError(error);
      exitCode = spawnExit;
      output = typeof failure.stdout === "string" ? failure.stdout : "";
    }
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

// -- manual-attest ------------------------------------------------------------

/**
 * `ha task attest <task-id> --gate <gate-id> --result <pass|fail>`: a human's own witness for a
 * gate the contract declared `manual-attest`. The actor admission and the canonical write entry
 * (declared adapter === evidence provenance) stay exactly where they are.
 */
export function attestGateWitness(
  cell: RepoCellOperationalContext,
  action: RepoTaskAction,
  binding: RepoCellBinding,
): WriteReceipt {
  const taskId = cell.requiredCellText(action.taskId, "taskId"),
    gateId = cell.requiredCellText(action.gateId, "gateId"),
    result = String(action.result ?? ""),
    read = cell.projection.read(taskId),
    snapshot = read.snapshot;
  if (result !== "pass" && result !== "fail")
    throw cell.cellCodedError("invalid_field", "--result must be pass or fail.");
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
  if (requirement.witness.adapterId !== "manual-attest")
    throw cell.cellCodedError(
      "invalid_command",
      `Gate ${gateId} is witnessed by ${requirement.witness.adapterId}, not manual attestation.`,
    );
  const actorId = binding.actor.executor?.id ?? binding.actor.principal.personId,
    note = typeof action.note === "string" && action.note ? `; ${action.note}` : "",
    evidence: CompletionEvidenceV1 = {
      schema: "completion-evidence/v1",
      evidenceId: `attest-${createHash("sha256").update(`${taskId}\0${execution.executionId}\0${gateId}\0${result}`).digest("hex").slice(0, 24)}`,
      checkerId: gateId,
      gateId,
      result,
      observed: true,
      basis: completionEvidenceBasis(execution),
      provenance: {
        source: "human",
        adapterId: "manual-attest",
        runId: `attest:${actorId}`,
        rawResult: `${result} attested by ${actorId}${note}`,
      },
    };
  return cell.publishGateWitness(taskId, execution.executionId, snapshot, read.packagePath, binding, evidence);
}
