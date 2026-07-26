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
import { measureCurrentDaemonRequestPerformancePhase } from "../observability/request-performance.ts";
import { reportCurrentRepoWriteTelemetry } from "../runtime/repo-write-telemetry-context.ts";

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
  readonly submit: (
    input: DaemonAuthorityCommandSubmissionInputV2
  ) => Promise<AuthorityOperationReceipt>;
}

export class AuthorityCompileRejectedError extends Error {
  readonly code: string;
  readonly outcome = "not-started" as const;
  readonly replay = "caller-may-retry" as const;

  constructor(code: string, message: string, options: { readonly cause?: unknown } = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "AuthorityCompileRejectedError";
    this.code = code;
  }
}

export function authorityCompileRejected(cause: unknown): AuthorityCompileRejectedError {
  if (cause instanceof AuthorityCompileRejectedError) return cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new AuthorityCompileRejectedError(
    authorityRejectionCode(reason),
    reason,
    { cause }
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
        rejected.code
      );
    }
  };
  const compileAndSubmit = (
    compile: () => Promise<AuthorizedOperationAttemptV2>
  ): Promise<AuthorityOperationReceipt> => measureCurrentDaemonRequestPerformancePhase(
    "authority",
    async () => submitAttempt(await compileAttempt(compile))
  );
  return {
    submit: (input) => compileAndSubmit(() => options.attemptCompiler.compile(input))
  };
}

export function gateAuthoritySubmissionForRecovery(
  service: AuthoritySubmissionService,
  unavailableReason: () => Promise<string | undefined> | string | undefined
): AuthoritySubmissionService {
  return {
    getOperation: service.getOperation,
    submit: async (envelope) => {
      const reason = await unavailableReason();
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
        const reason = await unavailableReason();
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
    } : {}),
    ...(service.resumeV2 ? {
      resumeV2: async (recovery) => {
        const reason = await unavailableReason();
        if (!reason) return service.resumeV2!(recovery);
        // Unlike a fresh admission, a recovery candidate may already have
        // canonical side effects. Preserve the outer PROCEEDING instead of
        // manufacturing a not-committed receipt while recovery is unresolved.
        throw new Error(reason);
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
        const ingressAdapter = input.ingressAdapter;
        const decisionTransition = ingressAdapter === "decision-transition";
        const taskClaim = ingressAdapter === "task-claim";
        const observedWrite = ingressAdapter === "observed-write";
        const scriptIngest = pending.kind === "script_ingest";
        settled ??= submission.submit(scriptIngest
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
            command: commandWithCompletionContractFence(input.command, pending),
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

function commandWithCompletionContractFence(
  command: AuthorityHostCommand,
  operation: WriteOp
): AuthorityHostCommand {
  if (command.action.kind !== "task-complete") return command;
  const action = command.action;
  const payload = operation.payload && typeof operation.payload === "object"
    ? operation.payload as {
        readonly entityDocument?: { readonly body?: unknown };
        readonly preconditions?: ReadonlyArray<{
          readonly taskId?: unknown;
          readonly path?: unknown;
          readonly bodySha256?: unknown;
        }>;
      }
    : null;
  const contract = payload?.preconditions?.find((entry) =>
    entry.taskId === action.taskId && entry.path === "task-contract.json"
  );
  if (!contract || (contract.bodySha256 !== null
    && (typeof contract.bodySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(contract.bodySha256)))) {
    throw authorityWriteRejected("AUTHORITY_TASK_COMPLETE_CONTRACT_PRECONDITION_REQUIRED");
  }
  let completionApplicableGates: ReadonlyArray<string> | undefined;
  if (action.evidenceMode === "commit-anchor" && typeof payload?.entityDocument?.body === "string") {
    let evidence: { readonly gateReceipt?: { readonly applicableGates?: unknown } };
    try {
      evidence = JSON.parse(payload.entityDocument.body) as typeof evidence;
    } catch {
      throw authorityWriteRejected("AUTHORITY_TASK_COMPLETE_GATE_RECEIPT_REQUIRED");
    }
    if (!Array.isArray(evidence.gateReceipt?.applicableGates)
      || evidence.gateReceipt.applicableGates.some((gate) => typeof gate !== "string" || gate.length === 0)) {
      throw authorityWriteRejected("AUTHORITY_TASK_COMPLETE_GATE_RECEIPT_REQUIRED");
    }
    completionApplicableGates = evidence.gateReceipt.applicableGates as ReadonlyArray<string>;
  }
  return {
    ...command,
    action: {
      ...action,
      completionContractBodySha256: contract.bodySha256,
      ...(completionApplicableGates ? { completionApplicableGates } : {})
    }
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
    case "REJECTED": throw authorityWriteRejected(receipt.reason, false, authorityRejectionCode(receipt.reason));
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

function authorityRejectionCode(reason: string): string {
  return reason.startsWith("TASK_WIP_LIMIT_REACHED:")
    ? "task_wip_limit_reached"
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
