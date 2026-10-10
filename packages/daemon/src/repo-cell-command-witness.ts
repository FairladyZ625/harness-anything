import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import path from "node:path";
import {
  completionEvidenceBasis,
  completionPredicateIssues,
  currentGateRun,
  localGitObjectRefStore,
  validCompletionWitnessResult,
  type CompletionEvidenceV1,
  type CompletionWitnessResult,
  type FrozenGateRequirement,
} from "@harness-anything/kernel";
import type { PresetProcessService, PresetSnapshotV1 } from "@harness-anything/preset";
import type { RepoCellOperationalContext } from "./repo-cell-action-context.ts";
import type { Snapshot } from "./repo-cell-types.ts";
import { readSubmissionArtifact, submissionArtifactPath } from "./submission-artifacts.ts";
import { runProcessTextAsync } from "./process-port.ts";

/** Runs accepted package bytes against the exact submitted input, outside the single writer queue. */
export async function collectCommandWitness(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  execution: Snapshot["executions"][number],
  process: PresetProcessService,
): Promise<CompletionEvidenceV1> {
  if (execution.schema !== "execution/v1")
    throw cell.cellCodedError("gate_run_stale", "Archived executions cannot start a gate run.");
  const submission = execution.submission!,
    run = currentGateRun(execution, requirement.gateId),
    packagePath = cell.projection.read(execution.taskId).packagePath;
  if (!run || run.state !== "running" || !packagePath)
    throw cell.cellCodedError("gate_run_unclaimed", `Gate ${requirement.gateId} requires a current central claim.`);
  const preset = cell.projection.readPresetSnapshot(submission.completionContract.presetSnapshotDigest)
      .snapshot as PresetSnapshotV1,
    command = preset.completionPackages[run.sourceId];
  if (!command)
    throw cell.cellCodedError(
      "witness_unavailable",
      `Frozen source ${requirement.witness.adapterId} has no command package.`,
    );
  const inputs: Record<string, Uint8Array> = {},
    accepted = new Map<string, Uint8Array>(),
    allSubjects = (submission.artifacts ?? []).map((anchor, index) => {
      const document = readSubmissionArtifact(cell, packagePath, anchor.path, anchor.revision, anchor.blobSha256),
        bytes = Buffer.from(document.body, document.encoding),
        file = `artifact-${index}`;
      inputs[file] = bytes;
      accepted.set(document.anchor.path, bytes);
      return { ...document.anchor, file: `input/${file}` };
    }),
    names =
      requirement.subjects === undefined || requirement.subjects === "all-artifacts"
        ? null
        : requirement.subjects.map((name) => submissionArtifactPath(packagePath, name)),
    subjects = allSubjects.filter((subject) => names === null || names.includes(subject.path));
  if (names?.some((name) => !subjects.some((subject) => subject.path === name)))
    throw cell.cellCodedError(
      "witness_unavailable",
      `Gate ${requirement.gateId} names a subject absent from the frozen submission.`,
    );
  const anchors = subjects.map(({ file: _file, ...anchor }) => anchor);
  let codeRoot: string | undefined, scratch: string | undefined;
  try {
    if (submission.commitSha) {
      const candidates = [
          cell.rootDir,
          ...cell.projection
            .readRuntimeDispatchesByTaskExecution(execution.taskId, execution.executionId)
            .map(({ event }) => event.payload.cwd)
            .filter((cwd): cwd is string => typeof cwd === "string"),
        ],
        root = [...new Set(candidates)].find((candidate) =>
          localGitObjectRefStore.hasCommit(candidate, submission.commitSha!),
        );
      if (!root)
        throw cell.cellCodedError(
          "witness_unavailable",
          `Submitted commit ${submission.commitSha} is not available on this node.`,
        );
      scratch = mkdtempSync(path.join(tmpdir(), "ha-witness-code-"));
      codeRoot = path.join(scratch, "code");
      mkdirSync(codeRoot);
      const archive = path.join(scratch, "code.tar"),
        env = { PATH: globalThis.process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
      await runProcessTextAsync(
        "git",
        ["archive", "--format=tar", `--output=${archive}`, submission.commitSha],
        root,
        env,
      );
      await runProcessTextAsync("tar", ["-xf", archive, "-C", codeRoot], scratch, env);
    }
    inputs["witness.json"] = Buffer.from(
      JSON.stringify({
        schema: "witness-input/v1",
        repoId: cell.input.repoId,
        taskId: execution.taskId,
        executionId: execution.executionId,
        iteration: execution.iteration,
        submissionDigest: run.submissionDigest,
        gateId: requirement.gateId,
        gateRunId: run.runId,
        code: submission.commitSha ? { commitSha: submission.commitSha, directory: "input/code" } : null,
        subjects,
      }),
    );
    let produced: CompletionWitnessResult | undefined;
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const started = await process.startFrozen(
      {
        presetId: command.id,
        entrypoint: requirement.witness.kind === "command" ? requirement.witness.entrypoint : "",
        taskId: execution.taskId,
        inputs: { witnessInput: "input/witness.json" },
        idempotencyKey: run.runId,
      },
      { package: command, snapshotDigest: preset.digest, inputFiles: inputs, ...(codeRoot ? { codeRoot } : {}) },
      {
        onSettled: finish,
        admitProduce: (kind) => kind === "completion-witness",
        publish: async ({ kind: _kind, ...payload }) => {
          if (!validCompletionWitnessResult(payload))
            return {
              outcome: "op_rejected",
              code: "invalid_proof",
              nextAction: "Result must match completion-witness payload.",
            };
          const issues = completionPredicateIssues(requirement, payload, anchors, (logical) => {
            const bytes = accepted.get(submissionArtifactPath(packagePath, logical));
            if (!bytes) return undefined;
            return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
          });
          if (
            issues.length &&
            (payload.result === "pass" || issues.some((issue) => /\.(?:subjects|predicateType) /.test(issue)))
          )
            return { outcome: "op_rejected", code: "invalid_proof", nextAction: issues.join("; ") };
          produced = { ...payload, diagnostic: [payload.diagnostic, ...issues].filter(Boolean).join("; ") };
          return { outcome: "applied" };
        },
      },
    );
    await settled;
    const status = process.status(started.runId);
    if (status.outcome !== "applied" || !produced)
      throw cell.cellCodedError(
        "witness_unavailable",
        status.nextAction ?? `Gate run ${run.runId} produced no result.`,
      );
    return {
      schema: "completion-evidence/v1",
      evidenceId: run.runId,
      checkerId: requirement.gateId,
      gateId: requirement.gateId,
      observed: true,
      basis: completionEvidenceBasis(execution),
      provenance: {
        source: "runner",
        claimFence: run.claimFence,
        adapterId: run.sourceId,
        runId: run.runId,
        rawResult: `preset-run:${started.runId}; ${produced.diagnostic}`,
      },
      ...produced,
    };
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
