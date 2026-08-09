// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  ReceiptSettlementStore,
  RepoWriteDurableOperationController,
  repoWriteActorStampDigestV1,
  type RepoWriteProceedingInputV1,
  type RepoWriteTerminalEvidenceV1
} from "../src/index.ts";
import {
  committedCommandReceipt,
  rejectedCommandReceipt
} from "./support/repo-write-terminal-fixture.ts";
import { repoWriteProgressCommand } from "./support/repo-write-command-fixture.ts";

const controllerTest = process.platform === "win32" ? test.skip : test;

controllerTest("fresh execution starts only after durable outer PROCEEDING", async () => {
  await withController(async ({ events, controller, proceeding }) => {
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => {
        events.push("activate-fresh-attempt");
        events.push("inner-received");
        return {
          receipt: committedCommandReceipt(),
          authorityEvidence: terminalEvidence(proceeding, "committed")
        };
      }
    });

    const terminal = await prepared.execute();

    assert.equal(terminal.phase, "TERMINAL");
    assert.deepEqual(events, [
      "outer-proceeding-fsynced",
      "activate-fresh-attempt",
      "inner-received",
      "outer-terminal-fsynced"
    ]);
  });
});

controllerTest("a crash after PROCEEDING resumes the fixed attempt without fresh activation", async () => {
  await withController(async ({ directory, events, controller, proceeding, options }) => {
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => {
        events.push("activate-fresh-attempt");
        throw new Error("injected child crash after outer PROCEEDING");
      }
    });
    await assert.rejects(prepared.execute(), /injected child crash/u);
    assert.equal(options.store.lookup(proceeding.outerOpId).state, "proceeding");

    events.length = 0;
    const restartedStore = new DurableRepoWriteOutcomeStoreV1({
      directory,
      ...axes(),
      __testOnlyDurabilityHooks: durabilityEvents(events)
    });
    const restarted = new RepoWriteDurableOperationController({
      ...axes(),
      store: restartedStore,
      settlements: settlementStore(directory),
      recover: async (durableProceeding) => {
        events.push(`resume-fixed-attempt:${durableProceeding.innerOpId}`);
        return {
          receipt: rejectedCommandReceipt(),
          authorityEvidence: terminalEvidence(durableProceeding, "rejected")
        };
      }
    });

    const terminal = await restarted.resume(proceeding.outerOpId);

    assert.equal(terminal.phase, "TERMINAL");
    assert.equal(terminal.terminalKind, "rejected");
    assert.deepEqual(events, [
      "resume-fixed-attempt:inner-outer-controller",
      "outer-terminal-fsynced"
    ]);
    assert.deepEqual(
      new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() })
        .lookup(proceeding.outerOpId),
      { state: "terminal", generation: "current", outcome: terminal }
    );
  });
});

controllerTest("duplicate execute and resume return the byte-stable terminal without replay", async () => {
  await withController(async ({ controller, proceeding }) => {
    let executions = 0;
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => {
        executions += 1;
        return {
          receipt: committedCommandReceipt(),
          authorityEvidence: terminalEvidence(proceeding, "committed")
        };
      }
    });

    const first = await prepared.execute();
    const duplicate = await prepared.execute();
    const resumed = await controller.resume(proceeding.outerOpId);

    assert.equal(executions, 1);
    assert.deepEqual(duplicate, first);
    assert.deepEqual(resumed, first);
    assert.equal(JSON.stringify(resumed.receipt), JSON.stringify(first.receipt));
  });
});

controllerTest("accepted returns before settlement and later exposes canonical visibility", async () => {
  await withController(async ({ controller, proceeding, options }) => {
    let settle!: (evidence: RepoWriteTerminalEvidenceV1) => void;
    const settlement = new Promise<RepoWriteTerminalEvidenceV1>((resolve) => {
      settle = resolve;
    });
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => ({
        kind: "accepted" as const,
        receipt: committedCommandReceipt(),
        acceptance: {
          sessionId: "session-controller",
          acceptedCommitSha: "b".repeat(40),
          flush: {
            reason: "explicit",
            opCount: 1,
            committed: true,
            watermark: proceeding.innerOpId
          }
        },
        acceptedCommitSha: "b".repeat(40),
        settlement
      })
    });

    const accepted = await prepared.execute();
    assert.equal("kind" in accepted ? accepted.kind : undefined, "accepted");
    assert.equal(options.store.lookup(proceeding.outerOpId).state, "proceeding");
    assert.equal(
      options.settlements.lookup(proceeding.outerOpId)?.receipt.settlement?.canonicalVisibility,
      "pending"
    );

    settle(terminalEvidence(proceeding, "committed"));
    await eventually(() => options.store.lookup(proceeding.outerOpId).state === "terminal");
    assert.equal(
      options.settlements.lookup(proceeding.outerOpId)?.receipt.settlement?.canonicalVisibility,
      "visible"
    );
  });
});

controllerTest("failure receipt after partial durable admission remains accepted and queryable", async () => {
  await withController(async ({ controller, proceeding, options }) => {
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => ({
        kind: "accepted" as const,
        receipt: rejectedCommandReceipt(),
        acceptance: {
          sessionId: "session-partial-failure",
          acceptedCommitSha: "b".repeat(40),
          flush: {
            reason: "explicit",
            opCount: 1,
            committed: true,
            watermark: proceeding.innerOpId
          }
        },
        acceptedCommitSha: "b".repeat(40),
        settlement: new Promise<RepoWriteTerminalEvidenceV1>(() => undefined)
      })
    });

    const accepted = await prepared.execute();

    assert.equal("kind" in accepted ? accepted.kind : undefined, "accepted");
    assert.equal("kind" in accepted && accepted.kind === "accepted" ? accepted.receipt.ok : true, false);
    assert.equal(options.settlements.lookup(proceeding.outerOpId)?.state, "pending");
  });
});

controllerTest("visible sidecar publish failure does not overwrite a terminal canonical truth with failed", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-visible-sidecar-"));
  const store = new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() });
  const settlements = new ReceiptSettlementStore({
    directory: path.join(directory, "receipt-settlements"),
    ...axes(),
    __testOnlyDurabilityHooks: {
      beforePublishLink: ({ target }) => {
        if (target.endsWith(".visible.json")) throw new Error("injected visible sidecar failure");
      }
    }
  });
  const proceeding = proceedingInput();
  const controller = new RepoWriteDurableOperationController({
    ...axes(),
    store,
    settlements,
    recover: async () => assert.fail("recovery should not run")
  });
  try {
    const prepared = controller.prepare({
      proceeding,
      executeFresh: async () => ({
        kind: "accepted" as const,
        receipt: committedCommandReceipt(),
        acceptance: {
          sessionId: "session-sidecar-failure",
          acceptedCommitSha: "b".repeat(40),
          flush: {
            reason: "explicit",
            opCount: 1,
            committed: true,
            watermark: proceeding.innerOpId
          }
        },
        acceptedCommitSha: "b".repeat(40),
        settlement: Promise.resolve(terminalEvidence(proceeding, "committed"))
      })
    });

    await prepared.execute();
    await controller.settlementIdle();

    assert.equal(store.lookup(proceeding.outerOpId).state, "terminal");
    assert.equal(settlements.lookup(proceeding.outerOpId)?.state, "pending");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

controllerTest("replacement recovery completes an earlier PROCEEDING before a later append", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-order-"));
  const store = new DurableRepoWriteOutcomeStoreV1({
    directory,
    ...axes()
  });
  const first = proceedingInput();
  store.begin(first);
  const effects: string[] = [];
  let releaseRecovery: (() => void) | undefined;
  let observeRecovery: (() => void) | undefined;
  const recoveryStarted = new Promise<void>((resolve) => {
    observeRecovery = resolve;
  });
  const recoveryGate = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const controller = new RepoWriteDurableOperationController({
    ...axes(),
    store,
    settlements: settlementStore(directory),
    recover: async (proceeding) => {
      observeRecovery!();
      await recoveryGate;
      effects.push("A");
      return {
        receipt: committedCommandReceipt(),
        authorityEvidence: terminalEvidence(proceeding, "committed")
      };
    }
  });
  try {
    const recovering = controller.resume(first.outerOpId);
    await recoveryStarted;
    const second = {
      ...first,
      outerOpId: "outer-controller-B",
      innerOpId: "inner-controller-B",
      canonicalCommand: repoWriteProgressCommand(
        first.canonicalCommand.actor,
        first.canonicalCommand.context
      )
    };
    const prepared = controller.prepare({
      proceeding: second,
      executeFresh: async (proceeding) => {
        effects.push("B");
        return {
          receipt: committedCommandReceipt(),
          authorityEvidence: terminalEvidence(proceeding, "committed")
        };
      }
    });
    const later = prepared.execute();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseRecovery!();
    await Promise.all([recovering, later]);

    assert.deepEqual(effects, ["A", "B"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function withController(
  run: (fixture: {
    readonly directory: string;
    readonly events: string[];
    readonly proceeding: RepoWriteProceedingInputV1;
    readonly options: {
      readonly store: DurableRepoWriteOutcomeStoreV1;
      readonly settlements: ReceiptSettlementStore;
    };
    readonly controller: RepoWriteDurableOperationController;
  }) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-controller-"));
  const events: string[] = [];
  const store = new DurableRepoWriteOutcomeStoreV1({
    directory,
    ...axes(),
    __testOnlyDurabilityHooks: durabilityEvents(events)
  });
  const proceeding = proceedingInput();
  const settlements = settlementStore(directory);
  const controller = new RepoWriteDurableOperationController({
    ...axes(),
    store,
    settlements,
    recover: async (durableProceeding) => ({
      receipt: committedCommandReceipt(),
      authorityEvidence: terminalEvidence(durableProceeding, "committed")
    })
  });
  try {
    await run({ directory, events, proceeding, options: { store, settlements }, controller });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true");
}

function settlementStore(directory: string): ReceiptSettlementStore {
  return new ReceiptSettlementStore({
    directory: path.join(directory, "receipt-settlements"),
    ...axes()
  });
}

function durabilityEvents(events: string[]) {
  let publishing = "";
  return {
    beforePublishLink: ({ target }: { readonly target: string }) => {
      publishing = target;
    },
    afterDirectoryFsync: (reason: string) => {
      if (reason !== "publish") return;
      if (publishing.endsWith(".proceeding.json")) events.push("outer-proceeding-fsynced");
      if (publishing.endsWith(".terminal.json")) events.push("outer-terminal-fsynced");
      publishing = "";
    }
  };
}

function axes() {
  return {
    repoId: "repo-controller",
    workspaceId: "workspace-controller",
    generation: 7
  } as const;
}

function proceedingInput(): RepoWriteProceedingInputV1 {
  const actor = {
    personId: "person_zeyu",
    displayName: "Zeyu Li",
    providerId: "local-socket",
    credential: {
      kind: "unix-socket-owner-boundary",
      issuer: "local-daemon",
      subject: "person_zeyu"
    }
  } as const;
  return {
    ...axes(),
    outerOpId: "outer-controller",
    innerOpId: "inner-outer-controller",
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: repoWriteProgressCommand(actor),
    authenticatedContext: { actor },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-23T12:00:00.000Z",
      command: "progress append",
      action: "append",
      actorStampDigest: repoWriteActorStampDigestV1(actor)
    },
    recoveryContext: { attempt: "fixed-signed-attempt" }
  };
}

function terminalEvidence(
  proceeding: RepoWriteProceedingInputV1,
  disposition: "committed" | "rejected"
): RepoWriteTerminalEvidenceV1 {
  if (disposition === "rejected") {
    return {
      tag: "REJECTED",
      workspaceId: proceeding.workspaceId,
      opId: proceeding.innerOpId,
      semanticDigest: proceeding.authoritySemanticDigest,
      reason: "known durable rejection"
    };
  }
  return {
    tag: "COMMITTED",
    workspaceId: proceeding.workspaceId,
    opId: proceeding.innerOpId,
    semanticDigest: proceeding.authoritySemanticDigest,
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: proceeding.authoritySemanticDigest,
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  };
}
