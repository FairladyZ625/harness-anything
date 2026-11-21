import { mkdirSync } from "node:fs";
import { devNull } from "node:os";
import path from "node:path";
import { localGitObjectRefStore } from "@harness-anything/storage";
import {
  completionEvidenceBasis,
  currentGateRun,
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

function canonicalPathForRef(packagePath: string, rawRef: unknown): string | null {
  if (typeof rawRef !== "string") return null;
  const trimmed = rawRef.trim();
  if (!trimmed || !SAFE_CANONICAL_REF.test(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed).normalize("NFC");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.split("/").some((segment) => WINDOWS_RESERVED_SEGMENT.test(segment))
  ) {
    return null;
  }
  return normalized.startsWith("artifacts/") ? submissionArtifactPath(packagePath, normalized) : normalized;
}

function resolveLiveCanonicalDocuments(
  cell: RepoCellOperationalContext,
  packagePath: string,
  subjects: readonly { readonly path: string }[],
  accepted: ReadonlyMap<string, Uint8Array>,
): Record<string, LiveCanonicalDocumentAnchor | null> {
  const paths = new Set<string>();
  const addRef = (rawRef: unknown): void => {
    const resolved = canonicalPathForRef(packagePath, rawRef);
    if (resolved) paths.add(resolved);
  };
  for (const subject of subjects) {
    paths.add(subject.path);
    const bytes = accepted.get(subject.path);
    if (!bytes) continue;
    const parsed = parseJsonRecord(bytes);
    if (!parsed.ok) continue;
    const record = parsed.value;
    if (Array.isArray(record.baselines)) {
      for (const baseline of record.baselines) {
        if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) continue;
        const item = baseline as Record<string, unknown>;
        addRef(item.ref);
        addRef(item.sourcePath);
      }
    }
    addRef(record.documentPath);
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

/** Returns a rerun reason when any live canonical upstream baseline declared by this gate drifted after prior pass. */
export function canonicalBaselineDriftReason(
  cell: RepoCellOperationalContext,
  requirement: FrozenGateRequirement,
  execution: Snapshot["executions"][number],
): string | null {
  if (execution.schema !== "execution/v1" || !execution.submission) return null;
  const packagePath = cell.projection.read(execution.taskId).packagePath;
  if (!packagePath) return null;
  const names =
    requirement.subjects === undefined || requirement.subjects === "all-artifacts"
      ? null
      : requirement.subjects.map((name) => submissionArtifactPath(packagePath, name));
  const readArtifact = createSubmissionArtifactReader(cell);
  for (const anchor of execution.submission.artifacts ?? []) {
    const artifactPath = submissionArtifactPath(packagePath, anchor.path);
    if (names !== null && !names.includes(artifactPath)) continue;
    const document = readArtifact(packagePath, anchor.path, anchor.revision, anchor.blobSha256);
    const parsed = parseJsonRecord(Buffer.from(document.body, document.encoding));
    if (!parsed.ok || !Array.isArray(parsed.value.baselines)) continue;
    for (const baseline of parsed.value.baselines) {
      if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) continue;
      const item = baseline as Record<string, unknown>;
      const canonicalPath = canonicalPathForRef(packagePath, item.sourcePath ?? item.ref);
      const expectedSha256 = typeof item.expectedSha256 === "string" ? item.expectedSha256 : null;
      if (!canonicalPath || !expectedSha256) continue;
      const live = cell.projection.readDocument(canonicalPath).document;
      if (!live || live.blobSha256 !== expectedSha256) {
        return `Live canonical upstream baseline ${canonicalPath} changed since prior witness run.`;
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
    const canonicalDocuments = resolveLiveCanonicalDocuments(cell, packagePath, subjects, accepted);
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
