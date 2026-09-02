// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { bindWriterGenerationToken, type LeaseV1, type RuntimeSession } from "../../kernel/src/index.ts";
import { createRepoCellApi, type RepoCellApiContext } from "../src/repo-cell-api.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

const now = "2026-09-03T12:00:00.000Z";
const taskId = "task-runtime-first-write";
const executionId = "exec-runtime-first-write";
const runtimeSessionId = "runtime-first-write";
const runtimeActor = {
  principal: { personId: "person-runtime-owner" },
  executor: { kind: "agent", id: `runtime-session:${runtimeSessionId}` },
} as const;
const runtimeSession: RuntimeSession = {
  runtimeSessionId,
  instanceId: "runtime-instance",
  installationId: "runtime-installation",
  kindId: "codex",
  definitionSnapshotRef: "sha256:runtime-definition",
  providerSessionId: "provider-session",
  transcriptRef: "transcript:provider-session",
  launchGeneration: 1,
  liveness: "live",
  attachable: true,
  taskBindings: [
    {
      taskId,
      executionId,
      providerSessionId: "provider-session",
      transcriptRef: "transcript:provider-session",
      boundAt: now,
    },
  ],
  outcome: null,
  exitCode: null,
  resultRef: null,
  lastObservedAt: now,
};
const lease: LeaseV1 = {
  schema: "lease/v1",
  taskId,
  executionId,
  actor: runtimeActor,
  source: "local",
  phase: "held",
  expiresAt: "2026-09-03T13:00:00.000Z",
  ttlMs: 3_600_000,
  version: 1,
};
const binding: RepoCellBinding = {
  actor: { principal: runtimeActor.principal, executor: null },
  source: "local",
  authorizationBindingMode: "default",
};
const action = {
  kind: "task-artifact-add",
  taskId,
  source: "report.md",
  destination: "reports/report.md",
  executor: runtimeActor.executor,
} as const;

test("executor binding waits for the preceding writer cut that binds the runtime session", async () => {
  let projectedSession: RuntimeSession | null = null,
    projectedLease: LeaseV1 | null = null;
  const precedingWrite = Promise.resolve().then(() => {
      projectedSession = runtimeSession;
      projectedLease = lease;
    }),
    context = contextFor(
      precedingWrite,
      () => projectedSession,
      () => projectedLease,
    ),
    receipt = await createRepoCellApi(context).run(action, binding);

  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.deepEqual(context.observedActor, runtimeActor);
});

test("executor binding still rejects a runtime session absent from the preceding writer cut", async () => {
  const context = contextFor(
      Promise.resolve(),
      () => null,
      () => null,
    ),
    receipt = await createRepoCellApi(context).run(action, binding);

  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "executor_binding_invalid");
  assert.equal(context.observedActor, null);
});

test("executor-free actions reach the publication queue synchronously", async () => {
  const context = contextFor(
      Promise.resolve(),
      () => null,
      () => null,
    ),
    { executor: _executor, ...executorFreeAction } = action,
    receipt = createRepoCellApi(context).run(executorFreeAction, binding);

  assert.equal(context.tailAssignments, 1);
  assert.equal((await receipt).outcome, "applied");
  assert.equal(context.tailAssignments, 1);
});

test("empty executor markers do not add a writer-cut queue hop", async () => {
  for (const executor of [null, undefined]) {
    const context = contextFor(
        Promise.resolve(),
        () => null,
        () => null,
      ),
      receipt = await createRepoCellApi(context).run({ ...action, executor }, binding);

    assert.equal(receipt.outcome, "applied");
    assert.equal(context.tailAssignments, 1, `executor=${String(executor)}`);
  }
});

function contextFor(
  tail: Promise<void>,
  readRuntimeSession: () => RuntimeSession | null,
  currentLease: () => LeaseV1 | null,
): RepoCellApiContext & {
  readonly observedActor: RepoCellBinding["actor"] | null;
  readonly tailAssignments: number;
} {
  let currentTail = tail,
    tailAssignments = 0;
  const activeWriter = { workspaceId: "repository", generation: 1, ownerId: "daemon" },
    fixture = {
      extracted: {},
      mode: "local",
      fleetRoster: null,
      input: { repoId: "repository" },
      rejected: (opId: string, code: string, nextAction: string) => ({
        outcome: "op_rejected",
        opId,
        code,
        nextAction,
      }),
      operationId: () => "op-runtime-first-write",
      failed: (opId: string, error: unknown) => ({
        outcome: "op_rejected",
        opId,
        code: (error as { readonly code?: string }).code ?? "invalid_command",
        nextAction: error instanceof Error ? error.message : String(error),
      }),
      fatalCellError: () => false,
      errorOperationId: () => null,
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
      requiredCellText: (value: unknown) => String(value),
      dispatchRead: () => null,
      state: "attached",
      attemptRecovery: async () => undefined,
      causeClass: null,
      latched: () => "latched",
      latchWith: () => undefined,
      queueDepth: 0,
      get tail() {
        return currentTail;
      },
      set tail(value: Promise<void>) {
        currentTail = value;
        tailAssignments += 1;
      },
      get tailAssignments() {
        return tailAssignments;
      },
      activeWriter,
      writerToken: bindWriterGenerationToken(activeWriter),
      activeWriterEpochGuard: null,
      activeWriterEpochFence: null,
      activeWriterEpochFenceDescriptor: null,
      withLayoutAdvisory: <T>(value: T) => value,
      withHumanSummary: <T>(value: T) => value,
      lastError: null,
      recoveryUncertain: false,
      recoveryProbe: { clear: () => undefined },
      replica: { kick: () => undefined },
      rootDir: "/repository",
      store: { readHead: () => ({ revision: 2 }) },
      projection: { readRuntimeSession, currentLease },
      now: () => now,
      executeAction: (_action: unknown, verified: RepoCellBinding) => {
        fixture.observedActor = verified.actor;
        return Promise.resolve({
          outcome: "applied",
          opId: "op-runtime-first-write",
          revision: 3,
          evidence: "{}",
          visibility: "center",
          proof: {
            committedRevision: 3,
            appliedCut: 3,
            durable: true,
            canonicalVisible: true,
            worktreeVisible: null,
          },
        });
      },
      observedActor: null as RepoCellBinding["actor"] | null,
    };
  return fixture as unknown as RepoCellApiContext & {
    readonly observedActor: RepoCellBinding["actor"] | null;
    readonly tailAssignments: number;
  };
}
