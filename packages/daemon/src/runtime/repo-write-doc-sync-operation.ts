import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { stablePayloadHash, type FlushReport } from "@harness-anything/kernel";
import type { AuthorityRepoComponent } from "../authority/authority-lifecycle.ts";
import type { RepoWritePrepareInput, RepoWritePreparedOperation } from "./repo-write-child-host.ts";
import type {
  RepoWriteDurableExecutionResult,
  RepoWriteDurableOperationController
} from "./repo-write-durable-operation-controller.ts";
import type { RepoWriteCommandDto, RepoWriteJsonObject } from "./repo-write-protocol.ts";
import { decodeRepoWriteCommand } from "./repo-write-progress-command.ts";
import {
  createRepoWriteCanonicalPublicationEvidenceV1,
  repoWriteActorStampDigestV1,
  repoWriteCurrentCommandForExecution,
  repoWriteReceiptSeedSchema,
  type RepoWriteProceedingOutcomeV1
} from "./repo-write-outcome-schema.ts";
import { reportCurrentRepoWriteTelemetry } from "./repo-write-telemetry-context.ts";

export interface RepoWriteDocSyncExecution {
  readonly receipt: CommandReceiptEnvelope;
  /** Present only after a real session commit + fsync. */
  readonly durable?: {
    readonly sessionId: string;
    readonly acceptedCommitSha: string;
    readonly previousCommitSha: string;
    readonly flush: FlushReport & { readonly committed: true; readonly watermark: string };
    readonly settle: () => Promise<string>;
  };
  /** Canonical observation anchoring a mutation-free terminal result. */
  readonly terminalCommitSha?: string;
  readonly terminalPreviousCommitSha?: string;
}

export async function prepareRepoWriteDocSyncOperation(input: {
  readonly request: RepoWritePrepareInput;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly generation: number;
  readonly authorityComponent: AuthorityRepoComponent;
  readonly operations: RepoWriteDurableOperationController;
  readonly now: () => Date;
  readonly newOuterOpId: () => string;
  readonly execute: (proceeding: RepoWriteProceedingOutcomeV1) => Promise<RepoWriteDurableExecutionResult>;
}): Promise<RepoWritePreparedOperation> {
  const decoded = decodeRepoWriteCommand(input.request.command);
  input.authorityComponent.bindConnection(decoded.authorityConnection);
  const request = docSyncRequestRecord(input.request.command);
  const intentId = docSyncIntentId(request);
  const proceeding = {
    repoId: input.repoId,
    workspaceId: input.workspaceId,
    generation: input.generation,
    outerOpId: input.newOuterOpId(),
    innerOpId: intentId,
    authoritySemanticDigest: stablePayloadHash({
      schema: "repo-write-doc-sync-semantic/v1",
      request
    }),
    canonicalCommand: input.request.command,
    authenticatedContext: { actor: input.request.command.actor },
    receiptSeed: {
      schema: repoWriteReceiptSeedSchema,
      renderer: "cli-command-receipt/v2@1" as const,
      generatedAt: input.now().toISOString(),
      command: "repo.doc.sync.submit",
      action: "submit",
      actorStampDigest: repoWriteActorStampDigestV1(input.request.command.actor)
    },
    recoveryContext: {
      schema: "repo-write-doc-sync-recovery/v1",
      intentId,
      baseLedgerSha: docSyncBaseLedgerSha(request)
    }
  };
  reportCurrentRepoWriteTelemetry("compile-outcome");
  return input.operations.prepare({
    proceeding,
    executeFresh: input.execute
  });
}

export async function executeRepoWriteDocSyncOperation(input: {
  readonly proceeding: RepoWriteProceedingOutcomeV1;
  readonly executeDocSyncSubmit?: (input: {
    readonly command: RepoWriteCommandDto;
    readonly decoded: ReturnType<typeof decodeRepoWriteCommand>;
  }) => Promise<RepoWriteDocSyncExecution | undefined>;
  readonly exactReceipt: (receipt: CommandReceiptEnvelope) => CommandReceiptEnvelope;
}): Promise<RepoWriteDurableExecutionResult> {
  if (!input.executeDocSyncSubmit) throw new Error("DOC_SYNC_DURABLE_EXECUTOR_UNAVAILABLE");
  const command = repoWriteCurrentCommandForExecution(input.proceeding.canonicalCommand);
  const execution = await input.executeDocSyncSubmit({
    command,
    decoded: decodeRepoWriteCommand(command)
  });
  if (!execution) throw new Error("DOC_SYNC_DURABLE_EXECUTION_MISSING");
  const receipt = input.exactReceipt(execution.receipt);
  if (execution.durable) {
    const durable = execution.durable;
    return {
      kind: "accepted",
      receipt,
      acceptance: {
        sessionId: durable.sessionId,
        acceptedCommitSha: durable.acceptedCommitSha,
        flush: durable.flush
      },
      acceptedCommitSha: durable.acceptedCommitSha,
      settlement: durable.settle().then((commitSha) =>
        createRepoWriteCanonicalPublicationEvidenceV1({
          workspaceId: input.proceeding.workspaceId,
          opId: input.proceeding.innerOpId,
          semanticDigest: input.proceeding.authoritySemanticDigest,
          revision: 0,
          commitSha,
          previousCommit: durable.previousCommitSha,
          acceptedCommitSha: durable.acceptedCommitSha
        }))
    };
  }
  if (receipt.ok && execution.terminalCommitSha) {
    return {
      kind: "terminal",
      receipt,
      authorityEvidence: createRepoWriteCanonicalPublicationEvidenceV1({
        workspaceId: input.proceeding.workspaceId,
        opId: input.proceeding.innerOpId,
        semanticDigest: input.proceeding.authoritySemanticDigest,
        revision: 0,
        commitSha: execution.terminalCommitSha,
        previousCommit: execution.terminalPreviousCommitSha ?? null,
        acceptedCommitSha: execution.terminalCommitSha
      })
    };
  }
  if (receipt.ok) throw new Error("DOC_SYNC_TERMINAL_SUCCESS_PROOF_MISSING");
  return {
    kind: "terminal",
    receipt,
    authorityEvidence: {
      tag: "REJECTED",
      workspaceId: input.proceeding.workspaceId,
      opId: input.proceeding.innerOpId,
      semanticDigest: input.proceeding.authoritySemanticDigest,
      reason: JSON.stringify(receipt.error ?? { code: "doc_sync_rejected" })
    }
  };
}

function docSyncRequestRecord(command: RepoWriteCommandDto): RepoWriteJsonObject {
  const wireCommand = command.payload.command;
  if (!wireCommand || typeof wireCommand !== "object" || Array.isArray(wireCommand)) {
    throw new Error("DOC_SYNC_COMMAND_PAYLOAD_REQUIRED");
  }
  const request = (wireCommand as unknown as RepoWriteJsonObject).request;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("DOC_SYNC_REQUEST_PAYLOAD_REQUIRED");
  }
  return request as RepoWriteJsonObject;
}

function docSyncIntentId(request: RepoWriteJsonObject): string {
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DOC_SYNC_REQUEST_PAYLOAD_REQUIRED");
  }
  const intentId = (payload as RepoWriteJsonObject).intentId;
  if (typeof intentId !== "string" || intentId.length === 0) {
    throw new Error("DOC_SYNC_INTENT_ID_REQUIRED");
  }
  return intentId;
}

function docSyncBaseLedgerSha(request: RepoWriteJsonObject): string {
  const payload = request.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("DOC_SYNC_REQUEST_PAYLOAD_REQUIRED");
  }
  const baseLedgerSha = (payload as RepoWriteJsonObject).baseLedgerSha;
  if (typeof baseLedgerSha !== "string" || baseLedgerSha.length === 0) {
    throw new Error("DOC_SYNC_BASE_LEDGER_SHA_REQUIRED");
  }
  return baseLedgerSha;
}
