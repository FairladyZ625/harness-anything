import type { TaskHolderPrincipal } from "./task-holder-state.ts";

interface TaskHolderErrorInput {
  readonly taskId: string;
  readonly principal: TaskHolderPrincipal;
  readonly holder: TaskHolderPrincipal | null;
  readonly leaseExpiresAt: string | null;
  readonly orphan: boolean;
}

export class TaskClaimCollisionError extends Error {
  readonly code: string = "task_claim_collision";
  readonly taskId: string;
  readonly principal: TaskHolderPrincipal;
  readonly holder: TaskHolderPrincipal;
  readonly leaseExpiresAt: string;

  constructor(input: Omit<TaskHolderErrorInput, "holder" | "leaseExpiresAt" | "orphan"> & {
    readonly holder: TaskHolderPrincipal;
    readonly leaseExpiresAt: string;
  }) {
    super(`task ${input.taskId} claim conflicts; ${callerText(input.principal)}; ${holderText(input.holder, input.leaseExpiresAt, false)}; wait for expiry or contact the current holder`);
    this.name = "TaskClaimCollisionError";
    this.taskId = input.taskId;
    this.principal = input.principal;
    this.holder = input.holder;
    this.leaseExpiresAt = input.leaseExpiresAt;
  }
}

export class ExecutionLeaseCollisionError extends TaskClaimCollisionError {
  override readonly code = "execution_lease_collision";
  readonly executionId: string;

  constructor(input: ConstructorParameters<typeof TaskClaimCollisionError>[0] & { readonly executionId: string }) {
    super(input);
    this.name = "ExecutionLeaseCollisionError";
    this.executionId = input.executionId;
  }
}

export class TaskLeaseRequiredError extends Error {
  readonly code = "task_lease_required";
  readonly taskId: string;
  readonly principal: TaskHolderPrincipal;
  readonly holder: TaskHolderPrincipal | null;
  readonly leaseExpiresAt: string | null;
  readonly orphan: boolean;

  constructor(input: TaskHolderErrorInput) {
    const claimCommand = `run 'ha task claim ${input.taskId}'`;
    const next = input.holder
      ? `${claimCommand} if this is your lease; otherwise wait or contact the current holder`
      : `${claimCommand} before retrying`;
    super(`task ${input.taskId} requires an active lease; ${callerText(input.principal)}; ${holderText(input.holder, input.leaseExpiresAt, input.orphan)}; ${next}`);
    this.name = "TaskLeaseRequiredError";
    this.taskId = input.taskId;
    this.principal = input.principal;
    this.holder = input.holder;
    this.leaseExpiresAt = input.leaseExpiresAt;
    this.orphan = input.orphan;
  }
}

export class TaskReleaseNotHolderError extends Error {
  readonly code = "task_release_not_holder";
  readonly taskId: string;
  readonly principal: TaskHolderPrincipal;
  readonly holder: TaskHolderPrincipal | null;
  readonly leaseExpiresAt: string | null;
  readonly orphan: boolean;

  constructor(input: TaskHolderErrorInput) {
    const next = input.holder ? "ask the current holder to release or wait for expiry" : "there is no lease to release";
    super(`task ${input.taskId} is not held by the caller for this release operation; ${callerText(input.principal)}; ${holderText(input.holder, input.leaseExpiresAt, input.orphan)}; ${next}`);
    this.name = "TaskReleaseNotHolderError";
    this.taskId = input.taskId;
    this.principal = input.principal;
    this.holder = input.holder;
    this.leaseExpiresAt = input.leaseExpiresAt;
    this.orphan = input.orphan;
  }
}

function callerText(actor: TaskHolderPrincipal): string {
  return `caller ${actorText(actor)}`;
}

function holderText(holder: TaskHolderPrincipal | null, expiresAt: string | null, orphan: boolean): string {
  if (!holder) return "current holder none; lease status none";
  return `current holder ${actorText(holder)}; lease status ${orphan ? `orphaned, expired at ${expiresAt ?? "unknown"}` : `active, expires at ${expiresAt ?? "unknown"}`}`;
}

function actorText(actor: TaskHolderPrincipal): string {
  return `principal=${actor.principal.personId}, executor=${actor.executor ? `${actor.executor.kind}:${actor.executor.id}` : "none"}`;
}
