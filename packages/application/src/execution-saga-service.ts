import { generateTaskId } from "../../kernel/src/index.ts";
import type {
  ExecutionLeaseContext,
  ExecutionRecord,
  TaskHolderPrincipal,
  TaskHolderService
} from "../../kernel/src/index.ts";

export interface ExecutionSubmission {
  readonly summary: string;
  readonly verification: ReadonlyArray<string>;
  readonly residualRisks: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<unknown>;
}

export interface ExecutionAuthoredStore {
  readonly readExecution: (input: { readonly taskId: string; readonly executionId: string }) => Promise<ExecutionRecord | null>;
  readonly openExecution: (input: {
    readonly taskId: string;
    readonly execution: ExecutionRecord;
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
  }) => Promise<ExecutionClaimResult>;
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
}

export function makeExecutionSagaService(options: ExecutionSagaServiceOptions): ExecutionSagaService {
  const now = () => options.now?.() ?? new Date().toISOString();
  const generateExecutionId = options.generateExecutionId ?? (() => `exe_${generateTaskId().slice("task_".length)}`);
  return {
    claim: async (input) => {
      await reconcileTask(options, input.taskId);
      const executionId = generateExecutionId();
      const reservation = await options.taskHolderService.reserveExecution({
        taskId: input.taskId,
        executionId,
        principal: input.principal,
        ttlMs: input.ttlMs
      });
      const execution: ExecutionRecord = {
        schema: "execution/v1",
        execution_id: executionId,
        task_ref: `task/${input.taskId}`,
        state: "active",
        primary_actor: input.principal,
        claimed_at: now(),
        submitted_at: null,
        closed_at: null,
        session_bindings: [],
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
    submitForReview: async (input) => {
      await options.taskHolderService.assertExecutionLease(input);
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

async function reconcileTask(options: ExecutionSagaServiceOptions, taskId: string): Promise<void> {
  const lease = (await options.taskHolderService.holder({ taskId })).holder;
  if (lease?.schema !== "task-holder/v2") return;
  const execution = await options.authoredStore.readExecution({ taskId, executionId: lease.executionId });
  const authoredState = execution?.state === "submitted" ? "submitted" : execution?.state === "active" ? "active" : "missing";
  await options.taskHolderService.reconcileExecution({ taskId, executionId: lease.executionId, authoredState });
}
