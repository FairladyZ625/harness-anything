import { mkdirSync } from "node:fs";
import path from "node:path";
import { localGitObjectRefStore } from "@harness-anything/storage";
import {
  completionBlockers,
  completionEvidenceBasis,
  completionGuidance,
  currentGateRun,
  gateAppliesToSubmission,
  isHumanAttestationWitness,
  sha256Bytes,
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
const UPSTREAM_FRESH_MANIFEST_PATH = "artifacts/upstream-freshness.json";
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

function isUpstreamFreshRequirement(requirement: FrozenGateRequirement): boolean {
  return requirement.witness.kind === "command" && requirement.witness.predicateType === UPSTREAM_FRESH_PREDICATE_TYPE;
}

function extractUpstreamManifestAnchors(
  packagePath: string,
  bytes: Uint8Array,
): { readonly anchors: ReadonlyArray<readonly [string, string]>; readonly anchorsDigest: string } | null {
  const parsed = parseJsonRecord(bytes);
  if (!parsed.ok || !Array.isArray(parsed.value.baselines) || parsed.value.baselines.length === 0) return null;
  const anchors: Array<readonly [string, string]> = [];
  for (const entry of parsed.value.baselines) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const ref = canonicalBaselinePath(packagePath, record);
    const expectedSha256 =
      typeof record.expectedSha256 === "string" && SHA256_RE.test(record.expectedSha256) ? record.expectedSha256 : null;
    if (!ref || !expectedSha256) return null;
    anchors.push([ref, expectedSha256]);
  }
  const anchorsDigest = sha256Bytes(Buffer.from(JSON.stringify(anchors), "utf8"));
  return { anchors, anchorsDigest };
}

function resolveLiveCanonicalDocuments(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  packagePath: string,
  subjects: readonly { readonly path: string }[],
  accepted: ReadonlyMap<string, Uint8Array>,
): Record<string, LiveCanonicalDocumentAnchor | null> | undefined {
  if (!isUpstreamFreshRequirement(requirement)) return undefined;
  const paths = new Set<string>();
  for (const subject of subjects) {
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
 * Verifies every live canonical upstream anchor pinned by a passing `office-collab/upstream-fresh/v1`
 * witness atomically inside the serial RepoCell `completeTask` write path, reconstructing anchors from
 * the pinned frozen manifest so the witness frame stays O(1) within the 64 KiB execution budget.
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
  let packagePath: string | null | undefined;
  let readArtifact: ReturnType<typeof createSubmissionArtifactReader> | undefined;
  for (const requirement of execution.submission.completionContract.gates) {
    if (!gateAppliesToSubmission(requirement, execution.submission) || !isUpstreamFreshRequirement(requirement)) {
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
    const rerunAction =
      `ha task witness-rerun ${task.taskId} --execution-id ${executionId} ` +
      `--gate ${requirement.gateId} --run-id ${activeRun.runId} --reason <reason>`;
    const blocker = (reason: string) => ({
      code: "gate_witness_missing" as const,
      gate: requirement.gateId,
      next: completionGuidance(snapshot, executionId, rerunAction, reason),
    });
    const predicateDigest =
      typeof witness.predicate?.anchorsDigest === "string" && SHA256_RE.test(witness.predicate.anchorsDigest)
        ? witness.predicate.anchorsDigest
        : null;
    const baselineCount =
      typeof witness.predicate?.baselineCount === "number" &&
      Number.isSafeInteger(witness.predicate.baselineCount) &&
      witness.predicate.baselineCount > 0
        ? witness.predicate.baselineCount
        : null;
    if (!predicateDigest || baselineCount === null) {
      return blocker(
        `Upstream freshness witness for ${requirement.gateId} lacks a valid anchorsDigest; rerun ${requirement.gateId} before completion.`,
      );
    }
    if (packagePath === undefined) packagePath = cell.projection.read(task.taskId).packagePath ?? null;
    const manifestPath = packagePath ? submissionArtifactPath(packagePath, UPSTREAM_FRESH_MANIFEST_PATH) : null;
    const manifestAnchor = manifestPath
      ? (execution.submission.artifacts ?? []).find((item) => item.path === manifestPath)
      : undefined;
    const witnessBindsManifest =
      manifestAnchor !== undefined &&
      (witness.subjects ?? []).some(
        (subject) =>
          subject.path === manifestAnchor.path &&
          subject.revision === manifestAnchor.revision &&
          subject.blobSha256 === manifestAnchor.blobSha256,
      );
    if (!packagePath || !manifestAnchor || !witnessBindsManifest) {
      return blocker(
        `Upstream freshness witness for ${requirement.gateId} is not bound to the pinned ${UPSTREAM_FRESH_MANIFEST_PATH} artifact.`,
      );
    }
    readArtifact ??= createSubmissionArtifactReader(cell);
    const frozenManifest = readArtifact(
      packagePath,
      manifestAnchor.path,
      manifestAnchor.revision,
      manifestAnchor.blobSha256,
    );
    const extracted = extractUpstreamManifestAnchors(
      packagePath,
      Buffer.from(frozenManifest.body, frozenManifest.encoding),
    );
    if (!extracted || extracted.anchors.length !== baselineCount || extracted.anchorsDigest !== predicateDigest) {
      return blocker(
        `Upstream freshness witness for ${requirement.gateId} anchorsDigest disagrees with pinned ${UPSTREAM_FRESH_MANIFEST_PATH}; rerun ${requirement.gateId} before completion.`,
      );
    }
    for (const [ref, expectedSha256] of extracted.anchors) {
      const live = cell.projection.readDocument(ref).document;
      if (!live) {
        return blocker(
          `Missing live canonical upstream anchor for "${ref}": upstream-fresh requires a current accepted canonical anchor.`,
        );
      }
      if (live.blobSha256 !== expectedSha256) {
        return blocker(
          `Live upstream drift on "${ref}": expected ${expectedSha256.slice(0, 12)}, live canonical ${live.blobSha256.slice(0, 12)}.`,
        );
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
        gitConfigNull = globalThis.process.platform === "win32" ? "NUL" : "/dev/null",
        env = {
          PATH: globalThis.process.env.PATH,
          GIT_CONFIG_GLOBAL: gitConfigNull,
          GIT_CONFIG_SYSTEM: gitConfigNull,
        };
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
        ...(canonicalDocuments !== undefined ? { canonicalDocuments } : {}),
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
