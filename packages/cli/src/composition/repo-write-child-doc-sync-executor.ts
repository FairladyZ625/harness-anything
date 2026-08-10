import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { Effect } from "effect";
import type {
  DocSyncSubmitRequestV1,
  DocSyncSubmitResultV1
} from "@harness-anything/application";
import {
  failureReceipt,
  makeDaemonQueuedWriteCoordinator,
  makeDocSyncService,
  materializeDocSyncWriterWorkingTree,
  type HarnessDaemonRuntime,
  type RepoWriteCommandContext,
  type RepoWriteDocSyncExecution
} from "@harness-anything/daemon";
import {
  isIndeterminateFlushReport,
  resolveHarnessLayout,
  type FlushReport,
  type WriteCoordinator
} from "@harness-anything/kernel";
import { daemonActorAttribution } from "./actor-attribution.ts";
import { cliDaemonServiceHostServices } from "./daemon-service-host-services.ts";
import { buildDocSyncCommandReceipt } from "./doc-sync-command-receipt.ts";
import { canonicalCommitContaining } from "./receipt-settlement-runtime.ts";

export function createRepoWriteChildDocSyncExecutor(input: {
  readonly canonicalRoot: string;
  readonly layoutOverrides?: { readonly authoredRoot: string };
  readonly runtime: HarnessDaemonRuntime;
}) {
  return async ({ command, decoded }: {
    readonly command: { readonly payload: { readonly command?: unknown } };
    readonly decoded: RepoWriteCommandContext;
  }): Promise<RepoWriteDocSyncExecution> => {
    const wireCommand = command.payload.command as {
      readonly request?: DocSyncSubmitRequestV1;
    };
    if (!wireCommand.request) {
      return { receipt: failureReceipt(
        "repo.doc.sync.submit",
        "doc_sync_invalid_payload",
        "The writer child received no doc-sync request."
      ) };
    }
    const materialized = materializeDocSyncWriterWorkingTree(
      {
        rootDir: input.canonicalRoot,
        ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
      },
      wireCommand.request
    );
    if (!materialized.ok) {
      const result: DocSyncSubmitResultV1 = {
        ok: false,
        _tag: "WriteRejected",
        schema: "daemon.doc-sync-submit-result/v1",
        status: "rejected",
        intentId: wireCommand.request.payload.intentId,
        code: "doc_sync_invalid_payload",
        reason: `The writer child rejected a working-tree reference: ${materialized.reason}`,
        retryable: false
      };
      return { receipt: failureReceipt(
        "repo.doc.sync.submit",
        result.code,
        result.reason,
        { data: result as unknown as import("@harness-anything/daemon").JsonObject }
      ) };
    }
    const attribution = daemonActorAttribution(decoded.actor, decoded.executor);
    const queued = makeDaemonQueuedWriteCoordinator(
      input.runtime,
      `doc-sync-submit:${wireCommand.request.payload.intentId}`,
      {
        attribution: attribution.writeAttribution,
        commitAuthor: attribution.commitAuthor,
        ...(wireCommand.request.session?.sessionId
          ? { sessionId: wireCommand.request.session.sessionId }
          : {})
      }
    );
    let durableFlush: FlushReport | undefined;
    const coordinator: WriteCoordinator = {
      enqueue: queued.enqueue,
      flush: (reason) => Effect.tap(queued.flush(reason), (flush) => Effect.sync(() => {
        durableFlush = flush;
      })),
      recover: queued.recover
    };
    const result = await makeDocSyncService({
      rootDir: input.canonicalRoot,
      ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {}),
      hostServices: cliDaemonServiceHostServices.docSync,
      coordinator
    }).submit(materialized.request);
    if (!result.ok) {
      return { receipt: failureReceipt("repo.doc.sync.submit", result.code, result.reason, {
        data: result as unknown as import("@harness-anything/daemon").JsonObject
      }) };
    }
    const receipt = buildDocSyncCommandReceipt({
      result,
      sessionId: decoded.currentSession.sessionId,
      acceptedAt: new Date().toISOString(),
      includeSettlement: false
    });
    if (result.appliedChanges.length === 0) {
      return {
        receipt,
        terminalCommitSha: result.appliedLedgerSha,
        terminalPreviousCommitSha: result.baseLedgerSha
      };
    }
    if (!durableFlush || isIndeterminateFlushReport(durableFlush)
      || !durableFlush.committed || !durableFlush.watermark) {
      throw new Error("DOC_SYNC_DURABLE_FLUSH_PROOF_MISSING");
    }
    const authoredRoot = resolveHarnessLayout({
      rootDir: input.canonicalRoot,
      ...(input.layoutOverrides ? { layoutOverrides: input.layoutOverrides } : {})
    }).authoredRoot;
    return {
      receipt,
      durable: {
        sessionId: decoded.currentSession.sessionId,
        acceptedCommitSha: result.appliedLedgerSha,
        previousCommitSha: result.baseLedgerSha,
        flush: { ...durableFlush, committed: true, watermark: durableFlush.watermark },
        settle: async () => {
          await nextEventLoopTurn();
          await input.runtime.enqueueMaterializerBatch({
            sessionId: decoded.currentSession.sessionId
          });
          return canonicalCommitContaining(authoredRoot, result.appliedLedgerSha);
        }
      }
    };
  };
}
