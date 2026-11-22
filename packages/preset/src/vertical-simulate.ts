import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  INITIAL_SETTINGS_V1,
  completionBlockers,
  emptyTaskLifecycleSnapshot,
  resolveCompletionContract,
  submissionDigest,
  validCompletionWitnessResult,
  type AgentDeclarationV1,
  type ArtifactDelivery,
  type CompletionWitnessResult,
  type ExecutionV1,
  type FrozenGateRequirement,
  type TaskLifecycleSnapshot,
  type TaskV2,
} from "@harness-anything/kernel";
import { completionPredicateIssues } from "@harness-anything/kernel/schemas";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration } from "./bundled-agent-declarations.ts";
import { loadCanonicalAssets, resolveVerticalAssetsRoot } from "./preset-assets.ts";
import { compileTaskPackage, type CompiledTaskPackage } from "./preset-bootstrap.ts";
import { enumerateUser } from "./preset-catalog.ts";
import { catalogRecovery } from "./preset-discovery.ts";
import { parsePresetJson } from "./preset-json.ts";
import { createPresetProcessService } from "./preset-process-service.ts";
import { compileRepositoryScaffold } from "./preset-repository-scaffold.ts";
import {
  asFailure,
  builtinVerticalRoots,
  normalizeLocale,
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import { createRuntime, resolveDefaultPresetSelection, resolveWorkPresetId } from "./preset-runtime.ts";
import { validateVerticalSource } from "./preset-validation.ts";
import { createSimulationSandbox } from "./vertical-scaffold-io.ts";
import type { PresetFailure } from "./preset-resolver-types.ts";

export interface SimulationSamplePair {
  readonly positive: Readonly<Record<string, string>>;
  readonly negative: Readonly<Record<string, string>>;
}

export interface SimulateVerticalInput {
  readonly rootDir: string;
  readonly source: string;
  readonly presetId?: string;
  readonly profileId?: string;
  readonly locale?: string;
  readonly userRoot: string;
  readonly samplePayloads?: Readonly<Record<string, SimulationSamplePair>>;
}

export interface SimulatedDocumentPreview {
  readonly slot: string;
  readonly path: string;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly body: string;
}

export interface SimulatedGateProbeResult {
  readonly expected: "pass" | "fail";
  readonly ok: boolean;
  readonly result: "pass" | "fail" | "error";
  readonly diagnostic: string;
  readonly predicateIssues: readonly string[];
  readonly predicate?: Readonly<Record<string, unknown>>;
  readonly blockerCode?: string | null;
}

export interface SimulatedGateReport {
  readonly gateId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly ok: boolean;
  readonly positive: SimulatedGateProbeResult;
  readonly negative: SimulatedGateProbeResult;
}

export interface SimulatedDiagnostic {
  readonly scope: "vertical" | "bootstrap" | "agents" | "materialization" | "gate" | "user-pointer";
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

export interface VerticalSimulateReport {
  readonly schema: "vertical-simulate-report/v1";
  readonly ok: boolean;
  readonly zeroLedgerWrites: true;
  readonly locale: "zh-CN" | "en-US";
  readonly vertical: {
    readonly id: string | null;
    readonly title: string | null;
    readonly version: string | null;
    readonly source: string;
    readonly valid: boolean;
    readonly issues: readonly PresetFailure[];
  };
  readonly bootstrap: {
    readonly ok: boolean;
    readonly defaultPresetId: string | null;
    readonly defaultProfileId: string | null;
    readonly workPresetId: string | null;
    readonly issues: readonly PresetFailure[];
  };
  readonly agents: {
    readonly ok: boolean;
    readonly ids: readonly string[];
    readonly declarations: readonly Pick<AgentDeclarationV1, "id" | "name" | "role" | "instructions">[];
    readonly issues: readonly PresetFailure[];
  };
  readonly previews: {
    readonly repository: readonly SimulatedDocumentPreview[];
    readonly regularTask: {
      readonly presetId: string;
      readonly profileId: string;
      readonly outputShape: string;
      readonly completionGates: readonly string[];
      readonly snapshotDigest: string;
      readonly documents: readonly SimulatedDocumentPreview[];
    } | null;
    readonly workTask: {
      readonly presetId: string;
      readonly profileId: string;
      readonly outputShape: string;
      readonly snapshotDigest: string;
      readonly documents: readonly SimulatedDocumentPreview[];
    } | null;
  };
  readonly gates: readonly SimulatedGateReport[];
  readonly diagnostics: readonly SimulatedDiagnostic[];
}

const simSummaryText = "Simulation preview submission.",
  simSequenceNumber = 1,
  simStartTime = "2026-11-22T00:00:00.000Z",
  simEndTime = "2026-11-22T00:00:01.000Z";

function tryStep<T>(
  operation: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: PresetFailure } {
  try {
    return { ok: true, value: operation() };
  } catch (error) {
    return { ok: false, failure: asFailure(error) };
  }
}

function resolveSourceRoot(source: string, rootDir: string): string {
  const explicitBuiltin = source.startsWith("builtin:"),
    builtinId = explicitBuiltin ? source.slice("builtin:".length) : source;
  if (explicitBuiltin && builtinVerticalRoots.has(builtinId)) return builtinVerticalRoots.get(builtinId)!;
  if (builtinVerticalRoots.has(builtinId)) return resolveVerticalAssetsRoot(builtinId, rootDir);
  const direct = path.resolve(rootDir, source);
  return existsSync(direct) ? direct : resolveVerticalAssetsRoot(source, rootDir);
}

function collectBrokenUserPointerDiagnostics(userRoot: string, verticalId: string | null): SimulatedDiagnostic[] {
  const diagnostics: SimulatedDiagnostic[] = [];
  for (const candidate of enumerateUser(userRoot)) {
    if (candidate.decoded) continue;
    if (verticalId !== null && candidate.verticalId !== "*" && candidate.verticalId !== verticalId) continue;
    const error = candidate.error ?? presetFailure("invalid_package", "User preset package is invalid."),
      recovery = catalogRecovery(candidate, error);
    diagnostics.push({
      scope: "user-pointer",
      severity: "warning",
      code: error.code,
      message: `Broken user preset pointer "${candidate.id}": ${error.message}`,
      remediation: recovery.nextAction,
    });
  }
  return diagnostics;
}

function readSampleFile(filePath: string): Readonly<Record<string, string>> | null {
  if (!existsSync(filePath) || lstatSync(filePath).isSymbolicLink() || !lstatSync(filePath).isFile()) return null;
  const parsed = parsePresetJson(readFileSync(filePath, "utf8"), "invalid_sample") as Record<string, unknown>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !parsed.artifacts ||
    typeof parsed.artifacts !== "object"
  )
    return null;
  const result: Record<string, string> = {};
  for (const [artifactPath, value] of Object.entries(parsed.artifacts as Record<string, unknown>))
    result[artifactPath] = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  return result;
}

function synthesizeSamplesFromRequirement(requirement: FrozenGateRequirement): SimulationSamplePair | null {
  const source = requirement.witness;
  if (source.kind !== "command") return null;
  const schema = source.resultSchema as Record<string, unknown>,
    properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>,
    required = Array.isArray(schema.required) ? (schema.required as string[]) : [],
    bindings = requirement.bindings ?? {},
    subjects = Array.isArray(requirement.subjects) ? requirement.subjects : [];
  if (subjects.length === 0) return null;
  const positiveDoc: Record<string, unknown> = {},
    negativeDoc: Record<string, unknown> = {};
  const setByPointer = (target: Record<string, unknown>, pointer: string, value: unknown): void => {
    const parts = pointer.replace(/^\//u, "").split("/").filter(Boolean);
    if (parts.length === 0) return;
    let cursor: Record<string, unknown> = target;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const segment = parts[index]!;
      if (typeof cursor[segment] !== "object" || cursor[segment] === null) cursor[segment] = {};
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[parts.at(-1)!] = value;
  };
  const sampleValue = (prop: Record<string, unknown> | undefined): unknown => {
    if (!prop) return "sample";
    if ("const" in prop) return prop.const;
    if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
    if (prop.type === "boolean") return true;
    if (prop.type === "integer" || prop.type === "number") return typeof prop.minimum === "number" ? prop.minimum : 1;
    if (typeof prop.pattern === "string" && prop.pattern.includes("64")) return "0".repeat(64);
    return "sample-value";
  };
  for (const field of new Set([...required, ...Object.keys(bindings)])) {
    const value = sampleValue(properties[field]),
      binding = bindings[field];
    if (binding) setByPointer(positiveDoc, binding.pointer, value);
    else positiveDoc[field] = value;
  }
  const primarySubject = subjects[0]!;
  return {
    positive: { [primarySubject]: `${JSON.stringify(positiveDoc, null, 2)}\n` },
    negative: { [primarySubject]: `${JSON.stringify(negativeDoc, null, 2)}\n` },
  };
}

function loadGateSamples(input: {
  readonly assetsRoot: string;
  readonly requirement: FrozenGateRequirement;
  readonly override?: SimulationSamplePair;
}): SimulationSamplePair | null {
  if (input.override) return input.override;
  const sampleDir = path.join(input.assetsRoot, "samples", input.requirement.gateId),
    positive = readSampleFile(path.join(sampleDir, "positive.json")),
    negative = readSampleFile(path.join(sampleDir, "negative.json"));
  if (positive && negative) return { positive, negative };
  return synthesizeSamplesFromRequirement(input.requirement);
}

function buildSimulatedSnapshot(
  compiled: CompiledTaskPackage,
  contract: Extract<ReturnType<typeof resolveCompletionContract>, { readonly ok: true }>,
  artifacts: readonly ArtifactDelivery[],
  gateId: string,
  runId: string,
  witness: CompletionWitnessResult,
): TaskLifecycleSnapshot {
  const submission: NonNullable<ExecutionV1["submission"]> = {
    commitSha: null,
    completionClaim: simSummaryText,
    deliverables: artifacts.map(({ path: artifactPath }) => artifactPath),
    artifacts,
    outputs: [],
    verificationNotes: [],
    knownGaps: [],
    residualRisks: [],
    completionContract: contract.contract,
  };
  const digest = submissionDigest(submission),
    gateRequirement = contract.contract.gates.find((gate) => gate.gateId === gateId)!,
    sourceId =
      gateRequirement.witness.kind === "command" ||
      gateRequirement.witness.kind === "external" ||
      gateRequirement.witness.kind === "manual"
        ? (gateRequirement.witness.adapterId ?? gateId)
        : gateId,
    actor = { principal: { personId: "person_simulator" }, executor: { kind: "agent" as const, id: "simulator" } },
    task: TaskV2 = {
      schema: "task/v2",
      taskId: "task_sim_regular_0001",
      title: "Simulation Preview Task",
      packagePath: compiled.packagePath,
      status: "submitted",
      currentNode: "review",
      iteration: 1,
      metadata: compiled.metadata,
      presetSnapshotDigest: compiled.snapshot.digest,
      scaffoldDigest: compiled.scaffoldDigest,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:01.000Z",
      archivedAt: null,
      createdBy: { principal: { personId: "person_simulator" }, executor: null },
      owner: { principal: { personId: "person_simulator" }, executor: null },
    } as unknown as TaskV2,
    gateWitness: TaskLifecycleSnapshot["gateWitnesses"][number] = {
      schema: "completion-gate-witness/v1",
      witnessId: `wit-${runId}`,
      receiptId: `rcpt-${runId}`,
      checkerId: gateId,
      taskId: "task_sim_regular_0001",
      executionId: "exe_sim_0001",
      iteration: 1,
      gateId,
      commitSha: null,
      result: witness.result,
      observed: true,
      subjects: witness.subjects,
      predicateType: witness.predicateType,
      predicate: witness.predicate,
      diagnostic: witness.diagnostic,
      basis: {
        executionId: "exe_sim_0001",
        iteration: 1,
        submissionDigest: digest,
      },
      provenance: {
        source: "runner",
        claimFence: simSequenceNumber,
        adapterId: sourceId,
        runId,
        rawResult: witness.diagnostic,
      },
      actor,
      source: "local",
      verifiedAt: simEndTime,
    },
    execution: ExecutionV1 = {
      schema: "execution/v1",
      executionId: "exe_sim_0001",
      taskId: "task_sim_regular_0001",
      nodeId: "implementation",
      iteration: 1,
      state: "submitted",
      actor,
      claimedAt: simStartTime,
      submittedAt: simEndTime,
      closedAt: null,
      submission,
      gateRuns: [
        {
          runId,
          claimFence: simSequenceNumber,
          repoId: "sim-repo",
          taskId: "task_sim_regular_0001",
          executionId: "exe_sim_0001",
          iteration: 1,
          submissionDigest: digest,
          gateId,
          sourceId,
          actor,
          claimedAt: simEndTime,
          expiresAt: "2026-11-22T00:10:01.000Z",
          state: "completed",
          settledAt: simEndTime,
          availability: "available",
          result: witness.result,
          diagnostic: witness.diagnostic,
          supersedesRunId: null,
        },
      ],
    };
  return {
    ...emptyTaskLifecycleSnapshot(2),
    task,
    executions: [execution],
    gateWitnesses: [gateWitness],
  };
}

async function runSingleGateProbe(input: {
  readonly sandboxDir: string;
  readonly sandboxUserRoot: string;
  readonly verticalId: string;
  readonly compiled: CompiledTaskPackage;
  readonly contract: Extract<ReturnType<typeof resolveCompletionContract>, { readonly ok: true }>;
  readonly requirement: FrozenGateRequirement;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly expected: "pass" | "fail";
  readonly idempotencyKey: string;
}): Promise<SimulatedGateProbeResult> {
  const { compiled, requirement, artifacts, expected } = input;
  if (requirement.witness.kind !== "command") {
    return {
      expected,
      ok: false,
      result: "error",
      diagnostic: `Gate ${requirement.gateId} is not a command source (${requirement.witness.kind}).`,
      predicateIssues: [],
      blockerCode: null,
    };
  }
  const frozenPackage = compiled.snapshot.completionPackages[requirement.witness.adapterId];
  if (!frozenPackage) {
    return {
      expected,
      ok: false,
      result: "error",
      diagnostic: `Completion source ${requirement.witness.adapterId} has no frozen command package.`,
      predicateIssues: [],
      blockerCode: null,
    };
  }
  const inputFiles: Record<string, Uint8Array> = {},
    allSubjects: Array<ArtifactDelivery & { readonly file: string }> = [],
    canonicalDocuments: Record<
      string,
      { readonly path: string; readonly revision: number; readonly blobSha256: string }
    > = {};
  let index = 0;
  for (const [logicalPath, body] of Object.entries(artifacts)) {
    const key = `artifact-${index++}`,
      bytes = Buffer.from(body, "utf8"),
      fullPath = `${compiled.packagePath}/${logicalPath}`,
      digest = resolverContentHash(body);
    inputFiles[key] = bytes;
    allSubjects.push({ path: fullPath, revision: 1, blobSha256: digest, file: `input/${key}` });
    canonicalDocuments[fullPath] = { path: fullPath, revision: 1, blobSha256: digest };
  }
  const names =
      requirement.subjects === undefined || requirement.subjects === "all-artifacts"
        ? null
        : requirement.subjects.map((name) => `${compiled.packagePath}/${name}`),
    subjects = allSubjects.filter((subject) => names === null || names.includes(subject.path)),
    anchors = subjects.map(({ file: _file, ...identity }) => identity);
  inputFiles["witness.json"] = Buffer.from(
    JSON.stringify({
      schema: "witness-input/v1",
      packagePath: compiled.packagePath,
      code: null,
      subjects,
      artifacts: allSubjects,
      canonicalDocuments,
    }),
    "utf8",
  );
  const service = createPresetProcessService({
    rootDir: input.sandboxDir,
    userRoot: input.sandboxUserRoot,
    runRoot: path.join(input.sandboxDir, "preset-runs"),
    readSettings: () => ({
      ...INITIAL_SETTINGS_V1,
      defaultVertical: input.verticalId,
      defaultPreset: compiled.snapshot.identity.id,
      defaultProfile: compiled.snapshot.profile.id,
    }),
  });
  let witness: CompletionWitnessResult | undefined;
  let finish!: () => void;
  const settled = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const started = await service.startFrozen(
      {
        presetId: frozenPackage.id,
        entrypoint: requirement.witness.entrypoint,
        taskId: "task_sim_regular_0001",
        inputs: { witnessInput: "input/witness.json" },
        idempotencyKey: input.idempotencyKey,
      },
      { package: frozenPackage, snapshotDigest: compiled.snapshot.digest, inputFiles },
      {
        onSettled: finish,
        admitProduce: (kind) => kind === "completion-witness",
        publish: async ({ kind: _kind, ...payload }) => {
          if (!validCompletionWitnessResult(payload))
            return { outcome: "op_rejected", code: "invalid_proof", nextAction: "Invalid completion-witness payload." };
          witness = payload;
          return { outcome: "applied" };
        },
      },
    );
    if (started.outcome === "started") await settled;
    const status = service.status(started.runId);
    if (status.outcome !== "applied" || !witness) {
      return {
        expected,
        ok: false,
        result: "error",
        diagnostic: status.nextAction ?? `Gate probe ${input.idempotencyKey} did not produce a witness.`,
        predicateIssues: [],
        blockerCode: status.code ?? "witness_unavailable",
      };
    }
    const predicateIssues = completionPredicateIssues(requirement, witness, anchors, (logical) => {
      const raw = artifacts[logical];
      if (raw === undefined) return undefined;
      const parsed = tryStep(() => parsePresetJson(raw, "invalid_sample"));
      return parsed.ok ? parsed.value : undefined;
    });
    const effectiveWitness: CompletionWitnessResult =
      predicateIssues.length > 0 && witness.result === "pass"
        ? {
            ...witness,
            result: "fail",
            diagnostic: [witness.diagnostic, ...predicateIssues].filter(Boolean).join("; "),
          }
        : witness;
    const snapshot = buildSimulatedSnapshot(
        compiled,
        input.contract,
        anchors,
        requirement.gateId,
        started.runId,
        effectiveWitness,
      ),
      blockers = completionBlockers(snapshot, "exe_sim_0001", {
        closeout: "ready",
        closeoutPath: `${compiled.packagePath}/closeout.md`,
        eligibleDirtyPaths: [],
        closeoutGates: { review: false, consent: false, factDisposition: false },
      }),
      gateBlocker = blockers.find((blocker) => blocker.gate === requirement.gateId),
      actualPassed = effectiveWitness.result === "pass" && predicateIssues.length === 0 && !gateBlocker;
    return {
      expected,
      ok: expected === "pass" ? actualPassed : !actualPassed,
      result: actualPassed ? "pass" : "fail",
      diagnostic: effectiveWitness.diagnostic,
      predicateIssues,
      predicate: effectiveWitness.predicate,
      blockerCode: gateBlocker?.code ?? null,
    };
  } finally {
    await service.close();
  }
}

/** Zero-side-effect vertical dry-run simulator shared by CLI `ha vertical simulate` and GUI-FDE. */
export async function simulateVerticalPackage(input: SimulateVerticalInput): Promise<VerticalSimulateReport> {
  const rootDir = path.resolve(input.rootDir),
    userRoot = path.resolve(input.userRoot),
    locale = normalizeLocale(input.locale ?? "en-US"),
    diagnostics: SimulatedDiagnostic[] = [];
  const validation = validateVerticalSource({
    source: input.source,
    rootDir,
    ...(input.presetId ? { presetId: input.presetId } : {}),
    userRoot,
  });
  const validatedVertical = "vertical" in validation ? validation.vertical : undefined,
    verticalId = validatedVertical?.id ?? null;
  diagnostics.push(...collectBrokenUserPointerDiagnostics(userRoot, verticalId));
  for (const issue of validation.issues)
    diagnostics.push({ scope: "vertical", severity: "error", code: issue.code, message: issue.message });
  if (!validation.valid || verticalId === null || !validatedVertical) {
    return {
      schema: "vertical-simulate-report/v1",
      ok: false,
      zeroLedgerWrites: true,
      locale,
      vertical: {
        id: verticalId,
        title: validatedVertical?.title ?? null,
        version: validatedVertical?.version ?? null,
        source: validation.source,
        valid: false,
        issues: validation.issues,
      },
      bootstrap: { ok: false, defaultPresetId: null, defaultProfileId: null, workPresetId: null, issues: [] },
      agents: { ok: false, ids: [], declarations: [], issues: [] },
      previews: { repository: [], regularTask: null, workTask: null },
      gates: [],
      diagnostics,
    };
  }

  const assetsRoot = resolveSourceRoot(input.source, rootDir),
    sandbox = createSimulationSandbox("ha-vertical-simulate-"),
    sandboxUserRoot = path.join(sandbox.directory, "user-presets");
  try {
    // 1. Resolve bootstrap defaults and work-root preset without touching repo state.
    const bootstrapIssues: PresetFailure[] = [];
    let defaultPresetId: string | null = null,
      defaultProfileId: string | null = null,
      workPresetId: string | null = null;
    const defaultSelectionStep = tryStep(() =>
      resolveDefaultPresetSelection({
        repoRoot: rootDir,
        assetsRoot,
        userRoot,
        verticalId,
        ...(input.presetId ? { presetId: input.presetId } : {}),
      }),
    );
    if (defaultSelectionStep.ok) {
      defaultPresetId = defaultSelectionStep.value.presetId;
      defaultProfileId = input.profileId ?? defaultSelectionStep.value.profileId;
    } else {
      bootstrapIssues.push(defaultSelectionStep.failure);
      diagnostics.push({
        scope: "bootstrap",
        severity: "error",
        code: defaultSelectionStep.failure.code,
        message: defaultSelectionStep.failure.message,
      });
    }
    const workSelectionStep = tryStep(() =>
      resolveWorkPresetId({ repoRoot: rootDir, assetsRoot, userRoot, verticalId }),
    );
    if (workSelectionStep.ok) {
      workPresetId = workSelectionStep.value;
    } else {
      bootstrapIssues.push(workSelectionStep.failure);
      diagnostics.push({
        scope: "bootstrap",
        severity: "error",
        code: workSelectionStep.failure.code,
        message: workSelectionStep.failure.message,
      });
    }

    // 2. Repository scaffold materialization preview (against empty sandbox root so all files show created).
    let repositoryPreview: SimulatedDocumentPreview[] = [];
    const repoPlanStep = tryStep(() =>
      compileRepositoryScaffold({
        rootDir: sandbox.directory,
        verticalId,
        locale,
        assetsRoot,
      }),
    );
    if (repoPlanStep.ok) {
      repositoryPreview = repoPlanStep.value.documents.map((doc) => ({
        slot: doc.slot,
        path: doc.path,
        mediaType: doc.mediaType,
        contentSha256: doc.contentSha256,
        body: doc.body,
      }));
    } else {
      diagnostics.push({
        scope: "materialization",
        severity: "error",
        code: repoPlanStep.failure.code,
        message: repoPlanStep.failure.message,
      });
    }

    // 3. Regular task and taskClass="work" task materialization preview.
    let compiledRegular: CompiledTaskPackage | null = null,
      compiledWork: CompiledTaskPackage | null = null;
    if (defaultPresetId !== null) {
      const regularStep = tryStep(() =>
        compileTaskPackage({
          repoRoot: rootDir,
          assetsRoot,
          userRoot,
          taskId: "task_sim_regular_0001",
          title: `${validatedVertical.title} Simulation Task`,
          presetId: defaultPresetId,
          verticalId,
          ...(defaultProfileId ? { profileId: defaultProfileId } : {}),
          locale,
        }),
      );
      if (regularStep.ok) {
        compiledRegular = regularStep.value;
      } else {
        diagnostics.push({
          scope: "materialization",
          severity: "error",
          code: regularStep.failure.code,
          message: regularStep.failure.message,
        });
      }
    }
    if (workPresetId !== null) {
      const workStep = tryStep(() =>
        compileTaskPackage({
          repoRoot: rootDir,
          assetsRoot,
          userRoot,
          taskId: "task_sim_work_0001",
          title: `${validatedVertical.title} Simulation Work`,
          taskClass: "work",
          presetId: workPresetId,
          verticalId,
          locale,
        }),
      );
      if (workStep.ok) {
        compiledWork = workStep.value;
      } else {
        diagnostics.push({
          scope: "materialization",
          severity: "error",
          code: workStep.failure.code,
          message: workStep.failure.message,
        });
      }
    }

    // 4. Bundled agent roster resolution.
    const agentIssues: PresetFailure[] = [],
      agentIds = listBundledAgentDeclarationIds(verticalId, rootDir),
      agentDeclarations: Pick<AgentDeclarationV1, "id" | "name" | "role" | "instructions">[] = [];
    if (agentIds.length === 0) {
      const failure = presetFailure(
        "missing_agents",
        `Vertical ${verticalId} has no bundled agent declarations under agents/*.json.`,
      );
      agentIssues.push(failure);
      diagnostics.push({ scope: "agents", severity: "error", code: failure.code, message: failure.message });
    }
    for (const agentId of agentIds) {
      const agentStep = tryStep(() => readBundledAgentDeclaration(agentId, verticalId, rootDir));
      if (agentStep.ok) {
        if (agentStep.value)
          agentDeclarations.push({
            id: agentStep.value.id,
            name: agentStep.value.name,
            role: agentStep.value.role,
            instructions: agentStep.value.instructions,
          });
      } else {
        agentIssues.push(agentStep.failure);
        diagnostics.push({
          scope: "agents",
          severity: "error",
          code: agentStep.failure.code,
          message: agentStep.failure.message,
        });
      }
    }

    // 5. Declarative completion gate positive/negative probes.
    const gateReports: SimulatedGateReport[] = [];
    let gateCompiled = compiledRegular;
    // If default profile has no gates and no explicit --profile was given, probe the first profile with command gates.
    if (gateCompiled && !input.profileId && gateCompiled.snapshot.profile.completionGateIds.length === 0) {
      const runtime = createRuntime({ repoRoot: rootDir, assetsRoot, userRoot }),
        assets = loadCanonicalAssets(assetsRoot),
        manifest = runtime.resolveInternal({
          presetId: gateCompiled.snapshot.identity.id,
          verticalId,
          locale,
          purpose: "inspect",
        }).manifest,
        gatedProfile = manifest.profiles.find((profile) =>
          profile.completionGates.some(
            (gateId) =>
              assets.compiledVertical.definition.completion.gates[gateId] !== undefined ||
              manifest.completion?.gates[gateId] !== undefined,
          ),
        );
      if (gatedProfile) {
        gateCompiled = compileTaskPackage({
          repoRoot: rootDir,
          assetsRoot,
          userRoot,
          taskId: "task_sim_regular_0001",
          title: `${validatedVertical.title} Simulation Task`,
          presetId: gateCompiled.snapshot.identity.id,
          verticalId,
          profileId: gatedProfile.id,
          locale,
        });
      }
    }
    if (gateCompiled && gateCompiled.snapshot.profile.completionGateIds.length > 0) {
      const contract = resolveCompletionContract(
        gateCompiled.snapshot.profile.completionGateIds,
        { gates: INITIAL_SETTINGS_V1.gates, closeout: INITIAL_SETTINGS_V1.closeout },
        { digest: gateCompiled.snapshot.digest, completion: gateCompiled.snapshot.completion },
      );
      if (!contract.ok) {
        const failure = presetFailure("invalid_completion", contract.message);
        diagnostics.push({ scope: "gate", severity: "error", code: failure.code, message: failure.message });
      } else {
        for (const requirement of contract.contract.gates) {
          if (requirement.witness.kind !== "command") continue;
          const samples = loadGateSamples({
            assetsRoot,
            requirement,
            override: input.samplePayloads?.[requirement.gateId],
          });
          if (!samples) {
            diagnostics.push({
              scope: "gate",
              severity: "warning",
              code: "missing_gate_samples",
              message: `Gate ${requirement.gateId} has no samples/${requirement.gateId}/{positive,negative}.json fixture.`,
            });
            continue;
          }
          const positive = await runSingleGateProbe({
            sandboxDir: sandbox.directory,
            sandboxUserRoot,
            verticalId,
            compiled: gateCompiled,
            contract,
            requirement,
            artifacts: samples.positive,
            expected: "pass",
            idempotencyKey: `sim-${requirement.gateId}-positive`,
          });
          const negative = await runSingleGateProbe({
            sandboxDir: sandbox.directory,
            sandboxUserRoot,
            verticalId,
            compiled: gateCompiled,
            contract,
            requirement,
            artifacts: samples.negative,
            expected: "fail",
            idempotencyKey: `sim-${requirement.gateId}-negative`,
          });
          const gateOk = positive.ok && negative.ok;
          if (!gateOk)
            diagnostics.push({
              scope: "gate",
              severity: "error",
              code: "gate_probe_failed",
              message: `Gate ${requirement.gateId} simulation failed (positive=${positive.result}, negative=${negative.result}).`,
            });
          gateReports.push({
            gateId: requirement.gateId,
            sourceId: requirement.witness.adapterId,
            sourceKind: requirement.witness.kind,
            presetId: gateCompiled.snapshot.identity.id,
            profileId: gateCompiled.snapshot.profile.id,
            ok: gateOk,
            positive,
            negative,
          });
        }
      }
    }

    const toPreview = (doc: CompiledTaskPackage["documents"][number]): SimulatedDocumentPreview => ({
      slot: doc.slot,
      path: doc.relativePath,
      mediaType: doc.mediaType,
      contentSha256: doc.contentSha256,
      body: doc.body,
    });
    const hasError = diagnostics.some((item) => item.severity === "error");
    return {
      schema: "vertical-simulate-report/v1",
      ok:
        !hasError &&
        bootstrapIssues.length === 0 &&
        agentIssues.length === 0 &&
        compiledRegular !== null &&
        compiledWork !== null &&
        gateReports.every((gate) => gate.ok),
      zeroLedgerWrites: true,
      locale,
      vertical: {
        id: verticalId,
        title: validatedVertical.title,
        version: validatedVertical.version,
        source: validation.source,
        valid: validation.valid,
        issues: validation.issues,
      },
      bootstrap: {
        ok: bootstrapIssues.length === 0 && defaultPresetId !== null && workPresetId !== null,
        defaultPresetId,
        defaultProfileId,
        workPresetId,
        issues: bootstrapIssues,
      },
      agents: {
        ok: agentIssues.length === 0 && agentDeclarations.length > 0,
        ids: agentIds,
        declarations: agentDeclarations,
        issues: agentIssues,
      },
      previews: {
        repository: repositoryPreview,
        regularTask: compiledRegular
          ? {
              presetId: compiledRegular.snapshot.identity.id,
              profileId: compiledRegular.snapshot.profile.id,
              outputShape: compiledRegular.snapshot.profile.outputShape,
              completionGates: compiledRegular.snapshot.profile.completionGateIds,
              snapshotDigest: compiledRegular.snapshot.digest,
              documents: compiledRegular.documents.map(toPreview),
            }
          : null,
        workTask: compiledWork
          ? {
              presetId: compiledWork.snapshot.identity.id,
              profileId: compiledWork.snapshot.profile.id,
              outputShape: compiledWork.snapshot.profile.outputShape,
              snapshotDigest: compiledWork.snapshot.digest,
              documents: compiledWork.documents.map(toPreview),
            }
          : null,
      },
      gates: gateReports,
      diagnostics,
    };
  } finally {
    sandbox.close();
  }
}
