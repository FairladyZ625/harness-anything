import { mkdirSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { localGitObjectRefStore } from "@harness-anything/storage";
import {
  completionBlockers,
  completionEvidenceBasis,
  completionGuidance,
  currentGateRun,
  gateAppliesToSubmission,
  isHumanAttestationWitness,
  validCompletionWitnessResult,
  type CompletionEvidenceV1,
  type CompletionWitnessResult,
  type FrozenGateRequirement,
} from "@harness-anything/kernel";
import { completionPredicateIssues } from "@harness-anything/kernel/schemas";
import type { PresetProcessService, PresetSnapshotV1 } from "@harness-anything/preset";
import type { RepoCellOperationalContext } from "./repo-cell-types.ts";
import type { Snapshot } from "./repo-cell-types.ts";
import {
  createSubmissionArtifactReader,
  submissionArtifactPath,
} from "@harness-anything/application/internal/commands/submission-artifacts.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { createHostScratchDirectory } from "./host-environment-io.ts";

interface LiveCanonicalDocumentAnchor {
  readonly path: string;
  readonly revision: number;
  readonly blobSha256: string;
}

const UPSTREAM_FRESH_PREDICATE_TYPE = "office-collab/upstream-fresh/v1";
const SHA256_RE = /^[0-9a-f]{64}$/u;
const SAFE_CANONICAL_REF = /^(?!\/)(?:(?!\.\.?\/)[^/\\:<>"|?*\0]+\/)*(?!\.\.?$)[^/\\:<>"|?*\0]+$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

type ParsedJsonRecordResult =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: unknown };

function parseJsonRecord(bytes: Uint8Array): ParsedJsonRecordResult {
  const text = Buffer.from(bytes).toString("utf8").trim();
  if (!text.startsWith("{")) return { ok: false, error: "not_json_object" };
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ok: true, value: parsed as Record<string, unknown> }
      : { ok: false, error: "not_json_record" };
  } catch (error) {
    return { ok: false, error };
  }
}

function normalizeLedgerPath(rawRef: unknown): string | null {
  if (typeof rawRef !== "string") return null;
  const trimmed = rawRef.trim();
  if (!trimmed || !SAFE_CANONICAL_REF.test(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed).normalize("NFC");
  if (
    normalized !== trimmed ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => segment.length === 0 || WINDOWS_RESERVED_SEGMENT.test(segment))
  ) {
    return null;
  }
  return normalized;
}

function canonicalBaselinePath(packagePath: string, item: Record<string, unknown>): string | null {
  const ref = normalizeLedgerPath(item.ref);
  if (!ref) return null;
  if (ref.startsWith("artifacts/")) {
    if (item.sourcePath !== undefined) {
      const sourcePath = normalizeLedgerPath(item.sourcePath);
      return sourcePath && !sourcePath.startsWith("artifacts/") ? sourcePath : null;
    }
    return submissionArtifactPath(packagePath, ref);
  }
  // Direct canonical ledger refs bind strictly to themselves; sourcePath never substitutes another document.
  return item.sourcePath === undefined ? ref : null;
}

function resolveLiveCanonicalDocuments(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  packagePath: string,
  subjects: readonly { readonly path: string }[],
  accepted: ReadonlyMap<string, Uint8Array>,
): Record<string, LiveCanonicalDocumentAnchor | null> {
  const paths = new Set<string>();
  const isUpstreamFreshGate =
    requirement.witness.kind === "command" && requirement.witness.predicateType === UPSTREAM_FRESH_PREDICATE_TYPE;
  for (const subject of subjects) {
    paths.add(subject.path);
    if (!isUpstreamFreshGate) continue;
    const bytes = accepted.get(subject.path);
    if (!bytes) continue;
    const parsed = parseJsonRecord(bytes);
    if (!parsed.ok) continue;
    const record = parsed.value;
    if (Array.isArray(record.baselines)) {
      for (const baseline of record.baselines) {
        if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) continue;
        const resolved = canonicalBaselinePath(packagePath, baseline as Record<string, unknown>);
        if (resolved) paths.add(resolved);
      }
    }
  }
  const canonicalDocuments: Record<string, LiveCanonicalDocumentAnchor | null> = {};
  for (const canonicalPath of paths) {
    const document = cell.projection.readDocument(canonicalPath).document;
    canonicalDocuments[canonicalPath] = document
      ? { path: document.path, revision: document.workspaceRevision, blobSha256: document.blobSha256 }
      : null;
  }
  return canonicalDocuments;
}

/**
 * Verifies every live canonical upstream anchor emitted by a passing `office-collab/upstream-fresh/v1`
 * witness atomically inside the serial RepoCell `completeTask` write path, without mutating gate runs
 * or affecting unrelated command gates.
 */
export function liveUpstreamFreshnessBlocker(
  cell: RepoCellOperationalContext,
  snapshot: Snapshot,
  executionId: string,
): ReturnType<typeof completionBlockers>[number] | null {
  const task = snapshot.task;
  const execution = snapshot.executions.find(
    (value) =>
      value.schema === "execution/v1" && value.executionId === executionId && value.iteration === task?.iteration,
  );
  if (!task || !execution?.submission) return null;
  for (const requirement of execution.submission.completionContract.gates) {
    if (
      !gateAppliesToSubmission(requirement, execution.submission) ||
      requirement.witness.kind !== "command" ||
      requirement.witness.predicateType !== UPSTREAM_FRESH_PREDICATE_TYPE
    ) {
      continue;
    }
    const activeRun = currentGateRun(execution, requirement.gateId);
    if (!activeRun || activeRun.state !== "completed" || activeRun.result !== "pass") continue;
    const witness = snapshot.gateWitnesses
      .filter(
        (value) =>
          value.gateId === requirement.gateId &&
          value.executionId === execution.executionId &&
          value.iteration === execution.iteration &&
          value.commitSha === execution.submission?.commitSha &&
          value.provenance?.runId === activeRun.runId &&
          !isHumanAttestationWitness(value),
      )
      .at(-1);
    if (!witness || witness.result !== "pass") continue;
    const rawAnchors = witness.predicate?.verifiedAnchors;
    const rerunAction =
      `ha task witness-rerun ${task.taskId} --execution-id ${executionId} ` +
      `--gate ${requirement.gateId} --run-id ${activeRun.runId} --reason <reason>`;
    if (!Array.isArray(rawAnchors) || rawAnchors.length === 0) {
      return {
        code: "gate_witness_missing",
        gate: requirement.gateId,
        next: completionGuidance(
          snapshot,
          executionId,
          rerunAction,
          `Upstream freshness witness for ${requirement.gateId} lacks verifiedAnchors; rerun ${requirement.gateId} before completion.`,
        ),
      };
    }
    for (const entry of rawAnchors) {
      const record =
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : null;
      const ref = record ? normalizeLedgerPath(record.ref) : null;
      const expectedSha256 =
        record && typeof record.expectedSha256 === "string" && SHA256_RE.test(record.expectedSha256)
          ? record.expectedSha256
          : null;
      if (!ref || !expectedSha256) {
        return {
          code: "gate_witness_missing",
          gate: requirement.gateId,
          next: completionGuidance(
            snapshot,
            executionId,
            rerunAction,
            `Upstream freshness witness for ${requirement.gateId} carries an invalid verifiedAnchor entry.`,
          ),
        };
      }
      const live = cell.projection.readDocument(ref).document;
      if (!live) {
        return {
          code: "gate_witness_missing",
          gate: requirement.gateId,
          next: completionGuidance(
            snapshot,
            executionId,
            rerunAction,
            `Missing live canonical upstream anchor for "${ref}": upstream-fresh requires a current accepted canonical anchor.`,
          ),
        };
      }
      if (live.blobSha256 !== expectedSha256) {
        return {
          code: "gate_witness_missing",
          gate: requirement.gateId,
          next: completionGuidance(
            snapshot,
            executionId,
            rerunAction,
            `Live upstream drift on "${ref}": expected ${expectedSha256.slice(0, 12)}, live canonical ${live.blobSha256.slice(0, 12)}.`,
          ),
        };
      }
    }
  }
  return null;
}

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
    readArtifact = createSubmissionArtifactReader(cell),
    allSubjects = (submission.artifacts ?? []).map((anchor, index) => {
      const document = readArtifact(packagePath, anchor.path, anchor.revision, anchor.blobSha256),
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
  let codeRoot: string | undefined, scratch: ReturnType<typeof createHostScratchDirectory> | undefined;
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
      scratch = createHostScratchDirectory("completionWitness");
      codeRoot = path.join(scratch.directory, "code");
      /* @gate-identity non-state/environment-io.fce35847c1d968e8 */ mkdirSync(codeRoot);
      const archive = path.join(scratch.directory, "code.tar"),
        env = { PATH: globalThis.process.env.PATH, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_SYSTEM: devNull };
      await runProcessTextAsync(
        "git",
        ["archive", "--format=tar", `--output=${archive}`, submission.commitSha],
        root,
        env,
      );
      await runProcessTextAsync("tar", ["-xf", archive, "-C", codeRoot], scratch.directory, env);
    }
    const canonicalDocuments = resolveLiveCanonicalDocuments(cell, requirement, packagePath, subjects, accepted);
    inputs["witness.json"] = Buffer.from(
      JSON.stringify({
        schema: "witness-input/v1",
        repoId: cell.input.repoId,
        taskId: execution.taskId,
        executionId: execution.executionId,
        iteration: execution.iteration,
        packagePath,
        submissionDigest: run.submissionDigest,
        gateId: requirement.gateId,
        gateRunId: run.runId,
        code: submission.commitSha ? { commitSha: submission.commitSha, directory: "input/code" } : null,
        subjects,
        artifacts: allSubjects,
        canonicalDocuments,
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
    scratch?.close();
  }
}
