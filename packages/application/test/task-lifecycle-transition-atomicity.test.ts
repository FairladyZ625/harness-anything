// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalPayloadDigestV2,
  decodeTaskLifecycleTransitionCheckpoint,
  encodeTaskLifecycleTransitionCommandPayloadV2,
  makeTaskLifecycleTransitionSemanticCompilerV2,
  semanticMutationEnvelopeV2Schema,
  TaskLifecycleTransitionService,
  type CanonicalTaskMutationPlan,
  type HostedDocumentSnapshotV2,
  type PathCasV2,
  type SemanticBaseCasV2,
  type SemanticMutationEnvelopeV2,
  type TaskCompleteTransitionCommand,
  type VerifiedTaskCompleteDocumentPublicationWitness
} from "../src/index.ts";
import {
  executionDeclaration,
  sha256Text,
  stablePayloadHash,
  type ExecutionRecord,
  type RegistryEntityRefV2,
  type WriteOp
} from "../../kernel/src/index.ts";
import { taskIndex } from "./execution-saga-fixtures.ts";

const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8";
const executionId = "exe_01KXQ4WTA7Q4XJ5GDDRS1YXNG7";
const actor = {
  principal: { personId: "person_alice" },
  executor: { kind: "agent" as const, id: "codex" },
  responsibleHuman: "person_alice"
};
const witness: VerifiedTaskCompleteDocumentPublicationWitness = {
  kind: "document-publication",
  ref: "test-prepublish-witness",
  repositoryCommit: "a".repeat(40),
  publicationOperationIds: ["op_prepublished"],
  coveredTaskRelativePaths: ["task_plan.md"],
  coveredPathSetDigest: `sha256:${"b".repeat(64)}`
};

test("normal and accepted-replay lifecycle plans converge after every real declared-transaction crash boundary", { timeout: 60_000 }, async (t) => {
  const cases = [
    { kind: "execution-review" as const, build: buildExecutionReviewFixture },
    { kind: "accepted-replay" as const, build: buildAcceptedReplayFixture }
  ];
  for (const lifecycleCase of cases) {
    const probeRoot = mkdtempSync(path.join(tmpdir(), `ha-lifecycle-${lifecycleCase.kind}-probe-`));
    let targets: ReadonlyArray<string>;
    try {
      const probe = await lifecycleCase.build(probeRoot);
      targets = mutationBoundaryNames(probe.operation);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
    for (const target of targets) {
      await t.test(`${lifecycleCase.kind} crashes after ${target}`, async () => {
        const rootDir = mkdtempSync(path.join(tmpdir(), `ha-lifecycle-${lifecycleCase.kind}-${target.replace(/\W/gu, "-")}-`));
        try {
          const fixture = await lifecycleCase.build(rootDir);
          const operationPath = path.join(rootDir, "lifecycle-operation.json");
          writeFileSync(operationPath, `${JSON.stringify(fixture.operation)}\n`);

          const original = runTransactionWorker("run", rootDir, operationPath, target);
          assert.equal(original.signal, "SIGTERM", workerDiagnostic(original));

          const recovery = runTransactionWorker("recover", rootDir);
          assert.equal(recovery.status, 0, workerDiagnostic(recovery));
          const recovered = terminalTrace(rootDir, fixture.plan, lifecycleCase.kind, target, "original/recovered");
          assertTerminal(recovered, fixture.plan.transitionId);

          for (const attempt of ["replay-1", "replay-2"] as const) {
            const replayPlan = await replayAlreadySatisfied(rootDir, fixture.plan);
            assert.equal(replayPlan.kind, "already-committed");
            assert.equal(replayPlan.transitionId, fixture.plan.transitionId);
            const trace = terminalTrace(rootDir, fixture.plan, lifecycleCase.kind, target, attempt);
            assertTerminal(trace, fixture.plan.transitionId);
            assert.deepEqual(trace, { ...recovered, attempt });
          }
        } finally {
          rmSync(rootDir, { recursive: true, force: true });
        }
      });
    }
  }
});

interface CompiledFixture {
  readonly plan: CanonicalTaskMutationPlan;
  readonly operation: WriteOp;
}

async function buildExecutionReviewFixture(rootDir: string): Promise<CompiledFixture> {
  const taskRoot = seedSubmittedTask(rootDir);
  const command = completeCommand(`task-complete-${"1".repeat(64)}`);
  const submitted = readExecution(taskRoot);
  const plan = TaskLifecycleTransitionService.plan(lifecycleSnapshot({
    currentRound: { kind: "submitted", execution: submitted }
  }), command);
  assert.equal(plan.kind, "execution-review");
  return { plan, operation: await compileOperation(rootDir, plan) };
}

async function buildAcceptedReplayFixture(rootDir: string): Promise<CompiledFixture> {
  const taskRoot = seedSubmittedTask(rootDir);
  const seedCommand = completeCommand(`task-complete-${"2".repeat(64)}`);
  const submitted = readExecution(taskRoot);
  const seedPlan = TaskLifecycleTransitionService.plan(lifecycleSnapshot({
    currentRound: { kind: "submitted", execution: submitted }
  }), seedCommand);
  assert.equal(seedPlan.kind, "execution-review");
  const seedOperation = await compileOperation(rootDir, seedPlan);
  const seedWrites = declaredCompanionWrites(seedOperation);
  for (const relativePath of [
    `consents/${seedPlan.consentId}.md`,
    `reviews/${seedPlan.reviewId}.md`,
    `executions/${seedPlan.executionId}.md`
  ]) {
    const write = seedWrites.find((entry) => entry.path === relativePath);
    assert.ok(write, `seed compiler did not declare ${relativePath}`);
    const target = path.join(taskRoot, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, write.body);
  }

  const accepted = readExecution(taskRoot);
  const command = completeCommand(`task-complete-${"3".repeat(64)}`);
  const plan = TaskLifecycleTransitionService.plan(lifecycleSnapshot({
    currentRound: { kind: "accepted-replay", execution: accepted },
    acceptedReplayApproval: { reviewId: seedPlan.reviewId, consentId: seedPlan.consentId }
  }), command);
  assert.equal(plan.kind, "accepted-replay");
  return { plan, operation: await compileOperation(rootDir, plan) };
}

async function compileOperation(rootDir: string, plan: CanonicalTaskMutationPlan): Promise<WriteOp> {
  const compiled = await compilePlan(rootDir, plan);
  return {
    ...compiled.operation,
    opId: stablePayloadHash({ schema: "task-lifecycle-transition-op/v1", transitionId: plan.transitionId })
  };
}

async function compilePlan(rootDir: string, plan: CanonicalTaskMutationPlan) {
  const state = diskAuthorityState(rootDir);
  const compiler = makeTaskLifecycleTransitionSemanticCompilerV2({ state, rootInput: rootDir });
  return compiler.compile(envelope(plan, state), {
    actor,
    sessionId: "session-lifecycle-atomicity",
    nowMs: BigInt(Date.parse("2026-08-03T00:10:00.000Z"))
  });
}

async function replayAlreadySatisfied(
  rootDir: string,
  original: CanonicalTaskMutationPlan
): Promise<CanonicalTaskMutationPlan> {
  const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
  const checkpointBody = readFileSync(
    path.join(taskRoot, "transitions", `${original.transitionId}.json`),
    "utf8"
  );
  const { transition } = decodeTaskLifecycleTransitionCheckpoint(checkpointBody);
  const accepted = readExecution(taskRoot);
  const replayPlan = TaskLifecycleTransitionService.plan(lifecycleSnapshot({
    taskStatus: "done",
    currentRound: { kind: "accepted-replay", execution: accepted },
    existingTransition: transition
  }), original.command);
  const compiled = await compilePlan(rootDir, replayPlan);
  assert.ok(compiled.alreadySatisfied, "terminal replay must compile to an already-satisfied verifier");
  assert.ok(await compiled.alreadySatisfied.verify(), "terminal replay must be proven by a fresh reread");
  return replayPlan;
}

function envelope(
  plan: CanonicalTaskMutationPlan,
  state: ReturnType<typeof diskAuthorityState>
): SemanticMutationEnvelopeV2 {
  const bytes = encodeTaskLifecycleTransitionCommandPayloadV2({
    schema: "task.lifecycle-complete/v1",
    plan
  });
  const refs = transitionRefs(plan);
  const paths = transitionCasPaths(plan);
  return {
    schema: semanticMutationEnvelopeV2Schema,
    workspaceId: "workspace-lifecycle-atomicity",
    operationId: {
      namespace: {
        schema: "operation-namespace/v1",
        workspaceId: "workspace-lifecycle-atomicity",
        deviceId: "device-lifecycle-atomicity",
        authorityGeneration: 1n,
        namespaceId: "namespace-lifecycle-atomicity",
        expiresAt: 9_999_999_999_999n,
        issuer: "authority.test",
        keyId: "key-lifecycle-atomicity",
        proof: Buffer.alloc(32)
      },
      clientRandom128: Buffer.alloc(16)
    },
    binding: {
      bindingId: "binding-lifecycle-atomicity",
      actorAxesBindingDigest: Buffer.alloc(32),
      deviceId: "device-lifecycle-atomicity",
      viewId: "view-lifecycle-atomicity",
      sessionId: "session-lifecycle-atomicity",
      admissionTokenRef: { tokenId: "token-lifecycle-atomicity", tokenDigest: Buffer.alloc(32) }
    },
    schemaTuple: {
      schema: "protocol-schema-tuple/v1",
      entityRegistryVersion: 1,
      commandRegistryVersion: 1,
      mutationRegistryVersion: 1
    } as SemanticMutationEnvelopeV2["schemaTuple"],
    intent: {
      kind: "typed",
      command: { registryVersion: 1, name: "task.lifecycle-complete", version: 1 },
      canonicalPayload: { kind: "inline", size: BigInt(bytes.length), bytes },
      canonicalPayloadDigest: canonicalPayloadDigestV2(bytes),
      baseCas: refs.map(absentBase),
      declaredPathCas: paths.map((documentPath) => pathCas(documentPath, state.readSnapshot(documentPath)))
    },
    claimedMutationSet: { registryVersion: 1, mutations: [] },
    claimedSemanticMutationSetDigest: Buffer.alloc(32),
    claimedSemanticRequestDigest: Buffer.alloc(32)
  };
}

function transitionRefs(plan: CanonicalTaskMutationPlan): ReadonlyArray<RegistryEntityRefV2> {
  if (plan.kind === "already-committed") return [ref("task", `task/${plan.taskId}`)];
  if (plan.kind === "execution-review") {
    return [
      ref("execution", `execution/${plan.taskId}/${plan.executionId}`),
      ref("consent", `consent/${plan.taskId}/${plan.consentId}`),
      ref("review", `review/${plan.taskId}/${plan.reviewId}`),
      ref("task", `task/${plan.taskId}`)
    ];
  }
  if (plan.kind === "accepted-replay") {
    return [
      ref("execution", `execution/${plan.taskId}/${plan.executionId}`),
      ref("review", `review/${plan.taskId}/${plan.approvedReviewId}`),
      ref("consent", `consent/${plan.taskId}/${plan.consumedConsentId}`),
      ref("task", `task/${plan.taskId}`)
    ];
  }
  throw new Error(`unexpected atomicity fixture plan: ${plan.kind}`);
}

function transitionCasPaths(plan: CanonicalTaskMutationPlan): ReadonlyArray<string> {
  const common = [
    taskPath("INDEX.md"),
    taskPath(`transitions/${plan.transitionId}.json`),
    taskPath("task-contract.json")
  ];
  if (plan.kind === "already-committed") {
    return [
      taskPath("INDEX.md"),
      taskPath(`transitions/${plan.transitionId}.json`),
      ...(plan.executionId ? [taskPath(`executions/${plan.executionId}.md`)] : []),
      taskPath("task-contract.json")
    ];
  }
  if (plan.kind === "execution-review") {
    return [
      taskPath(`executions/${plan.executionId}.md`),
      ...common,
      taskPath(`reviews/${plan.reviewId}.md`),
      taskPath(`consents/${plan.consentId}.md`)
    ];
  }
  if (plan.kind === "accepted-replay") {
    return [
      taskPath(`executions/${plan.executionId}.md`),
      ...common,
      taskPath(`reviews/${plan.approvedReviewId}.md`),
      taskPath(`consents/${plan.consumedConsentId}.md`)
    ];
  }
  throw new Error(`unexpected atomicity fixture plan: ${plan.kind}`);
}

function diskAuthorityState(rootDir: string) {
  const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
  const readSnapshot = (documentPath: string): HostedDocumentSnapshotV2 => {
    const prefix = `tasks/${taskId}/`;
    assert.equal(documentPath.startsWith(prefix), true, documentPath);
    const target = path.join(taskRoot, documentPath.slice(prefix.length));
    if (!existsSync(target)) return absentSnapshot(documentPath);
    return presentSnapshot(readFileSync(target, "utf8"));
  };
  return {
    readEntityBase: async () => null,
    readHostedDocument: async (documentPath: string) => {
      const result = readSnapshot(documentPath);
      return result.body === "" && result.revision === 0n ? null : result;
    },
    readSnapshot
  };
}

function seedSubmittedTask(rootDir: string): string {
  const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
  mkdirSync(path.join(taskRoot, "executions"), { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), taskIndex(taskId, "in_review"));
  writeFileSync(path.join(taskRoot, "task_plan.md"), "# Lifecycle atomicity plan\n");
  writeFileSync(
    path.join(taskRoot, "executions", `${executionId}.md`),
    executionDeclaration.documentCodec.encode(submittedExecution())
  );
  return taskRoot;
}

function submittedExecution(): ExecutionRecord {
  return {
    schema: "execution/v2",
    execution_id: executionId,
    task_ref: `task/${taskId}`,
    state: "submitted",
    primary_actor: actor,
    claimed_at: "2026-08-03T00:00:00.000Z",
    submitted_at: "2026-08-03T00:05:00.000Z",
    closed_at: null,
    session_bindings: [],
    outputs: [{
      evidence_id: "ev_lifecycle_atomicity",
      execution_ref: `execution/${taskId}/${executionId}`,
      locator: { substrate: "inline", text: "Real declared transaction evidence" }
    }],
    submission: {
      completion_claim: "The lifecycle transaction is complete.",
      deliverables: ["Lifecycle transaction"],
      evidence_refs: ["ev_lifecycle_atomicity"],
      verification_notes: ["The real write coordinator is used."],
      known_gaps: [],
      residual_risks: []
    }
  };
}

function completeCommand(callerIdempotencyKey: string): TaskCompleteTransitionCommand {
  return {
    kind: "task-complete",
    taskId,
    executionId,
    ciGate: "passed",
    reviewerId: "person_alice",
    evidenceMode: "execution-review",
    commitRef: null,
    judgment: null,
    approval: {
      executionId,
      findings: "The delivery satisfies the task.",
      evidenceChecked: ["ev_lifecycle_atomicity"],
      rationale: "The exact submitted evidence covers the acceptance criteria.",
      archiveWarningsAcknowledged: true,
      consentSource: { kind: "asserted-rationale", rationale: "Owner approval was received." },
      consentActions: ["approve_execution", "complete_task"],
      paths: [],
      prRef: null
    },
    externalCheckpointRefs: [{ kind: witness.kind, ref: witness.ref }],
    callerIdempotencyKey,
    dryRun: false
  };
}

function lifecycleSnapshot(overrides: Partial<Parameters<typeof TaskLifecycleTransitionService.plan>[0]>) {
  return {
    taskId,
    taskStatus: "in_review",
    currentRound: { kind: "submitted" as const, execution: submittedExecution() },
    holder: { taskId, holder: null, effectiveHolder: null, leaseExpiresAt: null, orphan: false },
    sessionBinding: { sessionId: "session-lifecycle-atomicity", actor },
    verifiedExternalWitnesses: [witness],
    completionContractBodySha256: null,
    ...overrides
  };
}

function readExecution(taskRoot: string): ExecutionRecord {
  return executionDeclaration.documentCodec.decode(
    readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")
  ) as ExecutionRecord;
}

function mutationBoundaryNames(operation: WriteOp): ReadonlyArray<string> {
  const payload = operation.payload as {
    readonly entityDocument?: { readonly identity?: { readonly transitionId?: string } };
    readonly companionWrites?: ReadonlyArray<{ readonly path: string }>;
  };
  const transitionId = payload.entityDocument?.identity?.transitionId;
  assert.ok(transitionId);
  return [`${transitionId}.json`, ...(payload.companionWrites ?? []).map((entry) => path.basename(entry.path))];
}

function declaredCompanionWrites(operation: WriteOp): ReadonlyArray<{ readonly path: string; readonly body: string }> {
  const writes = (operation.payload as { readonly companionWrites?: ReadonlyArray<{ readonly path: string; readonly body: string }> }).companionWrites;
  assert.ok(writes);
  return writes;
}

function runTransactionWorker(
  mode: "run" | "recover",
  rootDir: string,
  operationPath?: string,
  killpoint?: string
) {
  const worker = fileURLToPath(new URL("./fixtures/task-lifecycle-transition-transaction-worker.ts", import.meta.url));
  return spawnSync(process.execPath, [worker, mode, rootDir, ...(operationPath ? [operationPath] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(killpoint ? { HARNESS_TEST_DECLARED_TRANSACTION_KILLPOINT_AFTER_WRITE: killpoint } : {})
    }
  });
}

function terminalTrace(
  rootDir: string,
  plan: CanonicalTaskMutationPlan,
  lifecycleCase: "execution-review" | "accepted-replay",
  target: string,
  attempt: string
) {
  const taskRoot = path.join(rootDir, "harness", "tasks", taskId);
  const taskStatus = /^  status:\s*(\S+)$/mu.exec(readFileSync(path.join(taskRoot, "INDEX.md"), "utf8"))?.[1] ?? "missing";
  const executionState = (JSON.parse(readFileSync(path.join(taskRoot, "executions", `${executionId}.md`), "utf8")) as { readonly state: string }).state;
  const transitionsRoot = path.join(taskRoot, "transitions");
  const checkpointSet = existsSync(transitionsRoot)
    ? readdirSync(transitionsRoot).filter((entry) => entry.endsWith(".json")).map((entry) => entry.slice(0, -5)).sort()
    : [];
  const trace = {
    case: lifecycleCase,
    crashAfterCheckpoint: target,
    attempt,
    transitionId: plan.transitionId,
    terminalTaskStatus: taskStatus,
    terminalExecutionState: executionState,
    checkpointSet
  };
  console.log([
    trace.case,
    trace.crashAfterCheckpoint,
    trace.attempt,
    trace.transitionId,
    trace.terminalTaskStatus,
    trace.terminalExecutionState,
    `[${trace.checkpointSet.join(",")}]`
  ].join(" | "));
  return trace;
}

function assertTerminal(
  trace: ReturnType<typeof terminalTrace>,
  transitionId: string
): void {
  assert.equal(trace.terminalTaskStatus, "done");
  assert.equal(trace.terminalExecutionState, "accepted");
  assert.deepEqual(trace.checkpointSet, [transitionId]);
}

function presentSnapshot(body: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(body);
  return { body, epoch: digest, revision: 1n, blobDigest: Buffer.from(digest, "hex") };
}

function absentSnapshot(documentPath: string): HostedDocumentSnapshotV2 {
  const digest = sha256Text(`harness-absent-hosted-document/v1:${documentPath}`);
  return { body: "", epoch: digest, revision: 0n, blobDigest: Buffer.from(digest, "hex") };
}

function pathCas(documentPath: string, snapshot: HostedDocumentSnapshotV2): PathCasV2 {
  return {
    path: documentPath,
    expectedEpoch: snapshot.epoch,
    expectedRevision: snapshot.revision,
    expectedBlobDigest: snapshot.blobDigest
  };
}

function absentBase(entityRef: RegistryEntityRefV2): SemanticBaseCasV2 {
  return { entityRef, expectedSemanticVersion: null, expectedStateDigest: null };
}

function ref(entityKind: string, canonicalRef: string): RegistryEntityRefV2 {
  return { registryVersion: 1, entityKind, canonicalRef };
}

function taskPath(relativePath: string): string {
  return `tasks/${taskId}/${relativePath}`;
}

function workerDiagnostic(result: ReturnType<typeof spawnSync>): string {
  return JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr });
}
