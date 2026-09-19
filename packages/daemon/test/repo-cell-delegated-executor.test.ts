// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindWriterGenerationToken,
  serializePeopleRosterDocument,
  type DelegatedExecutionToken,
  type LeaseV1,
  type RuntimeSession,
} from "../../kernel/src/index.ts";
import { createRepoCellApi, type RepoCellApiContext } from "../src/repo-cell-api.ts";
import { failed } from "../src/repo-cell-settlement.ts";
import type { RepoCellBinding } from "../src/repo-cell-types.ts";

const now = "2026-09-19T12:00:00.000Z";
const ownedTaskId = "task-delegation-owned",
  targetTaskId = "task-delegation-target",
  ownedExecutionId = "exec-delegation-owned",
  runtimeSessionId = "delegation-runtime",
  issuerPersonId = "person_zeyu",
  delegatedExecutor = { kind: "agent", id: `runtime-session:${runtimeSessionId}` } as const,
  delegatedActor = {
    principal: { personId: issuerPersonId },
    executor: delegatedExecutor,
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
      taskId: ownedTaskId,
      executionId: ownedExecutionId,
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
const ownedLease: LeaseV1 = {
  schema: "lease/v1",
  taskId: ownedTaskId,
  executionId: ownedExecutionId,
  actor: delegatedActor,
  source: "local",
  phase: "held",
  expiresAt: "2026-09-19T13:00:00.000Z",
  ttlMs: 3_600_000,
  version: 1,
};
const delegatedAction = {
  kind: "task-amend",
  taskId: targetTaskId,
  patches: [{ field: "title", value: "Delegated ledger operations" }],
  executor: delegatedExecutor,
} as const;

function token(overrides: Partial<DelegatedExecutionToken> = {}): DelegatedExecutionToken {
  return {
    schema: "delegated-execution-token/v1",
    tokenId: "det_ledger_ops_1",
    issuer: { personId: issuerPersonId },
    delegate: { runtimeSessionId },
    allowedActions: ["task-amend"],
    issuedAt: "2026-09-19T11:00:00.000Z",
    expiresAt: "2026-09-19T13:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function rosterBody(tokens: readonly DelegatedExecutionToken[] = [token()]): string {
  return serializePeopleRosterDocument({
    schema: "harness-people/v1",
    people: [
      {
        personId: issuerPersonId,
        displayName: "Issuing Principal",
        roles: ["owner"],
        credentials: [],
      },
    ],
    roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }],
    bindings: [],
    delegatedExecutionTokens: [...tokens],
  });
}

function bindingFor(principalPersonId = issuerPersonId): RepoCellBinding {
  return {
    actor: { principal: { personId: principalPersonId }, executor: null },
    source: "local",
    authorizationBindingMode: "default",
  };
}

test("a delegated executor claim crosses task bindings through a valid token", async () => {
  const context = contextFor(() => rosterBody());
  const receipt = await createRepoCellApi(context).run(delegatedAction, bindingFor());

  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.deepEqual(context.observedActor, delegatedActor);
  const decision = receipt.authorizationDecision as unknown as {
    readonly outcome?: string;
    readonly bindingsUsed?: readonly Readonly<Record<string, unknown>>[];
  };
  assert.equal(decision?.outcome, "allowed");
  assert.deepEqual(
    decision?.bindingsUsed?.find((binding) => binding.proof === "delegated-execution-token"),
    {
      proof: "delegated-execution-token",
      tokenId: "det_ledger_ops_1",
      issuerPersonId,
      runtimeSessionId,
    },
  );
});

test("the delegated claim authorizes as the issuer, not the transport principal", async () => {
  const ownerRoster = serializePeopleRosterDocument({
      schema: "harness-people/v1",
      people: [
        { personId: issuerPersonId, displayName: "Issuing Principal", roles: ["owner"], credentials: [] },
        { personId: "person_operator", displayName: "Local Operator", roles: ["reviewer"], credentials: [] },
      ],
      roles: [
        { roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] },
        { roleId: "reviewer", commandClasses: ["repo-read"] },
      ],
      bindings: [],
      delegatedExecutionTokens: [token()],
    }),
    ownerContext = contextFor(() => ownerRoster),
    ownerBinding: RepoCellBinding = {
      actor: { principal: { personId: "person_operator" }, executor: null },
      source: "local",
      authorizationBindingMode: "declared",
      roleBindings: [],
    },
    allowed = await createRepoCellApi(ownerContext).run(delegatedAction, ownerBinding);
  assert.equal(allowed.outcome, "applied", JSON.stringify(allowed));
  assert.deepEqual(ownerContext.observedActor, delegatedActor);

  const reviewerOnly = serializePeopleRosterDocument({
      schema: "harness-people/v1",
      people: [
        { personId: issuerPersonId, displayName: "Issuing Reviewer", roles: ["reviewer"], credentials: [] },
        { personId: "person_operator", displayName: "Local Operator", roles: ["owner"], credentials: [] },
      ],
      roles: [
        { roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] },
        { roleId: "reviewer", commandClasses: ["repo-read"] },
      ],
      bindings: [],
      delegatedExecutionTokens: [token()],
    }),
    reviewerContext = contextFor(() => reviewerOnly),
    denied = await createRepoCellApi(reviewerContext).run(delegatedAction, ownerBinding);
  assert.equal(denied.outcome, "op_rejected", JSON.stringify(denied));
  assert.equal(denied.code, "authorization_denied");
  assert.equal(reviewerContext.observedActor, null);
});

test("a claim without any covering token keeps the executor binding rejection", async () => {
  const receipt = await createRepoCellApi(contextFor(() => rosterBody([]))).run(delegatedAction, bindingFor());

  assert.equal(receipt.outcome, "op_rejected");
  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(
    String(receipt.diagnostic?.expectation),
    new RegExp(
      `No DelegatedExecutionToken is issued to RuntimeSession ${runtimeSessionId}.*` +
        `ha people delegate --runtime-session-id ${runtimeSessionId} --action task-amend`,
      "u",
    ),
  );
});

test("a token pinned to another RuntimeSession does not cover this session's claim", async () => {
  const foreign = rosterBody([token({ delegate: { runtimeSessionId: "other-runtime" } })]),
    receipt = await createRepoCellApi(contextFor(() => foreign)).run(delegatedAction, bindingFor());

  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(String(receipt.diagnostic?.expectation), /No DelegatedExecutionToken is issued/u);
});

test("an expired token is rejected with its expiry in the diagnostic", async () => {
  const expired = rosterBody([token({ expiresAt: "2026-09-19T11:30:00.000Z" })]),
    receipt = await createRepoCellApi(contextFor(() => expired)).run(delegatedAction, bindingFor());

  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(String(receipt.diagnostic?.expectation), /det_ledger_ops_1.*expired at 2026-09-19T11:30:00\.000Z/u);
});

test("a revoked token is rejected even when it has not expired", async () => {
  const revoked = rosterBody([token({ revokedAt: "2026-09-19T11:30:00.000Z" })]),
    context = contextFor(() => revoked),
    receipt = await createRepoCellApi(context).run(delegatedAction, bindingFor());

  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(String(receipt.diagnostic?.expectation), /det_ledger_ops_1.*revoked at 2026-09-19T11:30:00\.000Z/u);
  assert.equal(context.observedActor, null);
});

test("an Action outside the delegated set names the missing Action", async () => {
  const narrow = rosterBody([token({ allowedActions: ["task-annotate"] })]),
    receipt = await createRepoCellApi(contextFor(() => narrow)).run(delegatedAction, bindingFor());

  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(String(receipt.diagnostic?.expectation), /det_ledger_ops_1.*does not allow task-amend/u);
});

test("revocation observed at the writer cut rejects the queued write after it", async () => {
  let revoked = false;
  const context = contextFor(() => rosterBody(revoked ? [token({ revokedAt: now })] : [token()])),
    api = createRepoCellApi(context),
    before = await api.run(delegatedAction, bindingFor());
  assert.equal(before.outcome, "applied", JSON.stringify(before));

  revoked = true;
  const after = await api.run(delegatedAction, bindingFor());
  assert.equal(after.outcome, "op_rejected");
  assert.equal(after.code, "executor_binding_invalid");
  assert.match(String(after.diagnostic?.expectation), /revoked at/u);
});

test("a delegated claim still requires the claimed RuntimeSession to exist", async () => {
  const receipt = await createRepoCellApi(contextFor(() => rosterBody(), { session: null })).run(
    delegatedAction,
    bindingFor(),
  );

  assert.equal(receipt.code, "executor_binding_invalid");
  assert.match(String(receipt.rejectionExplanation), /not canonically bound/u);
});

function contextFor(
  roster: () => string,
  options: { readonly session?: RuntimeSession | null } = {},
): RepoCellApiContext & {
  readonly observedActor: RepoCellBinding["actor"] | null;
  readonly tailAssignments: number;
} {
  let currentTail: Promise<void> = Promise.resolve(),
    tailAssignments = 0;
  const activeWriter = { workspaceId: "repository", generation: 1, ownerId: "daemon" },
    session = options.session === undefined ? runtimeSession : options.session,
    fixture = {
      // Pre-queue reads resolve gate requirements from settings; this fixture declares no gates or workflows.
      extracted: {
        settings: {
          read: () => ({ ci: { workflows: [] } }),
          readRepository: () => ({ gates: [], ci: { workflows: [] } }),
        },
      },
      mode: "local",
      fleetRoster: null,
      input: { repoId: "repository" },
      rejected: (opId: string, code: string, nextAction: string) => ({
        outcome: "op_rejected",
        opId,
        code,
        nextAction,
      }),
      operationId: () => "op-delegated-executor",
      failed,
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
      activeWriterEpochFence: null,
      activeWriterEpochFenceDescriptor: null,
      withLayoutAdvisory: <T>(value: T) => value,
      withHumanSummary: <T>(value: T) => value,
      lastError: null,
      recoveryUncertain: false,
      recoveryProbe: { clear: () => undefined },
      replica: { kick: () => undefined },
      rootDir: "/repository",
      store: {
        readHead: () => ({ revision: 2 }),
        readCommandOutcome: () => ({
          opId: "op-delegated-executor",
          status: "accepted_durable",
          firstRevision: 3,
          lastRevision: 3,
          recordedAt: now,
          memberOpIds: ["op-delegated-executor"],
        }),
        readEvent: () => ({ opId: "op-delegated-executor" }),
        publication: () => ({
          commitSha: null,
          cut: { repoId: "repository", revision: 3, headDigest: "sha256:fixture" },
        }),
        ledgerMetadata: () => ({ repoId: "repository", generation: 1, revision: 3 }),
        followerStatus: () => ({
          git: { status: "pending", cut: null, commitSha: null },
          worktree: { status: "pending", cut: null, commitSha: null },
        }),
      },
      projection: {
        read: (candidateTaskId: string) => ({
          packagePath: `tasks/${candidateTaskId}-package`,
          snapshot: {
            task: { taskId: candidateTaskId, iteration: 1, completionGateIds: [] },
            executions: [{ iteration: 1, executionId: ownedExecutionId, submission: { commitSha: null } }],
          },
        }),
        readTaskCompletion: () => null,
        readRuntimeSession: () => session,
        currentLease: () => ownedLease,
        readCut: () => ({ status: "ready", watermark: 3, sourceRevision: 3 }),
        readDocument: () => {
          const body = roster();
          return {
            status: "ready",
            document: {
              path: "people.yaml",
              blobSha256: "sha256:people-fixture",
              body,
              size: body.length,
              mediaType: "application/json",
              policyId: "people-registry",
              workspaceRevision: 1,
            },
            watermark: 3,
            sourceRevision: 3,
          };
        },
      },
      now: () => now,
      executeAction: (_action: unknown, verified: RepoCellBinding) => {
        fixture.observedActor = verified.actor;
        return Promise.resolve({
          outcome: "applied",
          opId: "op-delegated-executor",
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
      runtimeSpawner: {
        spawn: () => Promise.resolve({ ok: true }),
      },
      observedActor: null as RepoCellBinding["actor"] | null,
    };
  return fixture as unknown as RepoCellApiContext & {
    readonly observedActor: RepoCellBinding["actor"] | null;
    readonly tailAssignments: number;
  };
}
