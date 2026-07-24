// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  makeTaskHolderService,
  taskHolderActor
} from "@harness-anything/kernel";
import {
  DurableRepoWriteOutcomeStoreV1,
  ProductionProgressAppendOperationHost,
  decodeRepoWriteProgressCommand,
  encodeRepoWriteProgressCommand,
  type AuthorityRepoComponent,
  type AuthorityRepoConnectionBinding,
  type HarnessDaemonRuntime,
  type ProductionProgressAppendCompileInput
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
    const host = operationHost(store, authority, events);
    const dto = encodeRepoWriteProgressCommand({
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
    assert.deepEqual(events, [
      "plan-fixed-attempt",
      "parent-proceed",
      "outer-proceeding-fsynced",
      "inner-submit",
      "runtime-event-write",
      "outer-terminal-fsynced"
    ]);
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
      events
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

    const terminal = await operationHost(
      durable,
      authorityComponent(events, {
        outerOpId: prepared.opId,
        outerRequestDigest: proceeding.outcome.requestDigest
      }),
      events
    ).lookup({ opId: prepared.opId });

    assert.equal(terminal.state, "terminal");
    if (terminal.state !== "terminal") return;
    assert.equal(terminal.outcome.terminalKind, "committed");
    assert.equal(terminal.outcome.innerOpId, "inner-progress-operation");
    assert.deepEqual(events, [
      "plan-fixed-attempt",
      "outer-proceeding-fsynced",
      "inner-submit-recovery",
      "runtime-event-write"
    ]);
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function operationHost(
  store: DurableRepoWriteOutcomeStoreV1,
  authorityComponent: AuthorityRepoComponent,
  events: string[]
) {
  return new ProductionProgressAppendOperationHost({
    ...axes(),
    runtime: runtime(events),
    authorityComponent,
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: store,
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    newOuterOpId: () => "outer-progress-operation"
  });
}

function authorityComponent(
  events: string[],
  expectedRecovery?: {
    readonly outerOpId: string;
    readonly outerRequestDigest: string;
  }
): AuthorityRepoComponent {
  const bindConnection = (): AuthorityRepoConnectionBinding => ({
    submit: async () => { throw new Error("unplanned authority submit"); },
    planProgressAppend: async (expected) => {
      events.push("plan-fixed-attempt");
      return plan(expected);
    },
    plannedProgressAppendSubmission: ({ expected, plan: fixed, recovery }) => ({
      submit: async (actual) => {
        assert.deepEqual(actual, expected);
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
    })
  });
  return {
    commandSubmissionV2: { submit: async () => { throw new Error("unbound"); } },
    cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
    bindConnection,
    stop: async () => undefined
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
            canonicalRef: taskId
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

function axes() {
  return {
    repoId: "canonical",
    workspaceId: "workspace-production",
    generation: 2
  } as const;
}
