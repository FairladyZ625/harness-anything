// @slice-activation P4 W2 exposes replay/v1 domain transactions for the W3 CLI composition root.
import { Effect } from "effect";
import {
  applyTransition,
  assertAntiEntropyGraph,
  canonicalizeContractValue,
  freezeWritePlan,
  validateTransition,
  type FrozenWritePlan,
  type LeaseV1,
  type ProofFor,
  type StartExecutionProof,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot
} from "../../kernel/src/index.ts";

export class TaskLifecycleOperationConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskLifecycleOperationConflict";
  }
}

export type TaskLifecycleKillpoint = "after_reservation" | "after_event_append" | "before_projection_apply" | "after_projection_apply" | "before_lease_finalize";

export interface TaskLifecycleServiceRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}

export type TaskLifecycleOperationReceipt = {
  readonly status: "applied" | "pending" | "indeterminate";
  readonly event?: TaskEventV1;
  readonly revision: number;
  readonly snapshot: TaskLifecycleSnapshot;
  readonly writePlan: FrozenWritePlan<TaskLifecycleCommand["type"]>;
  readonly reason?: string;
  readonly query?: string;
};

interface EventStorePort {
  readonly read: () => { readonly revision: number; readonly events: readonly TaskEventV1[] };
  readonly append: (event: TaskEventV1) => Effect.Effect<
    | { readonly status: "applied"; readonly event: TaskEventV1; readonly revision: number }
    | { readonly status: "indeterminate"; readonly reason: string; readonly query: string }, never
  >;
}

interface ProjectionPort {
  readonly apply: (event: TaskEventV1) => void;
  readonly read: (taskId: string) => TaskLifecycleServiceRead;
}

interface LeasePort {
  readonly current: (taskId: string) => LeaseV1 | null;
  readonly reserve: (input: { readonly taskId: string; readonly executionId: string; readonly actor: TaskLifecycleCommand["actor"]; readonly credentialHash: string; readonly expiresAt: string }) => LeaseV1;
  readonly activate: (input: LeaseCas) => LeaseV1;
  readonly renew: (input: LeaseCas & { readonly expiresAt: string }) => LeaseV1;
  readonly release: (input: LeaseCas) => LeaseV1;
}

interface LeaseCas { readonly taskId: string; readonly executionId: string; readonly credentialHash: string; readonly version: number }

export interface TaskLifecycleService {
  readonly execute: <C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>) => Promise<TaskLifecycleOperationReceipt>;
  readonly read: (taskId: string) => Promise<TaskLifecycleServiceRead>;
  readonly renewLease: (input: LeaseCas & { readonly expiresAt: string }) => LeaseV1;
}

export function makeTaskLifecycleService(options: {
  readonly eventStore: EventStorePort;
  readonly projection: ProjectionPort;
  readonly leases: LeasePort;
  readonly killpoint?: (point: TaskLifecycleKillpoint) => void;
}): TaskLifecycleService {
  const read = (taskId: string) => readAndConverge(options.projection, options.leases, taskId);
  return {
    read,
    renewLease: (input) => options.leases.renew(input),
    execute: async <C extends TaskLifecycleCommand>(command: C, suppliedProof: ProofFor<C>) => {
      const plan = commandWritePlan(command);
      const existing = options.eventStore.read().events.find((event) => event.opId === command.opId);
      if (existing !== undefined) {
        if (!eventMatchesOperation(existing, command, suppliedProof)) throw new TaskLifecycleOperationConflict(`opId ${command.opId} already has a different payload`);
        return receiptFromRead(await read(command.taskId), existing, plan);
      }

      const current = await read(command.taskId);
      if (current.status !== "ready") return pendingReceipt(current, plan, "projection catch-up is pending");
      let proof = suppliedProof;
      let reservation: LeaseV1 | null = null;
      let event: TaskEventV1 | undefined;
      try {
        if (command.type === "StartExecution") {
          const startProof = suppliedProof as StartExecutionProof;
          reservation = options.leases.reserve({
            taskId: command.taskId,
            executionId: command.executionId,
            actor: command.actor,
            credentialHash: startProof.reservation.credentialHash,
            expiresAt: startProof.reservation.expiresAt
          });
          proof = { ...startProof, reservation: { ...startProof.reservation, version: reservation.version } } as ProofFor<C>;
          options.killpoint?.("after_reservation");
        }

        const snapshot = { ...current.snapshot, lease: command.type === "StartExecution" ? null : options.leases.current(command.taskId) };
        const issues = validateTransition(snapshot, command, proof);
        if (issues.length > 0) applyTransition(snapshot, command, proof);
        assertAntiEntropyGraph(snapshot, command, proof);
        const transition = applyTransition(snapshot, command, proof);
        event = transition.event;

        const publication = await Effect.runPromise(options.eventStore.append(event));
        if (publication.status === "indeterminate") {
          releaseReservation(options.leases, reservation);
          return indeterminateReceipt(current, plan, publication.reason, publication.query);
        }
        event = publication.event;
        options.killpoint?.("after_event_append");
        options.killpoint?.("before_projection_apply");
        try {
          options.projection.apply(event);
        } catch (error) {
          return pendingReceipt(await read(command.taskId), plan, errorMessage(error), event);
        }
        options.killpoint?.("after_projection_apply");
        options.killpoint?.("before_lease_finalize");
        try {
          finalizeLease(options.leases, command, reservation);
        } catch (error) {
          return pendingReceipt(await read(command.taskId), plan, errorMessage(error), event);
        }
        return receiptFromRead(await read(command.taskId), event, plan);
      } catch (error) {
        if (event === undefined) {
          releaseReservation(options.leases, reservation);
          throw error;
        }
        const stream = options.eventStore.read();
        if (!stream.events.some((candidate) => candidate.opId === event?.opId)) {
          releaseReservation(options.leases, reservation);
          if (stream.events.some((candidate) => candidate.workspaceRevision === event?.workspaceRevision)) {
            throw new TaskLifecycleOperationConflict(`workspace revision ${event.workspaceRevision} was accepted by another operation`);
          }
          throw error;
        }
        return indeterminateReceipt(await read(command.taskId), plan, errorMessage(error), `task lifecycle read ${command.taskId}`, event);
      }
    }
  };
}

function commandWritePlan(command: TaskLifecycleCommand): FrozenWritePlan<TaskLifecycleCommand["type"]> {
  return freezeWritePlan({
    commandType: command.type,
    targets: [
      { kind: "event_stream", stream: "harness/task-events.ndjson", operation: "append" },
      { kind: "projection_invalidation", projection: "task-lifecycle/v1", taskId: command.taskId }
    ]
  });
}

async function readAndConverge(projection: ProjectionPort, leases: LeasePort, taskId: string): Promise<TaskLifecycleServiceRead> {
  const read = projection.read(taskId);
  if (read.status !== "ready") return read;
  let lease = leases.current(taskId);
  if (lease !== null) {
    const execution = read.snapshot.executions.find((candidate) => candidate.executionId === lease?.executionId);
    if (lease.phase === "reserving" && execution?.state === "active") lease = leases.activate(cas(lease));
    else if (execution?.state !== "active") {
      leases.release(cas(lease));
      lease = null;
    }
  }
  const activeWithoutLease = read.snapshot.executions.some((execution) => execution.state === "active") && lease === null;
  return { ...read, status: activeWithoutLease ? "pending" : "ready", snapshot: { ...read.snapshot, lease } };
}

function finalizeLease(leases: LeasePort, command: TaskLifecycleCommand, reservation: LeaseV1 | null): void {
  if (command.type === "StartExecution" && reservation !== null) {
    leases.activate(cas(reservation));
  } else if (command.type === "SubmitExecution") {
    const lease = leases.current(command.taskId);
    if (lease !== null) leases.release(cas(lease));
  }
}

function releaseReservation(leases: LeasePort, reservation: LeaseV1 | null): void {
  if (reservation === null) return;
  try {
    leases.release(cas(reservation));
  } catch (error) {
    consumeKnownError(error);
  }
}

function cas(lease: LeaseV1): LeaseCas {
  return { taskId: lease.taskId, executionId: lease.executionId, credentialHash: lease.credentialHash, version: lease.version };
}

function receiptFromRead(read: TaskLifecycleServiceRead, event: TaskEventV1, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>): TaskLifecycleOperationReceipt {
  return read.status === "ready"
    ? { status: "applied", event, revision: event.workspaceRevision, snapshot: read.snapshot, writePlan: plan }
    : pendingReceipt(read, plan, "projection or lease convergence is pending", event);
}

function pendingReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, reason: string, event?: TaskEventV1): TaskLifecycleOperationReceipt {
  return { status: "pending", ...(event ? { event } : {}), revision: event?.workspaceRevision ?? read.sourceRevision, snapshot: read.snapshot, writePlan: plan, reason, query: "retry task lifecycle read" };
}

function indeterminateReceipt(read: TaskLifecycleServiceRead, plan: FrozenWritePlan<TaskLifecycleCommand["type"]>, reason: string, query: string, event?: TaskEventV1): TaskLifecycleOperationReceipt {
  return { status: "indeterminate", ...(event ? { event } : {}), revision: event?.workspaceRevision ?? read.sourceRevision, snapshot: read.snapshot, writePlan: plan, reason, query };
}

function eventMatchesOperation<C extends TaskLifecycleCommand>(event: TaskEventV1, command: C, proof: ProofFor<C>): boolean {
  return canonicalJson(operationIdentityFromEvent(event)) === canonicalJson(operationIdentityFromCommand(command, proof));
}

function operationIdentityFromCommand<C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>): unknown {
  const common = { type: command.type, taskId: command.taskId, eventId: command.eventId, workspaceRevision: command.workspaceRevision, actor: command.actor, occurredAt: command.occurredAt };
  if (command.type === "CreateReplayTask") return { ...common, title: command.title, graph: command.graph, completionGateIds: command.completionGateIds };
  if (command.type === "StartExecution") return { ...common, executionId: command.executionId };
  if (command.type === "SubmitExecution") return { ...common, executionId: command.executionId, submission: command.submission };
  if (command.type === "CompleteTask") return { ...common, executionId: command.executionId };
  return { ...common, executionId: command.executionId, reviewId: command.reviewId, kind: command.kind, verdict: command.verdict, actorRole: command.actorRole, reason: command.reason, evidenceChecked: command.evidenceChecked, commitSha: command.commitSha, iteration: command.iteration, archiveWarningsAcknowledged: command.archiveWarningsAcknowledged, capabilityRef: (proof as { readonly capabilityRef: string }).capabilityRef };
}

function operationIdentityFromEvent(event: TaskEventV1): unknown {
  const type = event.type === "task_created" ? "CreateReplayTask" : event.type === "execution_started" ? "StartExecution" : event.type === "execution_submitted" ? "SubmitExecution" : event.type === "task_completed" ? "CompleteTask" : "RecordReview";
  const common = { type, taskId: event.taskId, eventId: event.eventId, workspaceRevision: event.workspaceRevision, actor: event.actor, occurredAt: event.occurredAt };
  if (event.type === "task_created") return { ...common, title: event.payload.task.title, graph: event.payload.task.graph, completionGateIds: event.payload.task.completionGateIds };
  if (event.type === "execution_started" || event.type === "task_completed") return { ...common, executionId: event.payload.execution.executionId };
  if (event.type === "execution_submitted") return { ...common, executionId: event.payload.execution.executionId, submission: event.payload.execution.submission };
  const review = event.payload.review;
  return { ...common, executionId: review.executionId, reviewId: review.reviewId, kind: review.kind, verdict: review.verdict, actorRole: review.actorRole, reason: review.reason, evidenceChecked: review.evidenceChecked, commitSha: review.commitSha, iteration: review.iteration, archiveWarningsAcknowledged: review.archiveWarningsAcknowledged, capabilityRef: review.capabilityRef };
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalizeContractValue(value)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function consumeKnownError(error: unknown): void { void error; }
