// @slice-activation P4 W2 is composed by tests; W3 owns daemon and production publication cutover.
import {
  applyTransition,
  canonicalizeContractValue,
  compileTaskLifecycleWrite,
  eventObjectTarget,
  isSameExecution,
  isSamePerson,
  lifecycleDocumentPaths,
  taskLifecycleWritePlan,
  validateTaskLifecycleCommandEnvelope,
  type DocEventChange,
  type ExecutionV1,
  type FrozenWritePlan,
  type ProofFor,
  type TaskEventV1,
  type TaskLifecycleCommand,
  type TaskLifecycleSnapshot,
  type WriteOperationReceipt,
  type WriteTarget,
} from "../../kernel/src/index.ts";

export class TaskLifecycleOperationConflict extends Error {
  readonly code: string;
  constructor(message: string, code = "service_rejected") {
    super(message);
    this.name = "TaskLifecycleOperationConflict";
    this.code = code;
  }
}
export type TaskLifecycleKillpoint = "after_sqlite_commit" | "before_response_write" | "after_response_write";
export interface TaskLifecycleServiceRead {
  readonly status: "ready" | "pending";
  readonly snapshot: TaskLifecycleSnapshot;
  readonly packagePath: string | null;
  readonly watermark: number;
  readonly sourceRevision: number;
  readonly warnings: readonly string[];
}
interface EventStorePort {
  readonly readTaskEvent: (opId: string) => TaskEventV1 | null;
  readonly append: (bundle: {
    readonly event: TaskEventV1;
    readonly plan: FrozenWritePlan;
    readonly blobs: readonly {
      readonly sha256: string;
      readonly size: number;
      readonly mediaType: string;
      readonly body: string;
    }[];
  }) => { readonly status: "applied"; readonly revision: number };
}
type Lease = NonNullable<TaskLifecycleSnapshot["lease"]>;
interface ProjectionPort {
  readonly apply: (
    event: TaskEventV1,
    plan?: FrozenWritePlan,
  ) => { readonly metrics: { readonly reducedItems: number } };
  readonly read: (taskId: string) => TaskLifecycleServiceRead;
  readonly readDocument: (path: string) => {
    readonly document: { readonly path: string; readonly body: string; readonly blobSha256: string } | null;
  };
  readonly readTaskOperation: (opId: string) => { readonly event: TaskEventV1; readonly watermark: number } | null;
  readonly currentLease: (taskId: string, now?: string) => Lease | null;
  readonly reserveLease: (lease: Lease, now: string) => Lease;
  readonly activateLease: (lease: Lease) => Lease;
  readonly renewLease: (lease: Lease, expiresAt: string) => Lease;
  readonly releaseLease: (lease: Lease) => Lease;
}
type StartCommand = Extract<TaskLifecycleCommand, { readonly type: "StartExecution" }>;
type RequestedReservation = Pick<Lease, "taskId" | "executionId" | "expiresAt" | "ttlMs"> &
  Partial<Pick<ProofFor<StartCommand>["reservation"], "previousHolder" | "reason" | "version">>;
export type TaskLifecycleServiceProof<C extends TaskLifecycleCommand> = C extends StartCommand
  ? { readonly actorBinding: C["actor"]; readonly reservation: RequestedReservation }
  : ProofFor<C>;
export interface TaskLeaseRenewInput {
  readonly taskId: string;
  readonly executionId: string;
  readonly actor: TaskLifecycleCommand["actor"];
  readonly source: TaskLifecycleCommand["source"];
  readonly expectedVersion: number;
  readonly expiresAt: string;
  readonly opId: string;
  readonly eventId: string;
  readonly workspaceRevision: number;
  readonly occurredAt: string;
}
export interface TaskCarriedDocuments {
  readonly changes: readonly DocEventChange[];
  readonly blobs: readonly {
    readonly sha256: string;
    readonly size: number;
    readonly mediaType: string;
    readonly body: string;
  }[];
}
export interface TaskLifecycleService {
  readonly execute: <C extends TaskLifecycleCommand>(
    command: C,
    proof: TaskLifecycleServiceProof<C>,
  ) => Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot>>;
  readonly executeWithDocuments: <C extends TaskLifecycleCommand>(
    command: C,
    proof: TaskLifecycleServiceProof<C>,
    documents: TaskCarriedDocuments,
  ) => Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot>>;
  readonly read: (taskId: string) => Promise<TaskLifecycleServiceRead>;
  readonly renewLease: (input: TaskLeaseRenewInput) => Promise<Lease>;
}

export function makeTaskLifecycleService(options: {
  readonly eventStore: EventStorePort;
  readonly projection: ProjectionPort;
  readonly killpoint?: (point: TaskLifecycleKillpoint) => void;
}): TaskLifecycleService {
  const read = async (taskId: string) => options.projection.read(taskId);
  const executeInternal = async <C extends TaskLifecycleCommand>(
    command: C,
    proof: TaskLifecycleServiceProof<C>,
    carried: TaskCarriedDocuments | null,
  ): Promise<WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot>> => {
    const issues = validateTaskLifecycleCommandEnvelope(command);
    if (issues.length > 0)
      throw new TaskLifecycleOperationConflict(
        `invalid normalized command envelope: ${issues.map((issue) => issue.message).join("; ")}`,
      );
    const existing = options.eventStore.readTaskEvent(command.opId);
    if (existing !== null) {
      if (!eventMatchesOperation(existing, command, proof as ProofFor<C>, carried))
        throw new TaskLifecycleOperationConflict(`opId ${command.opId} already has a different payload`);
      const plan = taskLifecycleWritePlan(existing);
      if (options.projection.readTaskOperation(command.opId) === null) options.projection.apply(existing, plan);
      return receiptFromRead(await read(command.taskId), existing, plan, existing);
    }
    const current = await read(command.taskId);
    if (current.status !== "ready" && (command.type !== "CreateReplayTask" || current.snapshot.task !== null))
      return {
        outcome: "indeterminate",
        opId: command.opId,
        code: "operation_not_published",
        origin: "N/A",
        snapshot: current.snapshot,
        frozenPlan: Object.freeze({
          commandType: command.type,
          targets: Object.freeze([]),
        }) as unknown as FrozenWritePlan,
        nextAction: "retry task lifecycle read: projection catch-up is pending",
      };
    const claim =
      command.type === "StartExecution"
        ? planClaim(options.projection, command, proof as TaskLifecycleServiceProof<StartCommand>)
        : null;
    const transition = applyTransition(current.snapshot, command, (claim?.proof ?? proof) as ProofFor<C>),
      paths = current.packagePath ? lifecycleDocumentPaths(transition.event, current.packagePath) : [],
      compiled = compileTaskLifecycleWrite({
        event: transition.event,
        snapshot: transition.snapshot,
        packagePath: current.packagePath,
        currentDocuments: paths.flatMap((path) => {
          const document = options.projection.readDocument(path).document;
          return document ? [document] : [];
        }),
      });
    const event =
      carried === null
        ? compiled.event
        : ({
            ...compiled.event,
            payload: { ...compiled.event.payload, carriedDocumentClaims: carried.changes },
          } as TaskEventV1);
    const plan = carried === null ? compiled.plan : taskLifecycleWritePlan(event),
      blobs = carried === null ? compiled.blobs : [...compiled.blobs, ...carried.blobs];
    if (claim !== null) options.projection.reserveLease(claim.reserving, command.occurredAt);
    try {
      plannedPublication(plan, event, () => options.eventStore.append({ event, plan, blobs }));
    } catch (error) {
      if (claim !== null) releaseReservation(options.projection, claim.reserving);
      throw error;
    }
    // The canonical event and all carried blobs are durable at this point; a
    // crash before projection application must be recoverable by replaying the
    // one event, so expose the killpoint before the projection transaction.
    options.killpoint?.("after_sqlite_commit");
    if (claim !== null)
      try {
        const active = options.projection.activateLease(claim.reserving);
        if (json(active) !== json(claim.active))
          throw new TaskLifecycleOperationConflict("lease activation did not match the L1 event");
      } catch (error) {
        return pendingReceipt(
          current,
          plan,
          command.opId,
          message(error),
          event,
          options.eventStore.readTaskEvent(event.opId),
        );
      }
    let applied;
    try {
      applied = planned(plan, projectionTarget(command.taskId), () => options.projection.apply(event, plan));
    } catch (error) {
      return pendingReceipt(
        await read(command.taskId),
        plan,
        command.opId,
        message(error),
        event,
        options.eventStore.readTaskEvent(event.opId),
      );
    }
    if (applied.metrics.reducedItems === 0)
      return pendingReceipt(
        { ...current, sourceRevision: event.workspaceRevision },
        plan,
        command.opId,
        "projection catch-up is pending",
        event,
        options.eventStore.readTaskEvent(event.opId),
      );
    options.killpoint?.("before_response_write");
    const receipt = receiptFromRead(
      await read(command.taskId),
      event,
      plan,
      options.eventStore.readTaskEvent(event.opId),
    );
    options.killpoint?.("after_response_write");
    return receipt;
    // `append` receives the augmented event/plan/blobs as one canonical
    // publication. Keeping this call below the preparation makes the
    // transition and carried documents share one Git commit and one recovery
    // identity.
  };
  return {
    read,
    renewLease: async (input) => renewTaskLease(options, read, input),
    execute: async <C extends TaskLifecycleCommand>(command: C, proof: TaskLifecycleServiceProof<C>) =>
      executeInternal(command, proof, null),
    executeWithDocuments: async <C extends TaskLifecycleCommand>(
      command: C,
      proof: TaskLifecycleServiceProof<C>,
      documents: TaskCarriedDocuments,
    ) => executeInternal(command, proof, documents),
  };
}

async function renewTaskLease(
  options: { readonly eventStore: EventStorePort; readonly projection: ProjectionPort },
  read: (taskId: string) => Promise<TaskLifecycleServiceRead>,
  input: TaskLeaseRenewInput,
): Promise<Lease> {
  const existing = options.eventStore.readTaskEvent(input.opId);
  if (existing !== null) {
    if (!matchesRenewal(existing, input))
      throw new TaskLifecycleOperationConflict(`opId ${input.opId} already has a different payload`);
    if (options.projection.readTaskOperation(input.opId) === null) options.projection.apply(existing);
    const replayed = options.projection.currentLease(input.taskId);
    if (replayed === null) throw new TaskLifecycleOperationConflict(`renewed lease ${input.opId} is not readable`);
    return replayed;
  }
  const current = options.projection.currentLease(input.taskId);
  if (
    current === null ||
    current.phase !== "held" ||
    current.executionId !== input.executionId ||
    !isSameExecution(current.actor, input.actor) ||
    json(current.source) !== json(input.source) ||
    current.version !== input.expectedVersion
  )
    throw new TaskLifecycleOperationConflict(`stale lease CAS for task ${input.taskId}`);
  const state = await read(input.taskId),
    task = state.snapshot.task,
    execution = state.snapshot.executions.find(
      (candidate): candidate is ExecutionV1 =>
        candidate.schema === "execution/v1" && candidate.executionId === input.executionId,
    );
  if (state.status !== "ready" || task === null || execution === undefined)
    throw new TaskLifecycleOperationConflict("lease renewal requires a ready active execution");
  const renewed = { ...current, expiresAt: input.expiresAt, version: current.version + 1 };
  const event: Extract<TaskEventV1, { readonly type: "lease_renewed" }> = {
    schema: "task-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    taskId: input.taskId,
    type: "lease_renewed",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      task,
      execution,
      lease: renewed,
      previousHolder: holder(current),
      leaseExpiresAt: renewed.expiresAt,
      reason: "same_principal_reconnect",
      documentClaims: [],
    },
  };
  const compiled = compileTaskLifecycleWrite({
    event,
    snapshot: state.snapshot,
    packagePath: state.packagePath,
    currentDocuments: [],
  });
  options.eventStore.append(compiled);
  const changed = options.projection.renewLease(current, input.expiresAt);
  if (json(changed) !== json(renewed))
    throw new TaskLifecycleOperationConflict("lease renewal CAS did not match the L1 event");
  options.projection.apply(compiled.event, compiled.plan);
  return changed;
}

function planClaim(
  projection: ProjectionPort,
  command: StartCommand,
  proof: TaskLifecycleServiceProof<StartCommand>,
): { readonly reserving: Lease; readonly active: Lease; readonly proof: ProofFor<StartCommand> } {
  const previous = projection.currentLease(command.taskId, command.occurredAt);
  if (previous?.phase === "held" || previous?.phase === "reserving")
    throw new TaskLifecycleOperationConflict(
      "the current round already has an active execution or lease",
      "invalid_transition",
    );
  const reserving: Lease = {
    schema: "lease/v1",
    taskId: command.taskId,
    executionId: command.executionId,
    actor: command.actor,
    source: command.source,
    phase: "reserving",
    expiresAt: proof.reservation.expiresAt,
    ttlMs: proof.reservation.ttlMs,
    version: previous === null ? 0 : previous.version + 1,
  };
  const active = { ...reserving, phase: "held" as const, version: reserving.version + 1 },
    previousHolder = previous === null ? null : holder(previous);
  const reason =
    previous === null
      ? ("initial_claim" as const)
      : isSamePerson(previous.actor, command.actor)
        ? ("same_principal_reconnect" as const)
        : ("ttl_expired_takeover" as const);
  return {
    reserving,
    active,
    proof: {
      actorBinding: proof.actorBinding,
      reservation: {
        taskId: active.taskId,
        executionId: active.executionId,
        expiresAt: active.expiresAt,
        ttlMs: active.ttlMs,
        previousHolder,
        reason,
        version: active.version,
      },
    },
  };
}
function releaseReservation(projection: ProjectionPort, reservation: Lease): void {
  try {
    projection.releaseLease(reservation);
  } catch (error) {
    consumeKnownError(error);
  }
}
function consumeKnownError(error: unknown): void {
  void error;
}
function holder(lease: Lease): Pick<Lease, "taskId" | "executionId" | "actor" | "source"> {
  return { taskId: lease.taskId, executionId: lease.executionId, actor: lease.actor, source: lease.source };
}
function matchesRenewal(event: TaskEventV1, input: TaskLeaseRenewInput): boolean {
  return (
    event.type === "lease_renewed" &&
    event.taskId === input.taskId &&
    event.payload.execution.executionId === input.executionId &&
    event.payload.lease.version === input.expectedVersion + 1 &&
    event.payload.lease.expiresAt === input.expiresAt &&
    isSameExecution(event.actor, input.actor) &&
    json(event.source) === json(input.source)
  );
}
function eventTargets(opId: string): readonly [WriteTarget, WriteTarget] {
  return [
    { kind: "event_file", path: eventObjectTarget(opId), operation: "create" },
    { kind: "event_head", path: "harness/events/head.json", operation: "replace" },
  ];
}
function projectionTarget(taskId: string): WriteTarget {
  return { kind: "projection_invalidation", projection: "task-lifecycle/v1", key: taskId };
}
function plannedPublication<A>(plan: FrozenWritePlan, event: TaskEventV1, write: () => A): A {
  for (const target of eventTargets(event.opId)) assertWriteTargetDeclared(plan, target);
  return write();
}
function planned<A>(plan: FrozenWritePlan, target: WriteTarget, write: () => A): A {
  assertWriteTargetDeclared(plan, target);
  return write();
}
export function assertWriteTargetDeclared(plan: FrozenWritePlan, target: WriteTarget): void {
  if (
    !Object.isFrozen(plan) ||
    !Object.isFrozen(plan.targets) ||
    !plan.targets.some((candidate) => json(candidate) === json(target))
  )
    throw new TaskLifecycleOperationConflict(`undeclared_write_target: ${json(target)}`);
}
function receiptFromRead(
  read: TaskLifecycleServiceRead,
  event: TaskEventV1,
  plan: FrozenWritePlan,
  published: TaskEventV1 | null,
): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot> {
  const canonicalVisible = samePublishedEvent(published, event);
  return read.status === "ready" && read.watermark >= event.workspaceRevision && canonicalVisible
    ? {
        outcome: "applied",
        opId: event.opId,
        event,
        revision: event.workspaceRevision,
        evidence: `event-object:${event.opId};files:${[...(event.payload.documentClaims ?? []), ...(event.payload.carriedDocumentClaims ?? [])].map((claim) => claim.path).join(",")}`,
        visibility: "center",
        proof: {
          committedRevision: event.workspaceRevision,
          appliedCut: event.workspaceRevision,
          durable: canonicalVisible,
          canonicalVisible,
          worktreeVisible: canonicalVisible,
        },
        snapshot: read.snapshot,
        frozenPlan: plan,
      }
    : pendingReceipt(
        read,
        plan,
        event.opId,
        canonicalVisible ? "projection catch-up is pending" : "canonical event publication is missing",
        event,
        published,
      );
}
function pendingReceipt(
  read: TaskLifecycleServiceRead,
  plan: FrozenWritePlan,
  opId: string,
  reason: string,
  event: TaskEventV1,
  published: TaskEventV1 | null,
): WriteOperationReceipt<TaskEventV1, TaskLifecycleSnapshot> {
  const canonicalVisible = samePublishedEvent(published, event);
  const revision = event.workspaceRevision;
  return {
    outcome: "pending",
    opId,
    event,
    revision,
    evidence: `event-object:${opId}`,
    visibility: "center",
    proof: {
      committedRevision: revision,
      appliedCut: read.watermark,
      durable: canonicalVisible,
      canonicalVisible,
      worktreeVisible: canonicalVisible,
    },
    snapshot: read.snapshot,
    frozenPlan: plan,
    nextAction: `retry task lifecycle read: ${reason}`,
  };
}
function samePublishedEvent(published: TaskEventV1 | null, expected: TaskEventV1): boolean {
  return (
    published !== null &&
    published.eventId === expected.eventId &&
    published.opId === expected.opId &&
    published.workspaceRevision === expected.workspaceRevision
  );
}
function eventMatchesOperation<C extends TaskLifecycleCommand>(
  event: TaskEventV1,
  command: C,
  proof: ProofFor<C>,
  carried: TaskCarriedDocuments | null,
): boolean {
  return (
    json(operationIdentityFromEvent(event)) === json(operationIdentityFromCommand(command, proof)) &&
    json(event.payload.carriedDocumentClaims ?? null) === json(carried?.changes ?? null)
  );
}
function operationIdentityFromCommand<C extends TaskLifecycleCommand>(command: C, proof: ProofFor<C>): unknown {
  const common = {
    type: command.type,
    taskId: command.taskId,
    eventId: command.eventId,
    workspaceRevision: command.workspaceRevision,
    actor: command.actor,
    source: command.source,
    occurredAt: command.occurredAt,
  };
  if (command.type === "CreateReplayTask")
    return {
      ...common,
      title: command.title,
      taskClass: command.taskClass,
      graph: command.graph,
      completionGateIds: command.completionGateIds,
      presetSnapshotDigest: command.presetSnapshotDigest,
    };
  if (command.type === "StartExecution" || command.type === "CompleteTask")
    return { ...common, executionId: command.executionId };
  if (command.type === "TransitionTask")
    return {
      ...common,
      status: command.status,
      reason:
        command.status === "active" && command.reason.trim().length === 0
          ? "Explicit lifecycle transition to active"
          : command.reason,
      ...(command.status === "cancelled" ? { force: command.force } : {}),
    };
  if (command.type === "SubmitExecution")
    return { ...common, executionId: command.executionId, submission: command.submission };
  if (command.type === "RecordReview")
    return {
      ...common,
      executionId: command.executionId,
      reviewId: command.reviewId,
      verdict: command.verdict,
      reason: command.reason,
      evidenceChecked: command.evidenceChecked,
      commitSha: command.commitSha,
      iteration: command.iteration,
      contentDigest: command.contentDigest,
      capabilityRef: (proof as { readonly capabilityRef: string }).capabilityRef,
    };
  if (command.type === "RecordReviewConsent")
    return {
      ...common,
      executionId: command.executionId,
      reviewId: command.reviewId,
      consentId: command.consentId,
      reviewDigest: command.reviewDigest,
      contentDigest: command.contentDigest,
    };
  return {
    ...common,
    executionId: command.executionId,
    witnessId: command.witnessId,
    commitSha: command.commitSha,
    iteration: command.iteration,
    paths: command.paths,
  };
}
function operationIdentityFromEvent(event: TaskEventV1): unknown {
  const type =
    event.type === "task_created"
      ? "CreateReplayTask"
      : event.type === "execution_started"
        ? "StartExecution"
        : event.type === "lease_renewed"
          ? "RenewLease"
          : event.type === "task_transitioned"
            ? "TransitionTask"
            : event.type === "execution_submitted"
              ? "SubmitExecution"
              : event.type === "review_recorded"
                ? "RecordReview"
                : event.type === "review_consent_recorded"
                  ? "RecordReviewConsent"
                  : event.type === "code_doc_reconciled"
                    ? "ReconcileCodeDoc"
                    : "CompleteTask";
  const common = {
    type,
    taskId: event.taskId,
    eventId: event.eventId,
    workspaceRevision: event.workspaceRevision,
    actor: event.actor,
    source: event.source,
    occurredAt: event.occurredAt,
  };
  if (event.type === "task_created")
    return {
      ...common,
      title: event.payload.task.title,
      taskClass: event.payload.task.taskClass,
      graph: event.payload.task.graph,
      completionGateIds: event.payload.task.completionGateIds,
      presetSnapshotDigest: event.payload.task.presetSnapshotDigest,
    };
  if (event.type === "execution_started" || event.type === "task_completed")
    return { ...common, executionId: event.payload.execution.executionId };
  if (event.type === "lease_renewed")
    return { ...common, executionId: event.payload.execution.executionId, expiresAt: event.payload.lease.expiresAt };
  if (event.type === "task_transitioned")
    return {
      ...common,
      status: event.payload.task.status,
      reason: event.payload.mutation.reason,
      ...(event.payload.task.status === "cancelled" ? { force: true } : {}),
    };
  if (event.type === "execution_submitted")
    return {
      ...common,
      executionId: event.payload.execution.executionId,
      submission: event.payload.execution.submission,
    };
  if (event.type === "review_recorded") {
    const review = event.payload.review;
    return {
      ...common,
      executionId: review.executionId,
      reviewId: review.reviewId,
      verdict: review.verdict,
      reason: review.reason,
      evidenceChecked: review.evidenceChecked,
      commitSha: review.commitSha,
      iteration: review.iteration,
      contentDigest: review.contentDigest,
      capabilityRef: review.capabilityRef,
    };
  }
  if (event.type === "review_consent_recorded") {
    const consent = event.payload.consent;
    return {
      ...common,
      executionId: consent.executionId,
      reviewId: consent.reviewId,
      consentId: consent.consentId,
      reviewDigest: consent.reviewDigest,
      contentDigest: consent.contentDigest,
    };
  }
  if (event.type === "code_doc_reconciled") {
    const witness = event.payload.witness;
    return {
      ...common,
      executionId: witness.executionId,
      witnessId: witness.witnessId,
      commitSha: witness.commitSha,
      iteration: witness.iteration,
      paths: witness.paths,
    };
  }
  throw new TaskLifecycleOperationConflict("unsupported lifecycle event");
}
function json(value: unknown): string {
  return JSON.stringify(canonicalizeContractValue(value));
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
