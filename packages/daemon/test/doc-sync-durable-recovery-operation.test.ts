// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  ProductionProgressAppendOperationHost,
  ReceiptSettlementStore,
  encodeRepoWriteCommand,
  type AuthorityRepoComponent,
  type HarnessDaemonRuntime,
  type RepoWriteDocSyncExecution
} from "../src/index.ts";
import { cliDaemonCommandHostServices } from "../../cli/src/composition/daemon-command-host-services.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";

const recoveryTest = process.platform === "win32" ? test.skip : test;

recoveryTest("doc-sync restart recovers from durable PROCEEDING after a post-session-commit crash", async () => {
  const outcomeDirectory = mkdtempSync(path.join(os.tmpdir(), "ha-doc-sync-durable-recovery-"));
  const events: string[] = [];
  try {
    const actor = productionAuthorityActor();
    const request = {
      repo: { repoId: axes().repoId },
      session: {
        sessionId: "session-doc-sync-recovery",
        runtime: "codex" as const,
        source: "manual" as const,
        detectedAt: "2026-07-24T00:00:00.000Z"
      },
      payload: {
        baseLedgerSha: "a".repeat(40),
        intentId: "intent-doc-sync-recovery",
        declaredIntent: "prose-edit" as const,
        changes: [{
          path: "tasks/task_A/INDEX.md",
          baseBlobSha256: null,
          newBlobSha256: "b".repeat(64),
          mediaType: "text/markdown",
          size: 6,
          content: { kind: "inline" as const, body: "after\n" }
        }]
      }
    };
    const command = encodeRepoWriteCommand({
      command: { rootDir: "/repo", action: { kind: "doc-sync-submit" }, request },
      context: {
        actor,
        authorityConnection: productionAuthorityConnection(actor),
        currentSession: {
          runtime: "codex",
          sessionId: "session-doc-sync-recovery",
          source: "manual",
          detectedAt: "2026-07-24T00:00:00.000Z"
        },
        executor: { kind: "agent", id: "codex" }
      }
    });
    const store = new DurableRepoWriteOutcomeStoreV1({ directory: outcomeDirectory, ...axes() });
    const crashing = operationHost(
      store,
      events,
      outcomeDirectory,
      async () => {
        events.push("doc-sync-session-fsynced");
        throw new Error("simulated child crash after session fsync");
      }
    );
    const prepared = await crashing.prepare({
      repoId: axes().repoId,
      generation: axes().generation,
      requestId: "request-doc-sync-crash",
      command
    });
    await assert.rejects(prepared.execute(), /simulated child crash/u);
    assert.equal(store.lookup(prepared.opId).state, "proceeding");

    const recovered = operationHost(
      store,
      events,
      outcomeDirectory,
      async () => docSyncAcceptedExecution()
    );
    const lookup = await recovered.lookup({ opId: prepared.opId });

    assert.equal(lookup.state, "accepted");
    if (lookup.state !== "accepted") return;
    assert.equal(lookup.receipt.settlement?.canonicalVisibility, "pending");
    assert.equal(lookup.receipt.settlement?.receiptId, prepared.opId);
    assert.deepEqual(events, ["doc-sync-session-fsynced"]);
  } finally {
    rmSync(outcomeDirectory, { recursive: true, force: true });
  }
});

function docSyncAcceptedExecution(): RepoWriteDocSyncExecution {
  return {
    receipt: {
      ok: true,
      schema: "command-receipt/v2",
      command: "repo.doc.sync.submit",
      action: "submit",
      summary: "accepted repo.doc.sync.submit",
      next: [],
      details: {
        data: {
          ok: true,
          schema: "daemon.doc-sync-submit-result/v1",
          status: "accepted",
          intentId: "intent-doc-sync-recovery",
          baseLedgerSha: "a".repeat(40),
          appliedLedgerSha: "b".repeat(40),
          appliedChanges: [{ path: "tasks/task_A/INDEX.md" }]
        }
      },
      meta: {
        generatedAt: "2026-07-24T00:00:00.000Z",
        compatibility: { legacyReceipt: "CommandReceipt/v1" }
      }
    },
    durable: {
      sessionId: "session-doc-sync-recovery",
      acceptedCommitSha: "b".repeat(40),
      previousCommitSha: "a".repeat(40),
      flush: {
        reason: "explicit",
        opCount: 1,
        committed: true,
        watermark: "intent-doc-sync-recovery"
      },
      settle: () => new Promise<string>(() => undefined)
    }
  };
}

function operationHost(
  store: DurableRepoWriteOutcomeStoreV1,
  events: string[],
  outcomeDirectory: string,
  executeDocSyncSubmit: () => Promise<RepoWriteDocSyncExecution>
) {
  return new ProductionProgressAppendOperationHost({
    ...axes(),
    runtime: {} as HarnessDaemonRuntime,
    authorityComponent: {
      commandSubmissionV2: {} as AuthorityRepoComponent["commandSubmissionV2"],
      cutoverControl: {} as AuthorityRepoComponent["cutoverControl"],
      bindConnection: () => ({} as ReturnType<AuthorityRepoComponent["bindConnection"]>),
      stop: async () => undefined
    },
    hostServices: cliDaemonCommandHostServices,
    outcomeStore: store,
    settlementStore: new ReceiptSettlementStore({
      directory: path.join(outcomeDirectory, "settlements"),
      ...axes()
    }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    newOuterOpId: () => "outer-progress-operation",
    executeDocSyncSubmit: async () => {
      void events;
      return executeDocSyncSubmit();
    }
  });
}

function axes() {
  return {
    repoId: "canonical",
    workspaceId: "workspace-production",
    generation: 2
  } as const;
}
