import { generateTaskId } from "../../kernel/src/index.ts";
import type { HarnessLayoutInput } from "../../kernel/src/index.ts";
import type {
  CurrentSessionRef,
  ExecutionLeaseContext,
  ExecutionRecord,
  OutputEvidence,
  TaskHolderPrincipal,
  TaskHolderService
} from "../../kernel/src/index.ts";

export interface ExecutionSubmission {
  readonly completionClaim: string;
  readonly deliverables: ReadonlyArray<string>;
  readonly evidence: ReadonlyArray<OutputEvidence>;
  readonly verificationNotes: ReadonlyArray<string>;
  readonly knownGaps: ReadonlyArray<string>;
  readonly residualRisks: ReadonlyArray<string>;
}

export type ExecutionSessionRole = "primary" | "subagent" | "reviewer_observer";

export interface ExecutionSessionBinding {
  readonly binding_id: string;
  readonly session_ref: string | null;
  readonly role: ExecutionSessionRole;
  readonly archive_status: "pending" | "complete" | "partial" | "unavailable";
  readonly attached_at: string;
  readonly session: CurrentSessionRef | null;
  readonly capture_range: {
    readonly range_id: string;
    readonly coordinate: "timestamp";
    readonly start_at: string;
    readonly end_at: string | null;
    readonly bounds: "inclusive";
  } | null;
}

export interface ExecutionAuthoredStore {
  readonly readExecution: (input: { readonly taskId: string; readonly executionId: string }) => Promise<ExecutionRecord | null>;
  readonly openExecution: (input: {
    readonly taskId: string;
    readonly execution: ExecutionRecord;
  }) => Promise<void>;
  readonly attachSession: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly binding: ExecutionSessionBinding;
  }) => Promise<void>;
  readonly submitForReview: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly submittedAt: string;
    readonly submission: ExecutionSubmission;
  }) => Promise<void>;
}

export interface ExecutionClaimResult extends ExecutionLeaseContext {
  readonly execution: ExecutionRecord;
}

export interface ExecutionSagaService {
  readonly reconcileTask: (taskId: string) => Promise<void>;
  readonly claim: (input: {
    readonly taskId: string;
    readonly principal: TaskHolderPrincipal;
    readonly ttlMs?: number;
    readonly primarySession?: CurrentSessionRef | null;
  }) => Promise<ExecutionClaimResult>;
  readonly attachSession: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly leaseToken: string;
    readonly principal: TaskHolderPrincipal;
    readonly session: CurrentSessionRef;
    readonly role: ExecutionSessionRole;
  }) => Promise<void>;
  readonly submitForReview: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly leaseToken: string;
    readonly principal: TaskHolderPrincipal;
    readonly submission: ExecutionSubmission;
  }) => Promise<void>;
}

export interface ExecutionSagaServiceOptions {
  readonly taskHolderService: TaskHolderService;
  readonly authoredStore: ExecutionAuthoredStore;
  readonly generateExecutionId?: () => string;
  readonly now?: () => string;
  readonly finalizeSession?: (session: CurrentSessionRef) => Promise<void>;
}

export function makeExecutionSagaService(options: ExecutionSagaServiceOptions): ExecutionSagaService {
  const now = () => options.now?.() ?? new Date().toISOString();
  const generateExecutionId = options.generateExecutionId ?? (() => `exe_${generateTaskId().slice("task_".length)}`);
  return {
    claim: async (input) => {
      await reconcileTask(options, input.taskId);
      const renewed = await options.taskHolderService.renewExecution({
        taskId: input.taskId,
        principal: input.principal,
        ttlMs: input.ttlMs
      });
      if (renewed) {
        const execution = await options.authoredStore.readExecution({
          taskId: input.taskId,
          executionId: renewed.executionId
        });
        if (!execution || execution.state !== "active") {
          throw new Error(`active execution is unavailable for renewed lease: ${renewed.executionId}`);
        }
        return { ...renewed, execution };
      }
      const executionId = generateExecutionId();
      const reservation = await options.taskHolderService.reserveExecution({
        taskId: input.taskId,
        executionId,
        principal: input.principal,
        ttlMs: input.ttlMs
      });
      const execution: ExecutionRecord = {
        schema: "execution/v2",
        execution_id: executionId,
        task_ref: `task/${input.taskId}`,
        state: "active",
        primary_actor: input.principal,
        claimed_at: now(),
        submitted_at: null,
        closed_at: null,
        session_bindings: input.primarySession === undefined
          ? []
          : [input.primarySession
              ? sessionBinding(input.primarySession, "primary", now())
              : pendingPrimarySessionBinding(now())],
        outputs: [],
        submission: null
      };
      try {
        await options.authoredStore.openExecution({ taskId: input.taskId, execution });
      } catch (error) {
        await options.taskHolderService.releaseExecution({
          taskId: input.taskId,
          executionId,
          leaseToken: reservation.leaseToken,
          principal: input.principal
        });
        throw error;
      }
      const active = await options.taskHolderService.activateExecution({
        taskId: input.taskId,
        executionId,
        leaseToken: reservation.leaseToken,
        principal: input.principal
      });
      return { ...active, execution };
    },
    attachSession: async (input) => {
      await options.taskHolderService.assertExecutionLease(input);
      await options.authoredStore.attachSession({
        taskId: input.taskId,
        executionId: input.executionId,
        binding: sessionBinding(input.session, input.role, now())
      });
    },
    submitForReview: async (input) => {
      await options.taskHolderService.assertExecutionLease(input);
      const execution = await options.authoredStore.readExecution({ taskId: input.taskId, executionId: input.executionId });
      const primarySession = execution ? boundPrimarySession(execution.session_bindings) : null;
      if (primarySession && options.finalizeSession) await options.finalizeSession(primarySession);
      await options.authoredStore.submitForReview({
        taskId: input.taskId,
        executionId: input.executionId,
        submittedAt: now(),
        submission: input.submission
      });
      await options.taskHolderService.releaseExecution(input);
    },
    reconcileTask: (taskId) => reconcileTask(options, taskId)
  };
}

export function makeExecutionReservationReconciler(
  options: Omit<ExecutionSagaServiceOptions, "authoredStore"> & {
    readonly rootInput: HarnessLayoutInput;
    readonly authoredStore?: ExecutionAuthoredStore;
    readonly authoredStoreForLease?: (input: {
      readonly taskId: string;
      readonly executionId: string;
      readonly principal: TaskHolderPrincipal;
    }) => ExecutionAuthoredStore;
  }
): () => Promise<void> {
  return async () => {
    for (const lease of await options.taskHolderService.executionLeases()) {
      const snapshot = await options.taskHolderService.holder({ taskId: lease.taskId });
      const record = snapshot.holder;
      if (record?.schema !== "task-holder/v2" || record.executionId !== lease.executionId) continue;
      const authoredStore = options.authoredStoreForLease?.({
        taskId: lease.taskId,
        executionId: lease.executionId,
        principal: record.holder
      }) ?? options.authoredStore;
      if (!authoredStore) throw new Error(`reservation reconciliation store is unavailable: ${lease.executionId}`);
      await makeExecutionSagaService({ ...options, authoredStore }).reconcileTask(lease.taskId);
    }
  };
}

function boundPrimarySession(bindings: ReadonlyArray<unknown>): CurrentSessionRef | null {
  for (const binding of bindings) {
    if (!binding || typeof binding !== "object") continue;
    const record = binding as { readonly role?: unknown; readonly session?: unknown };
    if (record.role !== "primary" || !record.session || typeof record.session !== "object") continue;
    return record.session as CurrentSessionRef;
  }
  return null;
}

function sessionBinding(session: CurrentSessionRef, role: ExecutionSessionRole, attachedAt: string): ExecutionSessionBinding {
  return {
    binding_id: `${role}:${session.sessionId}`,
    session_ref: `session/${session.sessionId}`,
    role,
    archive_status: "pending",
    attached_at: attachedAt,
    session,
    capture_range: captureRange(role, session.sessionId, attachedAt)
  };
}

function pendingPrimarySessionBinding(attachedAt: string): ExecutionSessionBinding {
  return {
    binding_id: "primary:pending",
    session_ref: null,
    role: "primary",
    archive_status: "pending",
    attached_at: attachedAt,
    session: null,
    capture_range: captureRange("primary", "pending", attachedAt)
  };
}

function captureRange(role: ExecutionSessionRole, sessionId: string, attachedAt: string): NonNullable<ExecutionSessionBinding["capture_range"]> {
  return {
    range_id: `${role}:${sessionId}:${attachedAt}`,
    coordinate: "timestamp",
    start_at: attachedAt,
    end_at: null,
    bounds: "inclusive"
  };
}

async function reconcileTask(options: ExecutionSagaServiceOptions, taskId: string): Promise<void> {
  const lease = (await options.taskHolderService.holder({ taskId })).holder;
  if (lease?.schema !== "task-holder/v2") return;
  const execution = await options.authoredStore.readExecution({ taskId, executionId: lease.executionId });
  const authoredState = execution?.state === "submitted" ? "submitted" : execution?.state === "active" ? "active" : "missing";
  await options.taskHolderService.reconcileExecution({ taskId, executionId: lease.executionId, authoredState });
}
