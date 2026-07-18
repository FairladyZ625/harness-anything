import { Effect } from "effect";
import {
  decodeSemanticMutationEnvelopeV2,
  isCompleteAuthorityCommittedReceiptV2,
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  type AuthorityOperationReceipt,
  type AuthoritySubmissionService,
  type AuthorizedOperationAttemptV2
} from "../../../application/src/index.ts";
import type {
  CurrentSessionRef,
  FlushReason,
  FlushReport,
  RecoveryReport,
  WriteCoordinator,
  WriteError,
  WriteOp
} from "../../../kernel/src/index.ts";
import type { ParsedCommand } from "../cli/types.ts";
import type { CliActorAttribution } from "../composition/actor-attribution.ts";

export interface DaemonAuthorityAttemptCompilerV2 {
  /**
   * Compiles a server-observed parsed command into canonical typed semantic
   * intent. Raw WriteOps are deliberately absent from this boundary.
   */
  readonly compile: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly canonicalEntityId: WriteOp["entityId"];
  }) => Promise<AuthorizedOperationAttemptV2>;
}

export interface DaemonAuthorityCommandSubmissionV2 {
  readonly submit: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly canonicalEntityId: WriteOp["entityId"];
  }) => Promise<AuthorityOperationReceipt>;
}

export function createDaemonAuthorityCommandSubmissionV2(options: {
  readonly authorityService: AuthoritySubmissionService;
  readonly attemptCompiler: DaemonAuthorityAttemptCompilerV2;
}): DaemonAuthorityCommandSubmissionV2 {
  if (!options.authorityService.submitV2) throw new Error("DAEMON_AUTHORITY_V2_NOT_NEGOTIATED");
  return {
    submit: async (input) => {
      const attempt = await options.attemptCompiler.compile(input);
      const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
      const expectedOpId = operationIdDiagnosticV2(envelope.operationId);
      const receipt = await options.authorityService.submitV2!(attempt);
      assertCompleteAuthorityReceiptV2(receipt);
      assertAuthorityReceiptOperation(receipt, expectedOpId);
      return receipt;
    }
  };
}

export function gateAuthoritySubmissionForRecovery(
  service: AuthoritySubmissionService,
  unavailableReason: () => string | undefined
): AuthoritySubmissionService {
  return {
    getOperation: service.getOperation,
    submit: async (envelope) => {
      const reason = unavailableReason();
      return reason
        ? {
          tag: "RETRYABLE_NOT_COMMITTED",
          workspaceId: envelope.workspaceId,
          opId: envelope.opId,
          semanticDigest: envelope.claimedDigest,
          reason
        }
        : service.submit(envelope);
    },
    ...(service.submitV2 ? {
      submitV2: async (attempt) => {
        const reason = unavailableReason();
        if (!reason) return service.submitV2!(attempt);
        const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
        return {
          tag: "RETRYABLE_NOT_COMMITTED",
          workspaceId: envelope.workspaceId,
          opId: operationIdDiagnosticV2(envelope.operationId),
          semanticDigest: Buffer.from(semanticRequestDigestV2(envelope)).toString("hex"),
          reason
        };
      }
    } : {})
  };
}

export function makeDaemonAuthorityWriteCoordinator(
  submission: DaemonAuthorityCommandSubmissionV2,
  input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
  }
): WriteCoordinator {
  let accepted: WriteOp["entityId"] | undefined;
  let settled: Promise<AuthorityOperationReceipt> | undefined;

  return {
    enqueue: (operation) => accepted
      ? Effect.fail(authorityWriteRejected("AUTHORITY_COMMAND_REQUIRES_SINGLE_CANONICAL_OPERATION"))
      : Effect.sync(() => {
        accepted = operation.entityId;
        return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
      }),
    flush: (reason) => Effect.tryPromise({
      try: async (): Promise<FlushReport> => {
        if (!accepted) return { reason, opCount: 0, committed: false };
        settled ??= submission.submit({ ...input, canonicalEntityId: accepted });
        const receipt = await settled;
        return receiptToFlushReport(receipt, reason);
      },
      catch: authoritySubmissionWriteError
    }),
    recover: Effect.succeed({ replayedOps: 0 } satisfies RecoveryReport)
  };
}

export class AuthorityProtocolDamagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityProtocolDamagedError";
  }
}

export function assertCompleteAuthorityReceiptV2(receipt: AuthorityOperationReceipt): void {
  if (receipt.tag !== "COMMITTED") return;
  if (!isCompleteAuthorityCommittedReceiptV2(receipt)) {
    throw new AuthorityProtocolDamagedError("PROTOCOL_DAMAGED: V2 COMMITTED receipt lacks a complete integrity tuple");
  }
}

export function assertAuthorityReceiptOperation(
  receipt: AuthorityOperationReceipt,
  expectedOpId: string
): void {
  if (receipt.opId !== expectedOpId) {
    throw new AuthorityProtocolDamagedError("PROTOCOL_DAMAGED: authority receipt operation does not match the canonical command operation");
  }
}

function receiptToFlushReport(receipt: AuthorityOperationReceipt, reason: FlushReason): FlushReport {
  switch (receipt.tag) {
    case "COMMITTED": return { reason, opCount: 1, committed: true, watermark: receipt.opId };
    case "REJECTED": throw authorityWriteRejected(receipt.reason);
    case "RETRYABLE_NOT_COMMITTED": throw authorityWriteRejected(receipt.reason, true);
    case "INDETERMINATE": throw new Error(`AUTHORITY_INDETERMINATE:${receipt.reason}`);
  }
}

export function authoritySubmissionWriteError(cause: unknown): WriteError {
  if (isAuthorityWriteError(cause)) return cause;
  if (cause instanceof AuthorityProtocolDamagedError) {
    return authorityWriteRejected(cause.message, false, "PROTOCOL_DAMAGED");
  }
  return { _tag: "JournalUnavailable", cause: authorityJournalFailureCause(cause) };
}

function authorityJournalFailureCause(cause: unknown): unknown {
  if (!(cause instanceof Error)) return cause;
  const code = "code" in cause && (typeof cause.code === "string" || typeof cause.code === "number")
    ? cause.code
    : undefined;
  return {
    name: cause.name || "Error",
    message: cause.message,
    ...(code === undefined ? {} : { code })
  };
}

function authorityWriteRejected(reason: string, retryable = false, code?: string): WriteError {
  return {
    _tag: "WriteRejected",
    reason,
    ...(code ? { code } : {}),
    ...(retryable ? { retryable: true } : {})
  };
}

function isAuthorityWriteError(error: unknown): error is WriteError {
  return typeof error === "object" && error !== null && "_tag" in error && [
    "WriteRejected",
    "WriteConflict",
    "GlobalWriteConflict",
    "JournalUnavailable"
  ].includes(String(error._tag));
}
