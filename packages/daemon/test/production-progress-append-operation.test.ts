// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskHolderService,
  resolveHarnessLayout,
  taskHolderActor
} from "@harness-anything/kernel";
import {
  DurableRepoWriteOutcomeStoreV1,
  ProductionProgressAppendOperationHost,
  ReceiptSettlementStore,
  decodeRepoWriteProgressCommand,
  encodeRepoWriteCommand,
  encodeRepoWriteProgressCommand,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type HarnessDaemonRuntime,
  type ProductionProgressAppendCompileInput,
  type RepoWriteDocSyncExecution
} from "../src/index.ts";
import { cliDaemonCommandHostServices } from "../../cli/src/composition/daemon-command-host-services.ts";
import { daemonActorAttribution } from "../../cli/src/composition/actor-attribution.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture
} from "../../cli/test/helpers/production-authority-lifecycle-fixture.ts";
import type { ParsedCommand } from "../../cli/src/cli/types.ts";

const operationTest = process.platform === "win32" ? test.skip : test;
const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";

test("progress child DTO rejects actor-stamp and peer-credential tampering", () => {
  const actor = productionAuthorityActor();
  const command = encodeRepoWriteProgressCommand({
    command: progressCommand("/repo") as unknown as Record<string, unknown>,
    context: {
      actor,
      authorityConnection: productionAuthorityConnection(actor),
      currentSession: {
        runtime: "codex",
        sessionId: "session-progress-codec",
        source: "manual",
        detectedAt: "2026-07-24T00:00:00.000Z"
      },
      executor: { kind: "agent", id: "codex" }
    }
  });
  assert.equal(decodeRepoWriteProgressCommand(command).actor.personId, actor.personId);

  const actorTamper = structuredClone(command);
  actorTamper.actor.personId = "person_mallory";
  assert.throws(
    () => decodeRepoWriteProgressCommand(actorTamper),
    /REPO_WRITE_PROGRESS_ACTOR_STAMP_MISMATCH/u
  );

  const peerTamper = structuredClone(command);
  peerTamper.context.authorityConnection = {
    ...(peerTamper.context.authorityConnection as Record<string, unknown>),
    peerCredential: {
      schema: "os-observed-peer-credential/v1",
      platform: "darwin",
      source: "client-asserted",
      uid: 501
    }
  };
  assert.throws(
    () => decodeRepoWriteProgressCommand(peerTamper),
    /REPO_WRITE_PROGRESS_CONTEXT_INVALID/u
  );
});

operationTest("progress pilot orders outer fsync before read-only lease and inner submission", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-progress-operation-"));
  const events: string[] = [];
  try {
    enableLeaseEnforcement(fixture.authoredRoot);
    installTask(fixture.authoredRoot);
    const actor = productionAuthorityActor();
    const command = progressCommand(fixture.repoRoot);
    const attribution = daemonActorAttribution(actor, { kind: "agent", id: "codex" });
    const holder = makeTaskHolderService({ rootInput: fixture.repoRoot });
    await holder.claim({
      taskId,
      principal: taskHolderActor(
        attribution.taskHolderPrincipal,
        attribution.executor
      ),
      ttlMs: 60_000
    });
    const holderPath = path.join(
      fixture.repoRoot,
      `.harness/task-holders/${taskId}.json`
    );
    const holderBefore = readFileSync(holderPath, "utf8");
    const store = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...axes(),
      __testOnlyDurabilityHooks: durabilityEvents(events)
    });
    const authority = authorityComponent(events);
    const host = operationHost(store, authority, events, outcomeDirectory);
    const dto = encodeRepoWriteCommand({
      command: command as unknown as Record<string, unknown>,
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-progress-operation",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    });

    const prepared = await host.prepare({
      repoId: axes().repoId,
      generation: axes().generation,
      requestId: "request-progress",
      command: dto
    });
    events.push("parent-proceed");
    const terminal = await prepared.execute();

    assert.equal(terminal.phase, "TERMINAL");
    assert.equal(terminal.terminalKind, "committed", JSON.stringify({
      receipt: terminal.receipt,
      evidence: terminal.terminalProof.evidence,
      events
    }));
    assert.equal(terminal.innerOpId, "inner-progress-operation");
    assert.equal(readFileSync(holderPath, "utf8"), holderBefore);
    await host.settlementIdle();
    assert.deepEqual(events, [
      "plan-fixed-attempt",
      "parent-proceed",
      "outer-proceeding-fsynced",
      "inner-submit",
      "outer-terminal-fsynced"
    ]);
    assert.deepEqual(runtimeEventTools(fixture.repoRoot, "session-progress-operation"), ["progress-append"]);
    assert.equal(terminal.receipt.meta.generatedAt, "2026-07-24T00:00:00.000Z");
    assert.equal(terminal.receipt.details?.actor?.personId, actor.personId);
    assert.deepEqual(terminal.receipt.details?.data?.repoWrite, {
      schema: "repo-write-recovery/v1",
      repoId: axes().repoId,
      generation: axes().generation,
      outerOpId: prepared.opId
    });
    const restarted = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...axes()
    }).lookup(prepared.opId);
    assert.equal(restarted.state, "terminal");
    if (restarted.state !== "terminal") return;
    assert.equal(
      JSON.stringify(restarted.outcome.receipt),
      JSON.stringify(terminal.receipt)
    );
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

operationTest("same-state transition returns an already-satisfied success receipt", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-status-already-satisfied-"));
  const events: string[] = [];
  try {
    enableLeaseEnforcement(fixture.authoredRoot);
    installTask(fixture.authoredRoot);
    const actor = productionAuthorityActor();
    const attribution = daemonActorAttribution(actor, { kind: "agent", id: "codex" });
    await makeTaskHolderService({ rootInput: fixture.repoRoot }).claim({
      taskId,
      principal: taskHolderActor(attribution.taskHolderPrincipal, attribution.executor),
      ttlMs: 60_000
    });
    const store = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...axes(),
      __testOnlyDurabilityHooks: durabilityEvents(events)
    });
    const authority = authorityComponent(events, undefined, "already-satisfied");
    const host = operationHost(store, authority, events, outcomeDirectory);
    const dto = encodeRepoWriteCommand({
      command: statusCommand(fixture.repoRoot) as unknown as Record<string, unknown>,
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-status-already-satisfied",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    });

    const prepared = await host.prepare({
      repoId: axes().repoId,
      generation: axes().generation,
      requestId: "request-status-already-satisfied",
      command: dto
    });
    const terminal = await prepared.execute();

    assert.equal(terminal.phase, "TERMINAL");
    assert.equal(terminal.terminalKind, "committed");
    assert.equal(terminal.terminalProof.evidence.tag, "ALREADY_SATISFIED");
    assert.equal(terminal.receipt.ok, true);
    assert.equal(terminal.receipt.summary, "目标状态已满足,本次无变更");
    assert.deepEqual(terminal.receipt.details?.data?.authorityOutcome, {
      kind: "already-satisfied",
      message: "目标状态已满足,本次无变更"
    });
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

operationTest("progress pilot resumes one exact fixed attempt after a post-PROCEEDING crash", async () => {
  const fixture = createProductionAuthorityLifecycleFixture();
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-progress-recovery-"));
  const events: string[] = [];
  try {
    enableLeaseEnforcement(fixture.authoredRoot);
    installTask(fixture.authoredRoot);
    const actor = productionAuthorityActor();
    const attribution = daemonActorAttribution(actor, { kind: "agent", id: "codex" });
    await makeTaskHolderService({ rootInput: fixture.repoRoot }).claim({
      taskId,
      principal: taskHolderActor(
        attribution.taskHolderPrincipal,
        attribution.executor
      ),
      ttlMs: 60_000
    });
    let target = "";
    let crashed = false;
    const crashingStore = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...axes(),
      __testOnlyDurabilityHooks: {
        beforePublishLink: (input) => {
          target = input.target;
        },
        afterDirectoryFsync: (reason) => {
          if (reason !== "publish" || crashed
            || !target.endsWith(".proceeding.json")) return;
          crashed = true;
          events.push("outer-proceeding-fsynced");
          throw new Error("simulated child exit after durable PROCEEDING");
        }
      }
    });
    const prepared = await operationHost(
      crashingStore,
      authorityComponent(events),
      events,
      outcomeDirectory
    ).prepare({
      repoId: axes().repoId,
      generation: axes().generation,
      requestId: "request-progress-recovery",
      command: encodeRepoWriteProgressCommand({
        command: progressCommand(fixture.repoRoot) as unknown as Record<string, unknown>,
        context: {
          actor,
          authorityConnection: productionAuthorityConnection(actor),
          currentSession: {
            runtime: "codex",
            sessionId: "session-progress-recovery",
            source: "manual",
            detectedAt: "2026-07-24T00:00:00.000Z"
          },
          executor: { kind: "agent", id: "codex" }
        }
      })
    });

    await assert.rejects(
      prepared.execute(),
      /simulated child exit after durable PROCEEDING/u
    );
    assert.deepEqual(events, [
      "plan-fixed-attempt",
      "outer-proceeding-fsynced"
    ]);
    const durable = new DurableRepoWriteOutcomeStoreV1({
      directory: outcomeDirectory,
      ...axes()
    });
    const proceeding = durable.lookup(prepared.opId);
    assert.equal(proceeding.state, "proceeding");
    if (proceeding.state !== "proceeding") return;

    const recoveryHost = operationHost(
      durable,
      authorityComponent(events, {
        outerOpId: prepared.opId,
        outerRequestDigest: proceeding.outcome.requestDigest
      }),
      events,
      outcomeDirectory
    );
    const terminal = await recoveryHost.lookup({ opId: prepared.opId });
    await recoveryHost.settlementIdle();

    assert.equal(terminal.state, "terminal");
    if (terminal.state !== "terminal") return;
    assert.equal(terminal.outcome.terminalKind, "committed");
    assert.equal(terminal.outcome.innerOpId, "inner-progress-operation");
    assert.deepEqual(events, [
      "plan-fixed-attempt",
      "outer-proceeding-fsynced",
      "inner-submit-recovery"
    ]);
    assert.deepEqual(runtimeEventTools(fixture.repoRoot, "session-progress-recovery"), ["progress-append"]);
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function operationHost(
  store: DurableRepoWriteOutcomeStoreV1,
  authorityComponent: AuthorityRepoComponent,
  events: string[],
  outcomeDirectory: string,
  executeDocSyncSubmit?: () => Promise<RepoWriteDocSyncExecution>
) {
  return new ProductionProgressAppendOperationHost({
    ...axes(),
    runtime: runtime(events),
    authorityComponent,
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: store,
    settlementStore: new ReceiptSettlementStore({
      directory: path.join(outcomeDirectory, "settlements"),
      ...axes()
    }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    newOuterOpId: () => "outer-progress-operation",
    ...(executeDocSyncSubmit ? { executeDocSyncSubmit } : {})
  });
}

function authorityComponent(
  events: string[],
  expectedRecovery?: {
    readonly outerOpId: string;
    readonly outerRequestDigest: string;
  },
  outcome: "committed" | "already-satisfied" = "committed"
): AuthorityRepoComponent {
  const bindConnection = (): AuthorityRepoConnectionBinding => ({
    ...terminalDurableSubmission(async () => { throw new Error("unplanned authority submit"); }),
    planCommand: async (expected) => {
      events.push("plan-fixed-attempt");
      return plan({
        ...expected,
        canonicalEntityId: `task/${taskId}`
      });
    },
    plannedCommandSubmission: ({ expected, plan: fixed, recovery }) => terminalDurableSubmission(
      async (actual) => {
        assert.deepEqual(actual, {
          ...expected,
          ingress: "generic",
          canonicalEntityId: fixed.targetEntityId
        });
        assert.equal(fixed.innerOpId, "inner-progress-operation");
        if (expectedRecovery) {
          assert.deepEqual(recovery, {
            ...expectedRecovery,
            outerGeneration: axes().generation
          });
          events.push("inner-submit-recovery");
        } else {
          assert.equal(recovery, undefined);
          events.push("inner-submit");
        }
        return outcome === "already-satisfied"
          ? alreadySatisfiedEvidence(fixed.semanticDigest)
          : committedEvidence(fixed.semanticDigest);
      }
    ),
    planProgressAppend: async (expected) => {
      events.push("plan-fixed-attempt");
      return plan(expected);
    },
    plannedProgressAppendSubmission: ({ expected, plan: fixed, recovery }) => terminalDurableSubmission(
      async (actual) => {
        assert.deepEqual(actual, {
          ...expected,
          ingress: "generic"
        });
        assert.equal(fixed.innerOpId, "inner-progress-operation");
        if (expectedRecovery) {
          assert.deepEqual(recovery, {
            ...expectedRecovery,
            outerGeneration: axes().generation
          });
          events.push("inner-submit-recovery");
        } else {
          assert.equal(recovery, undefined);
          events.push("inner-submit");
        }
        return committedEvidence(fixed.semanticDigest);
      }
    )
  });
  return {
    commandSubmissionV2: terminalDurableSubmission(
      async () => { throw new Error("unbound"); }
    ),
    cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
    bindConnection,
    stop: async () => undefined
  };
}

function terminalDurableSubmission(
  submit: AuthorityRepoConnectionBinding["submit"]
): Pick<AuthorityRepoConnectionBinding, "submit" | "submitDurable"> {
  return {
    submit,
    submitDurable: async (input) => {
      const receipt = await submit(input);
      return {
        admission: Promise.resolve({ kind: "terminal", receipt }),
        settlement: Promise.resolve(receipt)
      };
    }
  };
}

function plan(expected: ProductionProgressAppendCompileInput) {
  return {
    schema: "production-authority-attempt-plan/v1" as const,
    commandKind: "progress-append" as const,
    targetEntityId: expected.canonicalEntityId,
    requestId: "authority-command:progress-operation",
    innerOpId: "inner-progress-operation",
    semanticDigest: "1".repeat(64),
    tokenId: "token-progress-operation",
    bindingId: "binding-progress-operation",
    plannedAtMs: "1",
    expiresAtMs: "300001",
    presentationTokenBase64url: "AQ",
    envelopeBase64url: "Ag",
    attribution: expected.attribution.writeAttribution
  };
}

function committedEvidence(semanticDigest: string) {
  return {
    tag: "COMMITTED" as const,
    workspaceId: axes().workspaceId,
    opId: "inner-progress-operation",
    semanticDigest,
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2" as const,
      semanticRequestDigest: semanticDigest,
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: {
        registryVersion: 1,
        mutations: [{
          entity: {
            registryVersion: 1,
            entityKind: "task",
            canonicalRef: `task/${taskId}`
          },
          action: { registryVersion: 1, action: "progress-append" }
        }]
      }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2" as const,
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  };
}

function alreadySatisfiedEvidence(semanticDigest: string) {
  const integrity = committedEvidence(semanticDigest).authorityIntegrity;
  return {
    tag: "ALREADY_SATISFIED" as const,
    workspaceId: axes().workspaceId,
    opId: "inner-progress-operation",
    semanticDigest,
    message: "目标状态已满足,本次无变更" as const,
    stateProof: {
      schema: "authority-already-satisfied-state-proof/v1" as const,
      entityKind: "task",
      canonicalRef: `task/${taskId}`,
      path: `tasks/${taskId}/INDEX.md`,
      field: "status",
      requestedValue: "active",
      observedValue: "active",
      observedEpoch: "epoch-status",
      observedRevision: "0",
      observedBlobDigest: "6".repeat(64)
    },
    authorityIntegrity: {
      ...integrity,
      canonicalMutationSet: {
        ...integrity.canonicalMutationSet,
        mutations: integrity.canonicalMutationSet.mutations.map((mutation) => ({
          ...mutation,
          action: { registryVersion: 1, action: "transition" }
        }))
      }
    }
  };
}

function runtime(events: string[]): HarnessDaemonRuntime {
  return {
    start: async () => { throw new Error("not used"); },
    stop: async () => undefined,
    status: () => ({ started: true }) as ReturnType<HarnessDaemonRuntime["status"]>,
    enqueueInteractiveWrite: async (request) => {
      if (!events.includes("outer-proceeding-fsynced")) {
        throw new Error("operational write started before durable PROCEEDING");
      }
      events.push("runtime-event-write");
      return {
        commandId: request.commandId,
        opIds: request.ops.map((op) => op.opId),
        durable: true,
        flush: {
          reason: "explicit",
          opCount: request.ops.length,
          committed: true
        }
      };
    },
    enqueueBackgroundBatch: async () => { throw new Error("not used"); },
    enqueueMaterializerBatch: async () => ({
      dryRun: false,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: []
    }),
    enqueueAuthorityPublication: async () => { throw new Error("not used"); },
    queryExecutionEvidencePage: async () => ({ rows: [], nextCursor: null }),
    createAttributedCoordinator: () => { throw new Error("not used"); },
    assertWriteFenceHeld: async () => {
      if (!events.includes("outer-proceeding-fsynced")) {
        throw new Error("writer fence checked before durable PROCEEDING");
      }
    },
    admissionBudget: {
      acquire: () => { throw new Error("not used"); },
      snapshot: () => ({}) as never
    } as HarnessDaemonRuntime["admissionBudget"],
    subscribeProjectionChanges: () => () => undefined
  };
}

function progressCommand(rootDir: string): ParsedCommand {
  return {
    rootDir,
    json: true,
    action: {
      kind: "progress-append",
      taskId,
      text: "child operation progress\n",
      evidence: [],
      dryRun: false
    }
  };
}

function statusCommand(rootDir: string): ParsedCommand {
  return {
    rootDir,
    json: true,
    action: {
      kind: "status-set",
      taskId,
      status: "active",
      force: false,
      dryRun: false
    }
  };
}

function enableLeaseEnforcement(authoredRoot: string): void {
  writeFileSync(path.join(authoredRoot, "harness.yaml"), [
    "schema: harness-anything/v1",
    "project: progress-operation",
    "settings:",
    "  tasks:",
    "    leaseEnforcement: true",
    ""
  ].join("\n"));
}

function installTask(authoredRoot: string): void {
  const taskRoot = path.join(authoredRoot, "tasks", `${taskId}-progress-operation`);
  mkdirSync(taskRoot, { recursive: true });
  writeFileSync(path.join(taskRoot, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    "title: Progress operation",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref: ",
    "  titleSnapshot: Progress operation",
    "  url: ",
    "  bindingCreatedAt: 2026-07-24T00:00:00.000Z",
    `  bindingFingerprint: sha256:${"b".repeat(64)}`,
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "provenance:",
    "  - {runtime: \"human\", sessionId: \"fixture\", boundAt: \"2026-07-24T00:00:00.000Z\"}",
    "---",
    "",
    "# Progress operation",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskRoot, "task_plan.md"), [
    "# Task Plan",
    "",
    "## Goal",
    "",
    "Exercise the exact same-state transition path with a substantive plan.",
    ""
  ].join("\n"));
}

function durabilityEvents(events: string[]) {
  let target = "";
  return {
    beforePublishLink: (input: { readonly target: string }) => {
      target = input.target;
    },
    afterDirectoryFsync: (reason: string) => {
      if (reason !== "publish") return;
      if (target.endsWith(".proceeding.json")) events.push("outer-proceeding-fsynced");
      if (target.endsWith(".terminal.json")) events.push("outer-terminal-fsynced");
      target = "";
    }
  };
}

function runtimeEventTools(rootDir: string, sessionId: string): Array<unknown> {
  const body = readFileSync(resolveHarnessLayout(rootDir).runtimeEventLedgerPath(sessionId), "utf8");
  return body.trim().split("\n").map((line) => (
    (JSON.parse(line) as { readonly tool?: { readonly toolName?: unknown } }).tool?.toolName
  ));
}

function axes() {
  return {
    repoId: "canonical",
    workspaceId: "workspace-production",
    generation: 2
  } as const;
}
