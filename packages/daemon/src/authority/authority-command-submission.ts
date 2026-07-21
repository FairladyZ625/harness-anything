import { Effect } from "effect";
import {
  decodeSemanticMutationEnvelopeV2,
  isCompleteAuthorityCommittedReceiptV2,
  operationIdDiagnosticV2,
  semanticRequestDigestV2,
  type AuthorityOperationReceipt,
  type AuthorityHostAttribution,
  type AuthorityHostCommand,
  type AuthorityIngressAdapter,
  type AuthoritySubmissionService,
  type AuthorizedOperationAttemptV2
} from "@harness-anything/application";
import type {
  CurrentSessionRef,
  FlushReason,
  FlushReport,
  RecoveryReport,
  WriteCoordinator,
  WriteError,
  WriteOp
} from "@harness-anything/kernel";
import { taskEntityId } from "@harness-anything/kernel";

export interface DaemonAuthorityAttemptCompilerV2 {
  /**
   * Compiles a server-observed parsed command into canonical typed semantic
   * intent. Raw WriteOps are deliberately absent from this boundary.
   */
  readonly compile: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly canonicalEntityId: WriteOp["entityId"];
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileProvenanceSession?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileDecisionTransition?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileTaskClaim?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileObservedWrite?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
  readonly compileScriptIngest?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorizedOperationAttemptV2>;
}

export interface DaemonAuthorityCommandSubmissionV2 {
  readonly submit: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly canonicalEntityId: WriteOp["entityId"];
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitProvenanceSession?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitDecisionTransition?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitTaskClaim?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitObservedWrite?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly operation: WriteOp;
  }) => Promise<AuthorityOperationReceipt>;
  readonly submitScriptIngest?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
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
  const compileAttempt = async (compile: () => Promise<AuthorizedOperationAttemptV2>) => {
    try {
      return await compile();
    } catch (cause) {
      throw authorityWriteRejected(
        cause instanceof Error ? cause.message : String(cause),
        false,
        "authority_ingress_rejected"
      );
    }
  };
  return {
    submit: async (input) => submitAttempt(await compileAttempt(() => options.attemptCompiler.compile(input))),
    ...(options.attemptCompiler.compileProvenanceSession ? {
      submitProvenanceSession: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileProvenanceSession"]>>[0]) =>
        submitAttempt(await compileAttempt(() => options.attemptCompiler.compileProvenanceSession!(input)))
    } : {}),
    ...(options.attemptCompiler.compileDecisionTransition ? {
      submitDecisionTransition: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileDecisionTransition"]>>[0]) =>
        submitAttempt(await compileAttempt(() => options.attemptCompiler.compileDecisionTransition!(input)))
    } : {}),
    ...(options.attemptCompiler.compileTaskClaim ? {
      submitTaskClaim: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileTaskClaim"]>>[0]) =>
        submitAttempt(await compileAttempt(() => options.attemptCompiler.compileTaskClaim!(input)))
    } : {}),
    ...(options.attemptCompiler.compileObservedWrite ? {
      submitObservedWrite: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileObservedWrite"]>>[0]) =>
        submitAttempt(await compileAttempt(() => options.attemptCompiler.compileObservedWrite!(input)))
    } : {}),
    ...(options.attemptCompiler.compileScriptIngest ? {
      submitScriptIngest: async (input: Parameters<NonNullable<DaemonAuthorityAttemptCompilerV2["compileScriptIngest"]>>[0]) =>
        submitAttempt(await compileAttempt(() => options.attemptCompiler.compileScriptIngest!(input)))
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
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly ingressAdapter?: AuthorityIngressAdapter;
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
        const provenanceSession = isProvenanceSessionOperation(input, pending);
        if (provenanceSession && provenanceCommitted) {
          throw authorityWriteRejected("AUTHORITY_COMMAND_REQUIRES_SINGLE_PROVENANCE_SESSION");
        }
        if (provenanceSession && !submission.submitProvenanceSession) {
          throw authorityWriteRejected("AUTHORITY_PROVENANCE_SESSION_SUBMISSION_UNAVAILABLE");
        }
        const ingressAdapter = input.ingressAdapter;
        const decisionTransition = ingressAdapter === "decision-transition";
        if (decisionTransition && !submission.submitDecisionTransition) {
          throw authorityWriteRejected("AUTHORITY_DECISION_TRANSITION_SUBMISSION_UNAVAILABLE");
        }
        const taskClaim = ingressAdapter === "task-claim";
        if (taskClaim && !submission.submitTaskClaim) {
          throw authorityWriteRejected("AUTHORITY_TASK_CLAIM_SUBMISSION_UNAVAILABLE");
        }
        const observedWrite = ingressAdapter === "observed-write";
        if (observedWrite && !submission.submitObservedWrite) {
          throw authorityWriteRejected("AUTHORITY_OBSERVED_WRITE_SUBMISSION_UNAVAILABLE");
        }
        const scriptIngest = pending.kind === "script_ingest";
        if (scriptIngest && !submission.submitScriptIngest) {
          throw authorityWriteRejected("AUTHORITY_SCRIPT_SCOPE_SUBMISSION_UNAVAILABLE");
        }
        settled ??= scriptIngest
          ? submission.submitScriptIngest!({ ...input, operation: pending })
          : provenanceSession
          ? submission.submitProvenanceSession!({ ...input, operation: pending })
          : decisionTransition
            ? submission.submitDecisionTransition!({ ...input, operation: pending })
          : taskClaim
            ? submission.submitTaskClaim!({ ...input, operation: pending })
          : observedWrite
            ? submission.submitObservedWrite!({ ...input, operation: pending })
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

function isAuthorityCoveredTaskTreeStage(command: AuthorityHostCommand, operation: WriteOp): boolean {
  return command.action.kind === "task-complete" && operation.kind === "task_tree_stage";
}

function authorityCommandCoversLocalWritePhases(command: AuthorityHostCommand): boolean {
  const action = command.action;
  return action.kind === "status-set"
    || action.kind === "task-complete"
    || (action.kind === "task-review-execution" && action.verdict === "approved");
}

function isProvenanceSessionOperation(
  input: { readonly command: AuthorityHostCommand; readonly currentSession: CurrentSessionRef },
  operation: WriteOp
): boolean {
  const action = input.command.action;
  const sessionId = action.kind === "session-export"
    ? action.sessionId ?? input.currentSession.sessionId
    : input.currentSession.sessionId;
  return (
    action.kind === "new-task"
    || action.kind === "session-export"
    || (action.kind === "status-set" && Boolean(action.executionSubmission))
  ) && operation.entityId === `entity/session/${sessionId}`;
}

function commandMainEntityId(command: AuthorityHostCommand): WriteOp["entityId"] | undefined {
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

export function receiptToFlushReport(receipt: AuthorityOperationReceipt, reason: FlushReason): FlushReport {
  switch (receipt.tag) {
    case "COMMITTED": return { reason, opCount: 1, committed: true, watermark: receipt.opId };
    case "REJECTED": throw authorityWriteRejected(receipt.reason, false, "authority_ingress_rejected");
    case "RETRYABLE_NOT_COMMITTED": throw authorityWriteRejected(
      receipt.reason,
      true,
      receipt.errorCode,
      receipt.errorContext ? { ...receipt.errorContext } : undefined
    );
    case "INDETERMINATE": {
      if (receipt.errorCode) throw authorityWriteRejected(
        receipt.reason,
        false,
        receipt.errorCode,
        receipt.errorContext ? { ...receipt.errorContext } : undefined
      );
      throw new Error(`AUTHORITY_INDETERMINATE:${receipt.reason}`);
    }
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

function authorityWriteRejected(
  reason: string,
  retryable = false,
  code?: string,
  context?: Readonly<Record<string, unknown>>
): WriteError {
  return {
    _tag: "WriteRejected",
    reason,
    ...(code ? { code } : {}),
    ...(context ? { context } : {}),
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
