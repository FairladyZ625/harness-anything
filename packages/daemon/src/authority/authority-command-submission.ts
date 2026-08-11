import { Effect } from "effect";
import {
  decodeSemanticMutationEnvelopeV2,
  isCompleteAuthorityCommittedReceiptV2,
  operationIdDiagnosticV2,
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
import { isIndeterminateFlushReport, taskEntityId } from "@harness-anything/kernel";
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";
import { reportCurrentRepoWriteTelemetry } from "../runtime/repo-write-telemetry-context.ts";
import {
  runWithAuthorityDurableAcceptance,
  type AuthorityDurableAcceptance
} from "../runtime/authority-durable-acceptance-context.ts";

interface DaemonAuthoritySubmissionInputBaseV2 {
  readonly command: AuthorityHostCommand;
  readonly attribution: AuthorityHostAttribution;
  readonly currentSession: CurrentSessionRef;
  readonly ingressAdapter?: AuthorityIngressAdapter;
}

export type DaemonAuthorityCommandSubmissionInputV2 =
  | (DaemonAuthoritySubmissionInputBaseV2 & {
      readonly ingress: "generic";
      readonly canonicalEntityId: WriteOp["entityId"];
    })
  | (DaemonAuthoritySubmissionInputBaseV2 & {
      readonly ingress:
        | "provenance-session"
        | "decision-transition"
        | "task-claim"
        | "observed-write"
        | "script-ingest";
      readonly operation: WriteOp;
    });

export interface DaemonAuthorityAttemptCompilerV2 {
  /**
   * Add a governed ingress by extending the discriminated union above and the
   * exhaustive production compiler switch. Do not add another submission
   * method: wrappers forward this one capability and semantic differences live
   * in the ingress payload and compiler handler.
   */
  readonly compile: (
    input: DaemonAuthorityCommandSubmissionInputV2
  ) => Promise<AuthorizedOperationAttemptV2>;
}

export interface DaemonAuthorityCommandSubmissionV2 {
  /** Read-only canonical planning used by truthful production dry-runs. */
  readonly planCommand?: (input: {
    readonly command: AuthorityHostCommand;
    readonly attribution: AuthorityHostAttribution;
    readonly currentSession: CurrentSessionRef;
    readonly ingressAdapter?: AuthorityIngressAdapter;
  }) => Promise<unknown>;
  readonly submit: (
    input: DaemonAuthorityCommandSubmissionInputV2
  ) => Promise<AuthorityOperationReceipt>;
  readonly submitDurable: (
    input: DaemonAuthorityCommandSubmissionInputV2
  ) => Promise<DaemonAuthorityDurableSubmissionV2>;
}

export type DaemonAuthorityDurableAdmissionV2 =
  | { readonly kind: "accepted"; readonly acceptance: AuthorityDurableAcceptance }
  | { readonly kind: "terminal"; readonly receipt: AuthorityOperationReceipt };

export interface DaemonAuthorityDurableSubmissionV2 {
  readonly admission: Promise<DaemonAuthorityDurableAdmissionV2>;
  readonly settlement: Promise<AuthorityOperationReceipt>;
}

export class AuthorityCompileRejectedError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>> | undefined;
  readonly outcome = "not-started" as const;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, options: {
    readonly cause?: unknown;
    readonly details?: Readonly<Record<string, unknown>>;
  } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "AuthorityCompileRejectedError";
    this.code = code;
    this.details = options.details;
  }
}

export function authorityCompileRejected(cause: unknown): AuthorityCompileRejectedError {
  if (cause instanceof AuthorityCompileRejectedError) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  const details = compileRejectionDetails(cause);
  const structuredCode = details && typeof (cause as { readonly code?: unknown }).code === "string"
    ? (cause as { readonly code: string }).code
    : undefined;
  return new AuthorityCompileRejectedError(
    structuredCode ?? authorityRejectionCode(reason),
    reason,
    { cause, ...(details ? { details } : {}) }
  );
}

export function createDaemonAuthorityCommandSubmissionV2(options: {
  readonly authorityService: AuthoritySubmissionService;
  readonly attemptCompiler: DaemonAuthorityAttemptCompilerV2;
}): DaemonAuthorityCommandSubmissionV2 {
  if (!options.authorityService.submitV2) throw new Error("DAEMON_AUTHORITY_V2_NOT_NEGOTIATED");
  const submitAttempt = async (attempt: AuthorizedOperationAttemptV2): Promise<AuthorityOperationReceipt> => {
    const envelope = decodeSemanticMutationEnvelopeV2(attempt.envelope);
    const expectedOpId = operationIdDiagnosticV2(envelope.operationId);
    reportCurrentRepoWriteTelemetry("git");
    const receipt = await options.authorityService.submitV2!(attempt);
    assertCompleteAuthorityReceiptV2(receipt);
    assertAuthorityReceiptOperation(receipt, expectedOpId);
    return receipt;
  };
  const compileAttempt = async (compile: () => Promise<AuthorizedOperationAttemptV2>) => {
    try {
      reportCurrentRepoWriteTelemetry("compile");
      return await compile();
    } catch (cause) {
      const rejected = authorityCompileRejected(cause);
      throw authorityWriteRejected(
        rejected.message,
        false,
        rejected.code,
        rejected.details
      );
    }
  };
  const compileAndSubmit = (
    compile: () => Promise<AuthorizedOperationAttemptV2>
  ): Promise<AuthorityOperationReceipt> => measureCurrentDaemonRequestPerformancePhase(
    "authority",
    async () => submitAttempt(await compileAttempt(compile))
  );
  const compileAndSubmitDurable = async (
    compile: () => Promise<AuthorizedOperationAttemptV2>
  ): Promise<DaemonAuthorityDurableSubmissionV2> => {
    const attempt = await measureCurrentDaemonRequestPerformancePhase(
      "authority",
      () => compileAttempt(compile)
    );
    const durable = durableAuthoritySubmissionFromSettlement(() =>
      measureCurrentDaemonRequestPerformancePhase("authority", () => submitAttempt(attempt))
    );
    return durable;
  };
  return {
    submit: (input) => compileAndSubmit(() => options.attemptCompiler.compile(input)),
    submitDurable: (input) => compileAndSubmitDurable(() => options.attemptCompiler.compile(input))
  };
}

function compileRejectionDetails(cause: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!cause || typeof cause !== "object" || !("details" in cause)) return undefined;
  const details = cause.details;
  return details && typeof details === "object" && !Array.isArray(details)
    ? details as Readonly<Record<string, unknown>>
    : undefined;
}

/** Preserve one settlement promise while exposing its durable publication cut. */
export function durableAuthoritySubmissionFromSettlement(
  settle: () => Promise<AuthorityOperationReceipt>
): DaemonAuthorityDurableSubmissionV2 {
  let admitted = false;
  let resolveAdmission: ((value: DaemonAuthorityDurableAdmissionV2) => void) | undefined;
  let rejectAdmission: ((error: unknown) => void) | undefined;
  const admission = new Promise<DaemonAuthorityDurableAdmissionV2>((resolve, reject) => {
    resolveAdmission = resolve;
    rejectAdmission = reject;
  });
  const settlement = runWithAuthorityDurableAcceptance({
    accept: (acceptance) => {
      if (admitted) return;
      admitted = true;
      resolveAdmission!({ kind: "accepted", acceptance });
    }
  }, settle);
  void settlement.then(
    (receipt) => {
      if (admitted) return;
      admitted = true;
      resolveAdmission!({ kind: "terminal", receipt });
    },
    (error) => {
      if (admitted) return;
      admitted = true;
      rejectAdmission!(error);
    }
  );
  return { admission, settlement };
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
  let durable: Promise<DaemonAuthorityDurableSubmissionV2> | undefined;
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
        if (!pending) {
          const action = input.command.action;
          if (mainCommitted || action.kind !== "task-complete") {
            return { reason, opCount: 0, committed: false };
          }
          durable ??= submission.submitDurable({
            ...input,
            ingress: "generic",
            canonicalEntityId: taskEntityId(action.taskId)
          });
          const report = await durableSubmissionFlushReport(await durable, reason);
          if (isIndeterminateFlushReport(report)) return report;
          durable = undefined;
          mainCommitted = true;
          mainWatermark = report.watermark;
          return report;
        }
        if (coveredByMainSubmission) {
          pending = undefined;
          coveredByMainSubmission = false;
          return { reason, opCount: 1, committed: true, ...(mainWatermark ? { watermark: mainWatermark } : {}) };
        }
        const provenanceSession = isProvenanceSessionOperation(input, pending);
        if (provenanceSession && provenanceCommitted) {
          throw authorityWriteRejected("AUTHORITY_COMMAND_REQUIRES_SINGLE_PROVENANCE_SESSION");
        }
        const ingressAdapter = input.ingressAdapter;
        const decisionTransition = ingressAdapter === "decision-transition";
        const taskClaim = ingressAdapter === "task-claim";
        const observedWrite = ingressAdapter === "observed-write";
        const scriptIngest = pending.kind === "script_ingest";
        durable ??= submission.submitDurable(scriptIngest
          ? { ...input, ingress: "script-ingest", operation: pending }
          : provenanceSession
          ? { ...input, ingress: "provenance-session", operation: pending }
          : decisionTransition
            ? { ...input, ingress: "decision-transition", operation: pending }
          : taskClaim
            ? { ...input, ingress: "task-claim", operation: pending }
          : observedWrite
            ? { ...input, ingress: "observed-write", operation: pending }
          : {
            ...input,
            ingress: "generic",
            command: input.command,
            canonicalEntityId: commandMainEntityId(input.command) ?? pending.entityId
          });
        const report = await durableSubmissionFlushReport(await durable, reason);
        if (isIndeterminateFlushReport(report)) return report;
        pending = undefined;
        durable = undefined;
        if (provenanceSession) provenanceCommitted = true;
        else {
          mainCommitted = true;
          mainWatermark = report.watermark;
        }
        return report;
      },
      catch: authoritySubmissionWriteError
    }),
    recover: Effect.succeed({ replayedOps: 0 } satisfies RecoveryReport)
  };
}

async function durableSubmissionFlushReport(
  submission: DaemonAuthorityDurableSubmissionV2,
  reason: FlushReason
): Promise<FlushReport> {
  const admission = await submission.admission;
  return admission.kind === "accepted"
    ? { ...admission.acceptance.flush, reason }
    : receiptToFlushReport(admission.receipt, reason);
}

function isAuthorityCoveredTaskTreeStage(command: AuthorityHostCommand, operation: WriteOp): boolean {
  return (command.action.kind === "task-complete" || command.action.kind === "task-submit")
    && operation.kind === "task_tree_stage";
}

function authorityCommandCoversLocalWritePhases(command: AuthorityHostCommand): boolean {
  const action = command.action;
  return action.kind === "status-set"
    || action.kind === "task-submit"
    || action.kind === "task-complete"
    || (action.kind === "task-review-execution" && action.verdict === "approved");
}

function isProvenanceSessionOperation(
  input: { readonly command: AuthorityHostCommand; readonly currentSession: CurrentSessionRef },
  operation: WriteOp
): boolean {
  const action = input.command.action;
  if (action.kind === "task-submit") {
    return operation.kind === "doc_write"
      && /^entity\/session\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(operation.entityId);
  }
  const sessionId = action.kind === "session-export"
    ? action.sessionId ?? input.currentSession.sessionId
    : input.currentSession.sessionId;
  return (
    action.kind === "new-task"
    || action.kind === "session-export"
  ) && operation.entityId === `entity/session/${sessionId}`;
}

function commandMainEntityId(command: AuthorityHostCommand): WriteOp["entityId"] | undefined {
  const action = command.action;
  if (action.kind === "new-task" && action.taskId) return taskEntityId(action.taskId);
  if (action.kind === "task-submit" && action.executionId) return `execution/${action.executionId}`;
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
    case "ALREADY_SATISFIED": return { reason, opCount: 0, committed: false, watermark: receipt.opId };
    case "REJECTED": throw authorityWriteRejected(receipt.reason, false, authorityRejectionCode(receipt.reason));
    case "RETRYABLE_NOT_COMMITTED": throw authorityWriteRejected(
      receipt.reason,
      true,
      receipt.errorCode,
      receipt.errorContext ? { ...receipt.errorContext } : undefined
    );
    case "INDETERMINATE": return {
      status: "indeterminate",
      reason,
      opCount: 1,
      operationIds: [receipt.opId],
      cause: {
        kind: "authority",
        workspaceId: receipt.workspaceId,
        semanticDigest: receipt.semanticDigest,
        evidence: receipt.reason,
        ...(receipt.commitSha ? { observedCommitSha: receipt.commitSha } : {}),
        ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
        ...(receipt.errorContext ? { errorContext: { ...receipt.errorContext } } : {})
      }
    };
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

function authorityRejectionCode(reason: string): string {
  return reason.startsWith("TASK_WIP_LIMIT_REACHED:")
    ? "task_wip_limit_reached"
    : reason.startsWith("TASK_PLAN_PLACEHOLDER:")
    ? "task_plan_placeholder"
    : reason.startsWith("TASK_RETURN_TO_IDEA_BLOCKED:")
    ? "task_return_to_idea_blocked"
    : reason === "MODULE_NOT_FOUND"
    || reason.startsWith("AUTHORITY_PRESET_TASK_CREATE_MODULE_NOT_FOUND:")
    ? "module_not_found"
    : "authority_ingress_rejected";
}

function isAuthorityWriteError(error: unknown): error is WriteError {
  return typeof error === "object" && error !== null && "_tag" in error && [
    "WriteRejected",
    "WriteConflict",
    "GlobalWriteConflict",
    "JournalUnavailable"
  ].includes(String(error._tag));
}
