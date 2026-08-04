import { generateTaskId } from "@harness-anything/kernel";
import type { HarnessLayoutInput } from "@harness-anything/kernel";
import type {
  CurrentSessionRef,
  ExecutionLeaseContext,
  ExecutionRecord,
  OutputEvidence,
  TaskHolderPrincipal,
  TaskHolderService
} from "@harness-anything/kernel";

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
  readonly listExecutions: (input: { readonly taskId: string }) => Promise<ReadonlyArray<ExecutionRecord>>;
  readonly readExecution: (input: { readonly taskId: string; readonly executionId: string }) => Promise<ExecutionRecord | null>;
  readonly openExecution: (input: {
    readonly taskId: string;
    readonly execution: ExecutionRecord;
    readonly activation?: {
      readonly taskPlanBodySha256: string;
    };
  }) => Promise<void>;
  readonly claimPublicationState: (input: {
    readonly taskId: string;
    readonly execution: ExecutionRecord;
    readonly activation?: {
      readonly taskPlanBodySha256: string;
    };
  }) => Promise<"committed" | "absent" | "partial">;
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
  readonly submitPublicationState: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly submittedAt: string;
    readonly submission: ExecutionSubmission;
  }) => Promise<"committed" | "absent" | "partial">;
}

export interface ExecutionClaimResult extends ExecutionLeaseContext {
  readonly execution: ExecutionRecord;
  readonly reused: boolean;
  readonly leaseAcquiredAt: string;
}

export interface ExecutionSubmitResult {
  /**
   * Authored submission success is authoritative. Lease release is a
   * post-commit cleanup result and cannot reverse that committed outcome.
   */
  readonly leaseReleased: boolean;
  readonly cleanup: {
    readonly status: "released" | "retained" | "unknown";
    readonly diagnostics: ReadonlyArray<{
      readonly phase: "release" | "verification";
      readonly message: string;
    }>;
  };
}

export interface ExecutionSagaService {
  readonly reconcileTask: (taskId: string) => Promise<void>;
  readonly claim: (input: {
    readonly taskId: string;
    readonly principal: TaskHolderPrincipal;
    readonly ttlMs?: number;
    readonly primarySession?: CurrentSessionRef | null;
    readonly executionId?: string;
    readonly activation?: {
      readonly taskPlanBodySha256: string;
    };
  }) => Promise<ExecutionClaimResult>;
  readonly attachSession: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly leaseToken?: string;
    readonly principal: TaskHolderPrincipal;
    readonly session: CurrentSessionRef;
    readonly role: ExecutionSessionRole;
  }) => Promise<void>;
  readonly submitForReview: (input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly leaseToken?: string;
    readonly principal: TaskHolderPrincipal;
    readonly submission: ExecutionSubmission;
  }) => Promise<ExecutionSubmitResult>;
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
      const holder = await options.taskHolderService.holder({ taskId: input.taskId });
      if (input.executionId && holder.effectiveHolder && holder.holder?.schema === "task-holder/v2"
          && holder.holder.executionId !== input.executionId) {
        throw new Error([
          `Task ${input.taskId} already has a live lease for Execution ${holder.holder.executionId}; requested ${input.executionId}.`,
          `Next: run \`ha task release ${input.taskId}\` as the current holder, then \`ha task start ${input.taskId} --execution-id ${input.executionId}\`.`
        ].join(" "));
      }
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
        return {
          ...renewed,
          execution,
          reused: true,
          leaseAcquiredAt: renewed.holder?.schema === "task-holder/v2"
            ? renewed.holder.updatedAt
            : execution.claimed_at
        };
      }
      const executions = await options.authoredStore.listExecutions({ taskId: input.taskId });
      const submitted = executions.filter((execution) => execution.state === "submitted");
      if (submitted.length > 0) {
        throw new Error(submittedClaimGuidance(input.taskId, submitted));
      }
      const activeExecutions = executions.filter((execution) => execution.state === "active");
      const selected = selectReusableExecution(input.taskId, input.executionId, executions, activeExecutions);
      if (selected) {
        const reservation = await options.taskHolderService.reserveExecution({
          taskId: input.taskId,
          executionId: selected.execution_id,
          principal: input.principal,
          ttlMs: input.ttlMs
        });
        try {
          const current = await options.authoredStore.readExecution({
            taskId: input.taskId,
            executionId: selected.execution_id
          });
          if (!current || current.state !== "active") {
            throw new Error(`active execution is unavailable for reserved lease: ${selected.execution_id}`);
          }
          const resumed = await options.taskHolderService.activateExecution({
            taskId: input.taskId,
            executionId: selected.execution_id,
            leaseToken: reservation.leaseToken,
            principal: input.principal
          });
          return {
            ...resumed,
            execution: current,
            reused: true,
            leaseAcquiredAt: reservation.holder?.schema === "task-holder/v2"
              ? reservation.holder.acquiredAt
              : current.claimed_at
          };
        } catch (error) {
          await options.taskHolderService.releaseExecution({
            taskId: input.taskId,
            executionId: selected.execution_id,
            leaseToken: reservation.leaseToken,
            principal: input.principal
          });
          throw error;
        }
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
        await options.authoredStore.openExecution({
          taskId: input.taskId,
          execution,
          ...(input.activation === undefined ? {} : { activation: input.activation })
        });
      } catch (error) {
        const publication = await options.authoredStore.claimPublicationState({
          taskId: input.taskId,
          execution,
          ...(input.activation === undefined ? {} : { activation: input.activation })
        });
        if (publication === "committed") {
          // The coordinator committed the full claim transaction before its
          // caller observed an error. Adopt only the complete transaction.
        } else {
          await options.taskHolderService.releaseExecution({
            taskId: input.taskId,
            executionId,
            leaseToken: reservation.leaseToken,
            principal: input.principal
          });
          if (publication === "partial") {
            throw new Error(
              `execution claim publication is indeterminate because only part of the activation transaction is observable: ${executionId}`,
              { cause: error }
            );
          }
          throw error;
        }
      }
      const active = await options.taskHolderService.activateExecution({
        taskId: input.taskId,
        executionId,
        leaseToken: reservation.leaseToken,
        principal: input.principal
      });
      return {
        ...active,
        execution,
        reused: false,
        leaseAcquiredAt: reservation.holder?.schema === "task-holder/v2"
          ? reservation.holder.acquiredAt
          : execution.claimed_at
      };
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
      const submissionAttempt = {
        taskId: input.taskId,
        executionId: input.executionId,
        submittedAt: now(),
        submission: input.submission
      };
      try {
        await options.authoredStore.submitForReview(submissionAttempt);
      } catch (error) {
        let publication: "committed" | "absent" | "partial";
        try {
          publication = await options.authoredStore.submitPublicationState(submissionAttempt);
        } catch (queryError) {
          throw new Error(
            `execution submit publication is indeterminate because its exact authored state could not be read: ${input.executionId}`,
            { cause: new AggregateError([error, queryError]) }
          );
        }
        if (publication === "absent") throw error;
        if (publication === "partial") {
          throw new Error(
            [
              `execution submit publication is indeterminate because only part of the exact submission is observable: ${input.executionId}.`,
              "The authored execution may already contain its submitted state, submitted_at, outputs, and submission packet.",
              `Inspect it with \`ha execution show ${input.executionId} --json\` before retrying; do not retry this exact submission blindly.`
            ].join(" "),
            { cause: error }
          );
        }
        // Exact authored execution and INDEX bytes are authoritative even if
        // the coordinator failed after their canonical publication.
      }
      let cleanup: ExecutionSubmitResult["cleanup"] = {
        status: "released",
        diagnostics: []
      };
      try {
        await options.taskHolderService.releaseExecution(input);
      } catch (releaseError) {
        // Publication is already committed. Reconcile cleanup from authored
        // state, but never translate a cleanup race into a failed write.
        const diagnostics: Array<ExecutionSubmitResult["cleanup"]["diagnostics"][number]> = [
          { phase: "release", message: cleanupErrorMessage(releaseError) }
        ];
        try {
          await reconcileTask(options, input.taskId);
          const released = (await options.taskHolderService.holder({
            taskId: input.taskId
          })).effectiveHolder === null;
          cleanup = {
            status: released ? "released" : "retained",
            // A lease-required/release-not-holder error is an expected
            // post-publication race when reconciliation proves that the
            // holder is already gone. Keeping its actionable pre-write hint
            // on a successful receipt makes agents retry a write that already
            // committed.
            diagnostics: released && isLeaseCleanupRace(releaseError) ? [] : diagnostics
          };
        } catch (verificationError) {
          cleanup = {
            status: "unknown",
            diagnostics: [
              ...diagnostics,
              { phase: "verification", message: cleanupErrorMessage(verificationError) }
            ]
          };
        }
      }
      return {
        leaseReleased: cleanup.status === "released",
        cleanup
      };
    },
    reconcileTask: (taskId) => reconcileTask(options, taskId)
  };
}

function cleanupErrorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function isLeaseCleanupRace(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return code === "task_lease_required" || code === "task_release_not_holder";
}

function selectReusableExecution(
  taskId: string,
  requestedExecutionId: string | undefined,
  executions: ReadonlyArray<ExecutionRecord>,
  active: ReadonlyArray<ExecutionRecord>
): ExecutionRecord | null {
  if (requestedExecutionId) {
    const selected = executions.find((execution) => execution.execution_id === requestedExecutionId);
    if (!selected) {
      throw new Error(`Execution ${requestedExecutionId} does not exist for Task ${taskId}. Next: run \`ha task start ${taskId}\` to reuse the sole active round or open a new round when none is reusable.`);
    }
    if (selected.state !== "active") {
      const next = selected.state === "changes_requested"
        ? `run \`ha task start ${taskId}\` without --execution-id to open the required rework round`
        : `inspect it with \`ha execution show ${requestedExecutionId}\` and select an active Execution`;
      throw new Error(`Execution ${requestedExecutionId} is ${selected.state}, not active. Next: ${next}.`);
    }
    return selected;
  }
  if (active.length === 1) return active[0]!;
  if (active.length > 1) {
    const commands = active
      .map((execution) => `\`ha task start ${taskId} --execution-id ${execution.execution_id}\``)
      .join(" or ");
    throw new Error(`Task ${taskId} has ${active.length} reusable active Executions: ${active.map((execution) => execution.execution_id).join(", ")}. Next: choose the authoritative round with ${commands}. No new Execution was created.`);
  }
  return null;
}

function submittedClaimGuidance(taskId: string, submitted: ReadonlyArray<ExecutionRecord>): string {
  const ids = submitted.map((execution) => execution.execution_id).join(", ");
  return [
    `Task ${taskId} already has submitted Execution${submitted.length === 1 ? "" : "s"}: ${ids}; claim will not create another round.`,
    `Next: review a submitted round with \`ha task review-execution ${taskId} --execution-id <execution-id> --verdict approved|changes_requested|dismissed --findings <text> --rationale <text>\`, or when exactly one round is approved run \`ha task complete ${taskId}\`.`
  ].join(" ");
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
    readonly minimumMissingReservationAgeMs?: number;
  }
): () => Promise<void> {
  const minimumMissingReservationAgeMs = options.minimumMissingReservationAgeMs ?? 0;
  if (!Number.isSafeInteger(minimumMissingReservationAgeMs) || minimumMissingReservationAgeMs < 0) {
    throw new Error("minimumMissingReservationAgeMs must be a non-negative safe integer");
  }
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
      await reconcileTask(
        { ...options, authoredStore },
        lease.taskId,
        minimumMissingReservationAgeMs
      );
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

async function reconcileTask(
  options: ExecutionSagaServiceOptions,
  taskId: string,
  minimumMissingReservationAgeMs = 0
): Promise<void> {
  const lease = (await options.taskHolderService.holder({ taskId })).holder;
  if (lease?.schema !== "task-holder/v2") return;
  const execution = await options.authoredStore.readExecution({ taskId, executionId: lease.executionId });
  const authoredState = execution?.state === "submitted" ? "submitted" : execution?.state === "active" ? "active" : "missing";
  if (authoredState === "missing" && lease.phase === "reserving"
    && Date.parse(options.now?.() ?? new Date().toISOString()) - Date.parse(lease.acquiredAt)
      < minimumMissingReservationAgeMs) return;
  await options.taskHolderService.reconcileExecution({ taskId, executionId: lease.executionId, authoredState });
}
