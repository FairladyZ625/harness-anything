// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalGateReceipts,
  compileCompletionGateWitness,
  completionBlockers,
  gateResults,
  judgeCompletionEvidence,
  reduceTaskEvent,
  submissionDigest,
  waivableAutomatedFail,
  type CompletionEvidenceV1,
  type FrozenGateRequirement,
} from "../../kernel/src/index.ts";
import type { TaskLifecycleSnapshot } from "../../kernel/src/index.ts";
import { lifecycleFixture } from "../../kernel/test/store/task-lifecycle-fixture.ts";
import { gate as validateGateWitnessWire } from "../src/protocol/daemon-protocol-validate-entities.ts";
import { attestGateWitness, witnessAdapters } from "../src/repo-cell-witness-adapters.ts";
import { runProcessExitAsync } from "../src/process-port.ts";
import type { RepoCellOperationalContext } from "../src/repo-cell-action-context.ts";
import type { RepoCellBinding, Snapshot } from "../src/repo-cell-types.ts";
import { projectionReady } from "../src/repo-cell-settlement.ts";

const actor = { principal: { personId: "owner" }, executor: null } as const;
const binding = { actor, source: "local" } as RepoCellBinding;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).trim();
}

const localRequirement = (command: string, gateId = "lint"): FrozenGateRequirement => ({
  gateId,
  appliesTo: "code",
  witness: { adapterId: "local-command", adapterOptions: { command } },
});

const manualRequirement = (gateId = "signoff"): FrozenGateRequirement => ({
  gateId,
  appliesTo: "code",
  witness: { adapterId: "manual-attest", adapterOptions: {} },
});

const artifactRequirement = (gateId = "signoff"): FrozenGateRequirement => ({
  gateId,
  appliesTo: "artifacts",
  witness: { adapterId: "manual-attest", adapterOptions: {} },
});

const githubRequirement = (gateId = "ci"): FrozenGateRequirement => ({
  gateId,
  appliesTo: "code",
  witness: {
    adapterId: "github-actions",
    adapterOptions: {
      workflows: ["rewrite-ci"],
      branch: "main",
      event: "push",
      coverage: "descendant",
      selection: "newest",
    },
  },
});

function submittedExecution(
  commitSha: string,
  requirements: readonly FrozenGateRequirement[],
  overrides: Record<string, unknown> = {},
): Snapshot["executions"][number] {
  return {
    schema: "execution/v1",
    executionId: "execution",
    taskId: "task",
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor,
    claimedAt: "2026-09-12T00:00:00.000Z",
    submittedAt: "2026-09-12T00:01:00.000Z",
    closedAt: null,
    submission: {
      completionClaim: "Done",
      commitSha,
      deliverables: [],
      outputs: [],
      verificationNotes: ["Tests passed"],
      knownGaps: [],
      residualRisks: [],
      evidenceRefs: [],
      completionContract: { gates: [...requirements] },
      ...overrides,
    },
  } as Snapshot["executions"][number];
}

function cellStub(rootDir: string, execution: Snapshot["executions"][number]) {
  const read = {
    status: "ready",
    watermark: 0,
    sourceRevision: 1,
    snapshot: {
      revision: 1,
      task: { taskId: "task", iteration: 0, status: "in_review", currentNode: "review", createdBy: actor },
      executions: [execution],
      gateWitnesses: [],
      codeDocWitnesses: [],
      reviews: [],
      consents: [],
      lease: null,
      decisionRelations: [],
    } as unknown as Snapshot,
    packagePath: null as string | null,
  };
  return {
    rootDir,
    projectionReady,
    projection: {
      read: () => read,
      readCiRunObservations: () => ({ status: "ready", events: [], watermark: 0, sourceRevision: 0 }),
    },
    cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    requiredCellText: (value: unknown) => String(value),
  } as unknown as RepoCellOperationalContext;
}

test("local-command collects evidence at the frozen cut and nonzero exit is fail evidence", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-local-witness-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    writeFileSync(path.join(root, "marker.txt"), "cut-one\n");
    git(root, "add", "marker.txt");
    git(root, "commit", "-qm", "cut one");
    const cutSha = git(root, "rev-parse", "HEAD");
    writeFileSync(path.join(root, "marker.txt"), "amended\n");
    git(root, "commit", "-a", "-q", "-m", "amended");

    const requirement = localRequirement("cat marker.txt"),
      execution = submittedExecution(cutSha, [requirement]),
      cell = cellStub(root, execution),
      collected = await witnessAdapters["local-command"].collect!(cell, requirement, execution);
    // The command ran on the archived submitted commit, not the amended working tree.
    const evidence = witnessAdapters["local-command"].evaluate(cell, requirement, execution, collected);
    assert.equal(evidence?.result, "pass");
    assert.equal(evidence?.provenance.adapterId, "local-command");
    assert.equal(evidence?.basis.codeCommit, cutSha);
    assert.match(evidence?.provenance.rawResult ?? "", /exit 0/u);
    assert.match(evidence?.provenance.rawResult ?? "", /cut-one/u);

    const failing = localRequirement("exit 7", "lint"),
      failCollected = await witnessAdapters["local-command"].collect!(cell, failing, execution);
    const failEvidence = witnessAdapters["local-command"].evaluate(cell, failing, execution, failCollected);
    assert.equal(failEvidence?.result, "fail");
    assert.match(failEvidence?.provenance.rawResult ?? "", /exit 7/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local-command refuses stale collections after the submitted cut is amended", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-local-stale-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    git(root, "commit", "--allow-empty", "-qm", "cut one");
    const cutSha = git(root, "rev-parse", "HEAD"),
      requirement = localRequirement("exit 0"),
      execution = submittedExecution(cutSha, [requirement]),
      cell = cellStub(root, execution),
      collected = await witnessAdapters["local-command"].collect!(cell, requirement, execution);

    const amended = submittedExecution(cutSha, [requirement], { completionClaim: "Amended." });
    assert.notEqual(submissionDigest(amended.submission as never), submissionDigest(execution.submission as never));
    assert.equal(witnessAdapters["local-command"].evaluate(cell, requirement, amended, collected), null);

    const amendedContract = submittedExecution(cutSha, [requirement, manualRequirement()]);
    assert.equal(witnessAdapters["local-command"].evaluate(cell, requirement, amendedContract, collected), null);

    await assert.rejects(
      () =>
        witnessAdapters["local-command"].collect!(cell, requirement, submittedExecution("f".repeat(40), [requirement])),
      { code: "witness_unavailable" },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// local-command's verdict comes from runProcessExitAsync: a real exit resolves with its code
// (0 → pass, nonzero → fail), while termination paths — spawn failure, signal, timeout, abort —
// produce no verdict and must reject. The timeout case is the sharp edge: a child that catches
// SIGTERM and exits 7 on its own still reports a numeric error.code, so the killed/signal
// markers — not the code — classify it as no-verdict.
test(
  "runProcessExitAsync resolves only real exits: a SIGTERM-swallowing child under timeout rejects",
  { skip: process.platform === "win32" ? "requires POSIX SIGTERM delivery semantics" : false },
  async () => {
    assert.deepEqual(await runProcessExitAsync(process.execPath, ["-e", "process.exit(7)"]), {
      exitCode: 7,
      stdout: "",
      stderr: "",
    });
    assert.equal((await runProcessExitAsync(process.execPath, ["-e", ""])).exitCode, 0);
    await assert.rejects(
      runProcessExitAsync(
        process.execPath,
        ["-e", 'process.on("SIGTERM",()=>process.exit(7)); setInterval(()=>{},1000);'],
        undefined,
        undefined,
        undefined,
        undefined,
        { timeoutMs: 1000 },
      ),
      (error: unknown) => {
        const failure = error as { killed?: boolean; signal?: string | null };
        return failure.killed === true || failure.signal != null;
      },
    );
    await assert.rejects(runProcessExitAsync("ha-no-such-binary-9f8e7d", []), { code: "ENOENT" });
  },
);

// A merged-to:<branch> declaration resolves to an ordinary local-command requirement whose
// command observes ancestry in the source repository through HARNESS_WITNESS_REPO: the verdict is
// fail while the branch lacks the cut and flips to pass once the branch contains it — completion
// reads the later observation, never a submit-time verdict.
test("a merged-to ancestry observation fails until the target branch contains the cut", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-merged-to-"));
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Test");
    git(root, "config", "user.email", "test@example.com");
    writeFileSync(path.join(root, "file.txt"), "base\n");
    git(root, "add", "file.txt");
    git(root, "commit", "-qm", "base");
    git(root, "checkout", "-qb", "delivery");
    writeFileSync(path.join(root, "delivered.txt"), "delivered\n");
    git(root, "add", "delivered.txt");
    git(root, "commit", "-qm", "delivery");
    const cutSha = git(root, "rev-parse", "HEAD");
    git(root, "checkout", "-q", "main");

    const requirement = localRequirement(
        'git -C "$HARNESS_WITNESS_REPO" merge-base --is-ancestor "$HARNESS_WITNESS_CUT" refs/heads/main',
        "merged-to:main",
      ),
      execution = submittedExecution(cutSha, [requirement]),
      cell = cellStub(root, execution);

    const before = await witnessAdapters["local-command"].collect!(cell, requirement, execution),
      beforeEvidence = witnessAdapters["local-command"].evaluate(cell, requirement, execution, before);
    assert.equal(beforeEvidence?.result, "fail");
    assert.match(beforeEvidence?.provenance.rawResult ?? "", /exit [1-9]/u);

    git(root, "merge", "-qm", "merge delivery", cutSha);
    const after = await witnessAdapters["local-command"].collect!(cell, requirement, execution),
      afterEvidence = witnessAdapters["local-command"].evaluate(cell, requirement, execution, after);
    assert.equal(afterEvidence?.result, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- canonical write admission ------------------------------------------------

function admissionFixture(requirement: FrozenGateRequirement) {
  // A real lifecycle snapshot one step past SubmitExecution, with the frozen
  // contract patched onto the submission so admission sees a declared gate.
  const fixture = lifecycleFixture({ taskId: "task" }),
    snapshot = {
      ...fixture.snapshot,
      task: { ...fixture.snapshot.task!, status: "in_review" as const, currentNode: "review" },
      executions: fixture.snapshot.executions.map((value) =>
        value.state === "accepted" || value.state === "submitted" ? { ...value, state: "submitted" as const } : value,
      ),
    },
    execution = snapshot.executions.find((value) => value.state === "submitted")!;
  execution.submission = {
    ...execution.submission!,
    completionContract: { gates: [requirement] },
  };
  return { snapshot, execution };
}

type SubmittedExecutionRef = {
  executionId: string;
  iteration: number;
  submission: { commitSha: string | null } | null;
};

function humanEvidence(
  execution: SubmittedExecutionRef,
  gateId: string,
  adapterId: "manual-attest" | "github-actions",
): CompletionEvidenceV1 {
  const submission = execution.submission!;
  return {
    schema: "completion-evidence/v1",
    checkerId: gateId,
    gateId,
    result: "pass",
    observed: true,
    basis: {
      executionId: execution.executionId,
      iteration: execution.iteration,
      submissionDigest: submissionDigest(submission as never),
      ...(submission.commitSha === null
        ? {
            ledgerCut: Math.max(
              ...("artifacts" in submission && Array.isArray(submission.artifacts)
                ? submission.artifacts.map((anchor: { revision: number }) => anchor.revision)
                : [0]),
            ),
          }
        : { codeCommit: submission.commitSha }),
    },
    provenance: { source: "human", adapterId, runId: "attest:owner", rawResult: "pass attested by owner" },
  };
}

function compileWitness(
  snapshot: TaskLifecycleSnapshot,
  execution: SubmittedExecutionRef,
  evidence: CompletionEvidenceV1,
) {
  return compileCompletionGateWitness({
    snapshot,
    taskId: "task",
    executionId: execution.executionId,
    gateId: evidence.gateId,
    result: evidence.result as "pass" | "fail",
    evidence,
    receiptId: "op-witness-1",
    checkerId: evidence.checkerId,
    commitSha: execution.submission!.commitSha!,
    iteration: execution.iteration,
    actor,
    source: "local",
    opId: "op-witness-1",
    eventId: "event-witness-1",
    workspaceRevision: snapshot.revision + 1,
    occurredAt: "2026-09-12T00:02:00.000Z",
    packagePath: null,
    currentDocuments: [],
  });
}

test("the canonical write entry binds the witness source adapter to the frozen declaration", () => {
  // A human attestation cannot satisfy a gate declared github-actions — fail closed.
  const github = admissionFixture(githubRequirement());
  assert.throws(
    () => compileWitness(github.snapshot, github.execution, humanEvidence(github.execution, "ci", "manual-attest")),
    {
      code: "invalid_proof",
    },
  );
  // A manual-attest gate admits human evidence and compiles the canonical event.
  const manual = admissionFixture(manualRequirement()),
    compiled = compileWitness(
      manual.snapshot,
      manual.execution,
      humanEvidence(manual.execution, "signoff", "manual-attest"),
    );
  assert.equal(compiled.event.type, "completion_gate_verified");
  assert.equal(compiled.event.payload.witness.result, "pass");
  assert.equal(compiled.event.payload.witness.provenance?.adapterId, "manual-attest");
  // A gate that is not part of the frozen contract cannot be witnessed at all.
  const stray = admissionFixture(manualRequirement()),
    strayEvidence = humanEvidence(stray.execution, "other-gate", "manual-attest");
  assert.throws(() => compileWitness(stray.snapshot, stray.execution, strayEvidence), { code: "invalid_proof" });
});

test("manual attest evidence carries human provenance and the gate it names", () => {
  const requirement = manualRequirement(),
    { snapshot } = admissionFixture(requirement),
    execution = snapshot.executions[0]!,
    published: CompletionEvidenceV1[] = [],
    cell = {
      ...cellStub("unused", execution),
      publishGateWitness: (
        _taskId: string,
        _executionId: string,
        _snapshot: unknown,
        _packagePath: unknown,
        _binding: unknown,
        evidence: CompletionEvidenceV1,
      ) => {
        published.push(evidence);
        return { outcome: "applied", opId: "witness" };
      },
    } as unknown as RepoCellOperationalContext;
  attestGateWitness(
    cell,
    { kind: "task-attest", taskId: "task", gateId: "signoff", result: "pass", note: "reviewed by hand" },
    binding,
  );
  assert.equal(published.length, 1);
  assert.equal(published[0]!.provenance.adapterId, "manual-attest");
  assert.equal(published[0]!.provenance.source, "human");
  assert.equal(published[0]!.result, "pass");

  // A gate declared github-actions rejects attestation before any write.
  const github = admissionFixture(githubRequirement()),
    githubCell = {
      ...cellStub("unused", github.execution),
      publishGateWitness: () => assert.fail("must not publish"),
    } as unknown as RepoCellOperationalContext;
  assert.throws(
    () => attestGateWitness(githubCell, { kind: "task-attest", taskId: "task", gateId: "ci", result: "pass" }, binding),
    { code: "invalid_command" },
  );
  assert.throws(
    () => attestGateWitness(cell, { kind: "task-attest", taskId: "task", gateId: "signoff", result: "maybe" }, binding),
    { code: "invalid_field" },
  );
});

test("the wire validator admits pass/fail witnesses only with a mapped adapter id in provenance", () => {
  const witness = {
    schema: "completion-gate-witness/v1",
    witnessId: "witness-1",
    receiptId: "receipt-1",
    checkerId: "signoff",
    gateId: "signoff",
    result: "pass",
    taskId: "task-1",
    executionId: "execution-1",
    commitSha: "a".repeat(40),
    iteration: 0,
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    verifiedAt: "2026-09-12T00:02:00.000Z",
    observed: true,
    basis: {
      executionId: "execution-1",
      iteration: 0,
      submissionDigest: `sha256:${"1".repeat(64)}`,
      codeCommit: "a".repeat(40),
    },
    provenance: {
      source: "human",
      adapterId: "manual-attest",
      runId: "attest:owner",
      rawResult: "pass attested by owner",
    },
  };
  assert.equal(validateGateWitnessWire(witness), true);
  assert.equal(validateGateWitnessWire({ ...witness, result: "fail" }), true);
  assert.equal(validateGateWitnessWire({ ...witness, result: "advisory" }), false);
  assert.equal(
    validateGateWitnessWire({
      ...witness,
      provenance: { source: "human", runId: "attest:owner", rawResult: "no adapter id" },
    }),
    false,
  );
  assert.equal(
    validateGateWitnessWire({
      ...witness,
      provenance: { ...witness.provenance, adapterId: "code-doc-reconciliation" },
    }),
    false,
  );
});

// -- artifact-only and mixed cuts ----------------------------------------------

const ARTIFACTS = [{ path: "tasks/task/artifacts/report.md", revision: 7, blobSha256: "a".repeat(64) }] as const;

function artifactOnlyFixture(requirement: FrozenGateRequirement) {
  const fixture = admissionFixture(requirement);
  fixture.execution.submission = {
    ...fixture.execution.submission!,
    commitSha: null,
    artifacts: [...ARTIFACTS],
  } as never;
  return fixture;
}

function publishingCell(execution: Snapshot["executions"][number]) {
  const published: CompletionEvidenceV1[] = [];
  return {
    published,
    cell: {
      ...cellStub("unused", execution),
      publishGateWitness: (
        _taskId: string,
        _executionId: string,
        _snapshot: unknown,
        _packagePath: unknown,
        _binding: unknown,
        evidence: CompletionEvidenceV1,
      ) => {
        published.push(evidence);
        return { outcome: "applied", opId: "witness" };
      },
    } as unknown as RepoCellOperationalContext,
  };
}

test("manual attestation witnesses an artifact-only cut, bound to its ledger cut", () => {
  const requirement = artifactRequirement(),
    { snapshot, execution } = artifactOnlyFixture(requirement),
    { published, cell } = publishingCell(execution);
  attestGateWitness(cell, { kind: "task-attest", taskId: "task", gateId: "signoff", result: "pass" }, binding);
  assert.equal(published.length, 1);
  assert.equal(published[0]!.basis.ledgerCut, 7);
  assert.equal(published[0]!.basis.codeCommit, undefined);
  assert.equal(published[0]!.provenance.adapterId, "manual-attest");
  // The canonical write admits the null-commit witness: the requirement applies to this cut.
  const compiled = compileWitness(snapshot, execution, humanEvidence(execution, "signoff", "manual-attest"));
  assert.equal(compiled.event.payload.witness.commitSha, null);
  assert.equal(compiled.event.payload.witness.basis?.ledgerCut, 7);
});

test("a code-scoped gate is not_applicable on an artifact-only cut and cannot be witnessed", () => {
  const { snapshot, execution } = artifactOnlyFixture(githubRequirement());
  assert.throws(() => compileWitness(snapshot, execution, humanEvidence(execution, "ci", "github-actions")), {
    code: "invalid_proof",
  });
  const { cell } = publishingCell(execution);
  assert.throws(
    () => attestGateWitness(cell, { kind: "task-attest", taskId: "task", gateId: "ci", result: "pass" }, binding),
    { code: "invalid_transition" },
  );
});

test("a mixed commit+artifact cut carries both scopes: each gate judges its own part", () => {
  const requirement = artifactRequirement(),
    { snapshot, execution } = admissionFixture(requirement);
  execution.submission = {
    ...execution.submission!,
    artifacts: [...ARTIFACTS],
  } as never;
  const { published, cell } = publishingCell(execution);
  attestGateWitness(cell, { kind: "task-attest", taskId: "task", gateId: "signoff", result: "pass" }, binding);
  assert.equal(published.length, 1);
  const compiled = compileWitness(snapshot, execution, humanEvidence(execution, "signoff", "manual-attest"));
  assert.equal(compiled.event.payload.witness.commitSha, execution.submission!.commitSha);
  // The code part of the same cut still carries code-scoped gates.
  const coded = admissionFixture(manualRequirement("signoff"));
  assert.doesNotThrow(() =>
    compileWitness(coded.snapshot, coded.execution, humanEvidence(coded.execution, "signoff", "manual-attest")),
  );
});

test("the wire validator admits a null-commit witness for artifact-scoped gates", () => {
  const witness = {
    schema: "completion-gate-witness/v1",
    witnessId: "witness-artifact",
    receiptId: "receipt-artifact",
    checkerId: "signoff",
    gateId: "signoff",
    result: "pass",
    taskId: "task-1",
    executionId: "execution-1",
    commitSha: null,
    iteration: 0,
    actor: { principal: { personId: "owner" }, executor: null },
    source: "local",
    verifiedAt: "2026-09-12T00:02:00.000Z",
    observed: true,
    basis: {
      executionId: "execution-1",
      iteration: 0,
      submissionDigest: `sha256:${"2".repeat(64)}`,
      ledgerCut: 7,
    },
    provenance: {
      source: "human",
      adapterId: "manual-attest",
      runId: "attest:owner",
      rawResult: "pass attested by owner",
    },
  };
  assert.equal(validateGateWitnessWire(witness), true);
});

// -- four governance modes (automated-only, manual-attest, dual control, break-glass override) ----

/** The admission fixture with the governed gate also declared on the task, as replay requires. */
function governedFixture(requirement: FrozenGateRequirement) {
  const fixture = admissionFixture(requirement);
  return {
    ...fixture,
    snapshot: {
      ...fixture.snapshot,
      task: { ...fixture.snapshot.task!, completionGateIds: [requirement.gateId] },
    } as TaskLifecycleSnapshot,
  };
}

function automatedEvidence(
  execution: SubmittedExecutionRef,
  gateId: string,
  result: "pass" | "fail",
  runId = "local-run-1",
): CompletionEvidenceV1 {
  return {
    ...humanEvidence(execution, gateId, "manual-attest"),
    result,
    provenance: { source: "runner", adapterId: "local-command", runId, rawResult: `exit ${result === "pass" ? 0 : 1}` },
  };
}

function overrideEvidence(
  execution: SubmittedExecutionRef,
  gateId: string,
  waivedReceiptId: string,
): CompletionEvidenceV1 {
  return {
    ...humanEvidence(execution, gateId, "manual-attest"),
    provenance: { source: "human", adapterId: "manual-attest", runId: "override:owner", rawResult: "override" },
    override: { rationale: "Runner host lost network mid-run", waivedReceiptId },
  };
}

/** Publish through the canonical compile and fold the event with the replay reducer, as the projection does. */
function record(snapshot: TaskLifecycleSnapshot, evidence: CompletionEvidenceV1, opId: string): TaskLifecycleSnapshot {
  const execution = snapshot.executions.find((value) => value.state === "submitted")!,
    compiled = compileCompletionGateWitness({
      snapshot,
      taskId: "task",
      executionId: execution.executionId,
      gateId: evidence.gateId,
      result: evidence.result as "pass" | "fail",
      evidence,
      receiptId: opId,
      checkerId: evidence.checkerId,
      commitSha: execution.submission!.commitSha,
      iteration: execution.iteration,
      actor,
      source: "local",
      opId,
      eventId: `event-${opId}`,
      workspaceRevision: snapshot.revision + 1,
      occurredAt: "2026-09-17T00:02:00.000Z",
      packagePath: null,
      currentDocuments: [],
    });
  return reduceTaskEvent(snapshot, compiled.event);
}

function gateStatus(snapshot: TaskLifecycleSnapshot, gateId: string): string | undefined {
  const execution = snapshot.executions.find((value) => value.state === "submitted")!;
  return gateResults(snapshot, undefined, execution.executionId, execution.submission, execution.iteration).find(
    (gate) => gate.gateId === gateId,
  )?.status;
}

test("automated-only and manual-attest gates keep one lane and admit no signoff or override", () => {
  const automated = governedFixture(localRequirement("exit 0")),
    failed = record(automated.snapshot, automatedEvidence(automated.execution, "lint", "fail"), "op-fail");
  assert.equal(gateStatus(failed, "lint"), "failed");
  assert.throws(() => record(failed, humanEvidence(automated.execution, "lint", "manual-attest"), "op-signoff"), {
    code: "invalid_proof",
  });
  assert.throws(() => record(failed, overrideEvidence(automated.execution, "lint", "op-fail"), "op-override"), {
    code: "invalid_proof",
  });
  const passed = record(automated.snapshot, automatedEvidence(automated.execution, "lint", "pass"), "op-pass");
  assert.equal(gateStatus(passed, "lint"), "passed");

  const manual = governedFixture(manualRequirement());
  assert.equal(gateStatus(manual.snapshot, "signoff"), "missing");
  const attested = record(manual.snapshot, humanEvidence(manual.execution, "signoff", "manual-attest"), "op-attest");
  assert.equal(gateStatus(attested, "signoff"), "passed");
});

test("dual control needs the automated pass and a human signoff, kept as separate witnesses", () => {
  const { snapshot, execution } = governedFixture({ ...localRequirement("exit 0"), mandatorySignoff: true }),
    machinePassed = record(snapshot, automatedEvidence(execution, "lint", "pass"), "op-pass");
  assert.equal(gateStatus(machinePassed, "lint"), "signoff_missing");
  const blocker = completionBlockers(machinePassed, execution.executionId, {
    closeout: "ready",
    closeoutPath: "tasks/task/closeout.md",
    eligibleDirtyPaths: [],
    producesFactCount: 1,
  })[0];
  assert.equal(blocker?.gate, "lint");
  assert.match(blocker?.next.action ?? "", /ha task attest task --gate lint --result pass$/u);

  const signed = record(machinePassed, humanEvidence(execution, "lint", "manual-attest"), "op-signoff");
  assert.equal(gateStatus(signed, "lint"), "passed");
  assert.deepEqual(
    signed.gateWitnesses.map((witness) => [witness.receiptId, witness.provenance?.source]),
    [
      ["op-pass", "runner"],
      ["op-signoff", "human"],
    ],
  );
  const rejected = record(
    machinePassed,
    { ...humanEvidence(execution, "lint", "manual-attest"), result: "fail" },
    "op-no",
  );
  assert.equal(gateStatus(rejected, "lint"), "failed");
  // A signoff never stands in for the automated witness itself.
  const machineFailed = record(snapshot, automatedEvidence(execution, "lint", "fail"), "op-fail"),
    signedOverFail = record(machineFailed, humanEvidence(execution, "lint", "manual-attest"), "op-signoff");
  assert.equal(gateStatus(signedOverFail, "lint"), "failed");
});

test("break-glass override waives only the recorded automated fail it names and never erases it", () => {
  const { snapshot, execution } = governedFixture({ ...localRequirement("exit 1"), allowOverride: true }),
    failed = record(snapshot, automatedEvidence(execution, "lint", "fail"), "op-fail");
  assert.equal(gateStatus(failed, "lint"), "failed");
  assert.equal(waivableAutomatedFail(failed.gateWitnesses, execution as never, "lint")?.receiptId, "op-fail");

  const waived = record(failed, overrideEvidence(execution, "lint", "op-fail"), "op-override");
  assert.equal(gateStatus(waived, "lint"), "waived");
  assert.deepEqual(
    waived.gateWitnesses.map((witness) => [witness.receiptId, witness.result, witness.override?.waivedReceiptId]),
    [
      ["op-fail", "fail", undefined],
      ["op-override", "pass", "op-fail"],
    ],
  );
  const detail = gateResults(
    waived,
    undefined,
    execution.executionId,
    execution.submission as never,
    execution.iteration,
  )[0];
  assert.equal(detail?.ok, true);
  assert.match(detail?.detail ?? "", /op-fail waived by .*Runner host lost network/u);
  assert.deepEqual(
    canonicalGateReceipts(waived, waived.executions.find((value) => value.state === "submitted") as never).map(
      (receipt) => receipt.receiptRef,
    ),
    ["event:op-override"],
  );

  // An override naming another receipt, or a newer automated fail, is not waived.
  assert.equal(
    gateStatus(record(failed, overrideEvidence(execution, "lint", "op-other"), "op-override"), "lint"),
    "failed",
  );
  assert.equal(
    gateStatus(record(waived, automatedEvidence(execution, "lint", "fail", "local-run-2"), "op-fail-2"), "lint"),
    "failed",
  );
  // An automated pass supersedes the need for the waiver.
  assert.equal(gateStatus(record(waived, automatedEvidence(execution, "lint", "pass"), "op-pass"), "lint"), "passed");

  // Evidence-level fences: only a human pass with a real rationale can carry an override.
  const override = overrideEvidence(execution, "lint", "op-fail"),
    judge = (evidence: CompletionEvidenceV1) =>
      judgeCompletionEvidence(evidence, { execution: execution as never, gateId: "lint" }).accepted;
  assert.equal(judge(override), true);
  assert.equal(judge({ ...override, override: { rationale: "  flaky  ", waivedReceiptId: "op-fail" } }), false);
  assert.equal(judge({ ...override, provenance: { ...override.provenance, source: "runner" } }), false);
  assert.equal(judge({ ...override, result: "fail" }), false);
});

function attestCell(snapshot: TaskLifecycleSnapshot) {
  const execution = snapshot.executions.find((value) => value.state === "submitted")!,
    { published, cell } = publishingCell(execution as never);
  return {
    published,
    cell: {
      ...cell,
      projection: {
        read: () => ({ status: "ready", watermark: 1, sourceRevision: 1, snapshot, packagePath: null }),
      },
    } as unknown as RepoCellOperationalContext,
  };
}

test("attest admission: human principal, closed fields, owner-only override over recorded evidence", () => {
  const overridable = governedFixture({ ...localRequirement("exit 1"), allowOverride: true }),
    owner = {
      actor: { principal: overridable.snapshot.task!.createdBy.principal, executor: null },
      source: "local",
    } as RepoCellBinding,
    attest = (snapshot: TaskLifecycleSnapshot, action: Record<string, unknown>, as: RepoCellBinding = owner) => {
      const target = attestCell(snapshot);
      attestGateWitness(
        target.cell,
        { kind: "task-attest", taskId: "task", gateId: "lint", result: "pass", ...action },
        as,
      );
      return target.published;
    },
    override = { mode: "override", rationale: "Runner host lost network mid-run" };
  // A runtime session carries an executor: switching mode never grants it a human attestation.
  assert.throws(
    () =>
      attest(overridable.snapshot, override, {
        actor: { ...owner.actor, executor: { kind: "agent", id: "runtime-session:runtime-1" } },
        source: "local",
      } as RepoCellBinding),
    { code: "actor_unauthorized" },
  );
  assert.throws(() => attest(overridable.snapshot, { ...override, executor: "none" }), { code: "invalid_command" });
  assert.throws(() => attest(overridable.snapshot, { mode: "override", rationale: "flaky" }), {
    code: "invalid_field",
  });
  assert.throws(() => attest(overridable.snapshot, { mode: "override" }), { code: "invalid_field" });
  assert.throws(() => attest(overridable.snapshot, { ...override, result: "fail" }), { code: "invalid_field" });
  assert.throws(() => attest(overridable.snapshot, { rationale: "Runner host lost network" }), {
    code: "invalid_field",
  });
  // No recorded automated fail on the cut: nothing to waive.
  assert.throws(() => attest(overridable.snapshot, override), { code: "invalid_transition" });
  const failed = record(overridable.snapshot, automatedEvidence(overridable.execution, "lint", "fail"), "op-fail");
  assert.throws(
    () =>
      attest(failed, override, {
        actor: { principal: { personId: "not-owner" }, executor: null },
        source: "local",
      } as RepoCellBinding),
    { code: "actor_unauthorized" },
  );
  const published = attest(failed, override);
  assert.equal(published.length, 1);
  assert.deepEqual(published[0]!.override, {
    rationale: "Runner host lost network mid-run",
    waivedReceiptId: "op-fail",
  });
  assert.equal(published[0]!.provenance.source, "human");
  // The published override is exactly what the canonical write admits and the judgment waives.
  assert.equal(gateStatus(record(failed, published[0]!, "op-override"), "lint"), "waived");

  // A gate without allowOverride refuses override; a gate without mandatorySignoff refuses approve.
  const plain = governedFixture(localRequirement("exit 1")),
    plainFailed = record(plain.snapshot, automatedEvidence(plain.execution, "lint", "fail"), "op-fail");
  assert.throws(() => attest(plainFailed, override), { code: "invalid_command" });
  assert.throws(() => attest(plainFailed, {}), { code: "invalid_command" });

  // Dual control: signoff only over the recorded automated pass of this cut.
  const dual = governedFixture({ ...localRequirement("exit 0"), mandatorySignoff: true });
  assert.throws(() => attest(dual.snapshot, { note: "looked at the diff" }), { code: "invalid_transition" });
  const dualPassed = record(dual.snapshot, automatedEvidence(dual.execution, "lint", "pass"), "op-pass"),
    signoff = attest(dualPassed, { note: "looked at the diff" });
  assert.equal(signoff.length, 1);
  assert.equal(signoff[0]!.override, undefined);
  assert.equal(gateStatus(record(dualPassed, signoff[0]!, "op-signoff"), "lint"), "passed");
});
