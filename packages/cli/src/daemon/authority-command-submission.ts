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
import { taskEntityId } from "../../../kernel/src/index.ts";
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
  readonly compileProvenanceSession?: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileDecisionTransition?: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
}

export interface DaemonAuthorityCommandSubmissionV2 {
  readonly submit: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly canonicalEntityId: WriteOp["entityId"];
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitProvenanceSession?: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitDecisionTransition?: (input: {
    readonly command: ParsedCommand;
    readonly attribution: CliActorAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
}

export function createDaemonAuthorityCommandSubmissionV2(options: {
  readonly authorityService: AuthoritySubmissionService;
  readonly attemptCompiler: DaemonAuthorityAttemptCompilerV2;
}): DaemonAuthorityCommandSubmissionV2 {
  if (!options.authorityService.submitV2) throw new Error("DAEMON_AUTHORITY_V2_NOT_NEGOTIATED");
  const submitAttempt = async (attempt: AuthorizedOperationAttemptV2): Promise<AuthorityOperationReceipt> => {
    const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
    const expectedOpId = operationIdDiagnosticV2(envelope.operationId);
    const receipt = await options.authorityService.submitV2!(attempt);
    assertCompleteAuthorityReceiptV2(receipt);
    assertAuthorityReceiptOperation(receipt, expectedOpId);
    return receipt;
  };
  return {
    submit: async (input) => submitAttempt(await options.attemptCompiler.compile(input)),
    ...(options.attemptCompiler.compileProvenanceSession ? {
      submitProvenanceSession: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileProvenanceSession"]>>[0]) =>
        submitAttempt(await options.attemptCompiler.compileProvenanceSession!(input))
    } : {}),
    ...(options.attemptCompiler.compileDecisionTransition ? {
      submitDecisionTransition: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileDecisionTransition"]>>[0]) =>
        submitAttempt(await options.attemptCompiler.compileDecisionTransition!(input))
    } : {})
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
  let pending: WriteOp | undefined;
  let settled: Promise<AuthorityOperationReceipt> | undefined;
  let provenanceCommitted = false;
  let mainCommitted = false;
  let coveredByMainSubmission = false;
  let mainWatermark: string | undefined;

  return {
    enqueue: (operation) => isAuthorityCoveredTaskTreeStage(input.command, operation)
      ? Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const })
      : pending && authorityCommandCoversLocalWritePhases(input.command)
      ? Effect.succeed({ opId: operation.opId, entityId: operation.entityId, accepted: true as const })
      : pending || (mainCommitted && !authorityCommandCoversLocalWritePhases(input.command))
        ? Effect.fail(authorityWriteRejected("AUTHORITY_COMMAND_REQUIRES_SINGLE_CANONICAL_OPERATION"))
        : Effect.sync(() => {
        pending = operation;
        coveredByMainSubmission = mainCommitted;
        return { opId: operation.opId, entityId: operation.entityId, accepted: true as const };
      }),
    flush: (reason) => Effect.tryPromise({
      try: async (): Promise<FlushReport> => {
        if (!pending) return { reason, opCount: 0, committed: false };
        if (coveredByMainSubmission) {
          pending = undefined;
          coveredByMainSubmission = false;
          return { reason, opCount: 1, committed: true, ...(mainWatermark ? { watermark: mainWatermark } : {}) };
        }
        const provenanceSession = isCreateProvenanceSessionOperation(input, pending);
        if (provenanceSession && provenanceCommitted) {
          throw authorityWriteRejected("AUTHORITY_COMMAND_REQUIRES_SINGLE_PROVENANCE_SESSION");
        }
        if (provenanceSession && !submission.submitProvenanceSession) {
          throw authorityWriteRejected("AUTHORITY_PROVENANCE_SESSION_SUBMISSION_UNAVAILABLE");
        }
        const decisionTransition = input.command.action.kind === "decision-transition";
        if (decisionTransition && !submission.submitDecisionTransition) {
          throw authorityWriteRejected("AUTHORITY_DECISION_TRANSITION_SUBMISSION_UNAVAILABLE");
        }
        settled ??= provenanceSession
          ? submission.submitProvenanceSession!({ ...input, operation: pending })
          : decisionTransition
            ? submission.submitDecisionTransition!({ ...input, operation: pending })
          : submission.submit({
            ...input,
            canonicalEntityId: commandMainEntityId(input.command) ?? pending.entityId
          });
        const receipt = await settled;
        const report = receiptToFlushReport(receipt, reason);
        pending = undefined;
        settled = undefined;
        if (provenanceSession) provenanceCommitted = true;
        else {
          mainCommitted = true;
          mainWatermark = receipt.opId;
        }
        return report;
      },
      catch: authoritySubmissionWriteError
    }),
    recover: Effect.succeed({ replayedOps: 0 } satisfies RecoveryReport)
  };
}

function isAuthorityCoveredTaskTreeStage(command: ParsedCommand, operation: WriteOp): boolean {
  return command.action.kind === "task-complete" && operation.kind === "task_tree_stage";
}

function authorityCommandCoversLocalWritePhases(command: ParsedCommand): boolean {
  const action = command.action;
  return action.kind === "status-set"
    || action.kind === "task-complete"
    || (action.kind === "task-review-execution" && action.verdict === "approved");
}

function isCreateProvenanceSessionOperation(
  input: { readonly command: ParsedCommand; readonly currentSession: CurrentSessionRef },
  operation: WriteOp
): boolean {
  return input.command.action.kind === "new-task"
    && operation.entityId === `entity/session/${input.currentSession.sessionId}`;
}

function commandMainEntityId(command: ParsedCommand): WriteOp["entityId"] | undefined {
  const action = command.action;
  if (action.kind === "new-task" && action.taskId) return taskEntityId(action.taskId);
  if (action.kind === "status-set" && action.executionSubmission?.executionId) {
    return `execution/${action.executionSubmission.executionId}`;
  }
  return undefined;
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
