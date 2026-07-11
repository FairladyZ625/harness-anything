// @slice-activation MC-B1 exposes task holder lease runtime state over localRoot for daemon and CLI writer gates.
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "./local-layout-file-system.ts";
import { listExecutionLeaseRefs } from "./task-holder-state-source.ts";
import { hashExecutionLeaseToken, sameExecutionLeaseActor, sameTaskHolderPrincipal } from "./execution-lease-credential.ts";

export type TaskHolderAcquiredVia = "claim" | "assignment";

export interface TaskHolderCredential {
  readonly kind: string;
  readonly issuer: string;
  readonly subject: string;
}

export interface TaskHolderPersonPrincipal {
  readonly personId: string;
  readonly displayName?: string;
  readonly primaryEmail?: string;
  readonly providerId?: string;
  readonly credential?: TaskHolderCredential;
}

export interface TaskHolderExecutor {
  readonly kind: "agent";
  readonly id: string;
}

export interface TaskHolderPrincipal {
  readonly principal: TaskHolderPersonPrincipal;
  readonly executor: TaskHolderExecutor | null;
  readonly responsibleHuman: string;
}

export interface TaskHolderRecord {
  readonly schema: "task-holder/v1";
  readonly taskId: string;
  readonly holder: TaskHolderPrincipal | null;
  readonly acquiredVia: TaskHolderAcquiredVia | null;
  readonly acquiredAt: string | null;
  readonly leaseExpiresAt: string | null;
  readonly releasedAt: string | null;
  readonly updatedAt: string;
  readonly version: string;
}

export interface ExecutionLeaseRecord {
  readonly schema: "task-holder/v2";
  readonly taskId: string;
  readonly executionId: string;
  readonly phase: "reserving" | "active";
  readonly holder: TaskHolderPrincipal;
  readonly tokenHash: string;
  readonly acquiredVia: "claim";
  readonly acquiredAt: string;
  readonly leaseExpiresAt: string;
  readonly releasedAt: null;
  readonly updatedAt: string;
  readonly version: string;
}

type AnyTaskHolderRecord = TaskHolderRecord | ExecutionLeaseRecord;

export interface TaskHolderSnapshot {
  readonly taskId: string;
  readonly holder: AnyTaskHolderRecord | null;
  readonly effectiveHolder: TaskHolderPrincipal | null;
  readonly leaseExpiresAt: string | null;
  readonly orphan: boolean;
}

export interface ExecutionLeaseReservation extends TaskHolderSnapshot {
  readonly executionId: string;
  readonly leaseToken: string;
  readonly phase: "reserving";
}

export interface ExecutionLeaseContext extends TaskHolderSnapshot {
  readonly executionId: string;
  readonly leaseToken: string;
  readonly phase: "active";
}

export interface TaskHolderClaimResult extends TaskHolderSnapshot {
  readonly acquiredVia: "claim";
  readonly acquiredAt: string;
}

export interface TaskHolderReleaseResult extends TaskHolderSnapshot {
  readonly released: true;
  readonly previousHolder: TaskHolderPrincipal;
  readonly releasedAt: string;
}

export class TaskClaimCollisionError extends Error {
  readonly code: string = "task_claim_collision";
  readonly taskId: string;
  readonly holder: TaskHolderPrincipal;
  readonly leaseExpiresAt: string;

  constructor(input: { readonly taskId: string; readonly holder: TaskHolderPrincipal; readonly leaseExpiresAt: string }) {
    super(`task ${input.taskId} is already claimed by ${input.holder.principal.personId} until ${input.leaseExpiresAt}`);
    this.name = "TaskClaimCollisionError";
    this.taskId = input.taskId;
    this.holder = input.holder;
    this.leaseExpiresAt = input.leaseExpiresAt;
  }
}

export class ExecutionLeaseCollisionError extends TaskClaimCollisionError {
  override readonly code = "execution_lease_collision";
  readonly executionId: string;

  constructor(input: { readonly taskId: string; readonly executionId: string; readonly holder: TaskHolderPrincipal; readonly leaseExpiresAt: string }) {
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

  constructor(input: {
    readonly taskId: string;
    readonly principal: TaskHolderPrincipal;
    readonly holder: TaskHolderPrincipal | null;
    readonly leaseExpiresAt: string | null;
    readonly orphan: boolean;
  }) {
    const current = input.holder
      ? `current holder ${input.holder.principal.personId} until ${input.leaseExpiresAt ?? "unknown"}`
      : input.orphan
        ? "current holder lease is orphaned"
        : "no current holder";
    super(`task ${input.taskId} requires an active lease for ${input.principal.principal.personId}; ${current}`);
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

  constructor(input: {
    readonly taskId: string;
    readonly principal: TaskHolderPrincipal;
    readonly holder: TaskHolderPrincipal | null;
    readonly leaseExpiresAt: string | null;
    readonly orphan: boolean;
  }) {
    const current = input.holder
      ? `current holder ${input.holder.principal.personId} until ${input.leaseExpiresAt ?? "unknown"}`
      : input.orphan
        ? "current holder lease is orphaned"
        : "no current holder";
    super(`task ${input.taskId} is not held by ${input.principal.principal.personId}; ${current}`);
    this.name = "TaskReleaseNotHolderError";
    this.taskId = input.taskId;
    this.principal = input.principal;
    this.holder = input.holder;
    this.leaseExpiresAt = input.leaseExpiresAt;
    this.orphan = input.orphan;
  }
}

export interface TaskHolderServiceOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly now?: () => Date;
  readonly defaultTtlMs?: number;
}

export interface TaskHolderService {
  readonly claim: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal; readonly ttlMs?: number }) => Promise<TaskHolderClaimResult>;
  readonly holder: (input: { readonly taskId: string }) => Promise<TaskHolderSnapshot>;
  readonly release: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal }) => Promise<TaskHolderReleaseResult>;
  readonly assertActiveLease: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal }) => Promise<void>;
  readonly reserveExecution: (input: { readonly taskId: string; readonly executionId: string; readonly principal: TaskHolderPrincipal; readonly ttlMs?: number }) => Promise<ExecutionLeaseReservation>;
  readonly activateExecution: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal }) => Promise<ExecutionLeaseContext>;
  readonly releaseExecution: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal }) => Promise<TaskHolderReleaseResult>;
  readonly assertExecutionLease: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal }) => Promise<void>;
  readonly reconcileExecution: (input: { readonly taskId: string; readonly executionId: string; readonly authoredState: "active" | "submitted" | "missing" }) => Promise<void>;
  readonly executionLeases: () => Promise<ReadonlyArray<Pick<ExecutionLeaseRecord, "taskId" | "executionId">>>;
}

const defaultTtlMs = 30 * 60 * 1_000;

export function makeTaskHolderService(options: TaskHolderServiceOptions): TaskHolderService {
  const now = () => options.now?.() ?? new Date();
  const ttl = (ttlMs: number | undefined) => normalizeTtlMs(ttlMs ?? options.defaultTtlMs ?? defaultTtlMs);

  return {
    claim: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = readHolderRecord(options.rootInput, input.taskId);
      const snapshot = holderSnapshot(input.taskId, current, at);
      if (snapshot.effectiveHolder && !sameTaskHolderPrincipal(snapshot.effectiveHolder, input.principal)) {
        throw new TaskClaimCollisionError({
          taskId: input.taskId,
          holder: snapshot.effectiveHolder,
          leaseExpiresAt: snapshot.leaseExpiresAt ?? ""
        });
      }
      const acquiredAt = at.toISOString();
      const leaseExpiresAt = new Date(at.getTime() + ttl(input.ttlMs)).toISOString();
      const record: TaskHolderRecord = {
        schema: "task-holder/v1",
        taskId: input.taskId,
        holder: input.principal,
        acquiredVia: "claim",
        acquiredAt,
        leaseExpiresAt,
        releasedAt: null,
        updatedAt: acquiredAt,
        version: holderVersion(acquiredAt)
      };
      writeHolderRecord(options.rootInput, record);
      return {
        ...holderSnapshot(input.taskId, record, at),
        acquiredVia: "claim",
        acquiredAt
      } satisfies TaskHolderClaimResult;
    }),
    holder: async (input) => holderSnapshot(input.taskId, readHolderRecord(options.rootInput, input.taskId), now()),
    release: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = readHolderRecord(options.rootInput, input.taskId);
      const snapshot = holderSnapshot(input.taskId, current, at);
      if (current?.schema !== "task-holder/v1" || !snapshot.effectiveHolder || !sameTaskHolderPrincipal(snapshot.effectiveHolder, input.principal)) {
        throw new TaskReleaseNotHolderError({
          taskId: input.taskId,
          principal: input.principal,
          holder: snapshot.effectiveHolder,
          leaseExpiresAt: snapshot.leaseExpiresAt,
          orphan: snapshot.orphan
        });
      }
      const releasedAt = at.toISOString();
      const record: TaskHolderRecord = {
        ...current,
        holder: null,
        acquiredVia: null,
        acquiredAt: null,
        leaseExpiresAt: null,
        releasedAt,
        updatedAt: releasedAt,
        version: holderVersion(releasedAt)
      };
      writeHolderRecord(options.rootInput, record);
      return {
        ...holderSnapshot(input.taskId, record, at),
        released: true,
        previousHolder: snapshot.effectiveHolder,
        releasedAt
      } satisfies TaskHolderReleaseResult;
    }),
    assertActiveLease: async (input) => {
      const snapshot = holderSnapshot(input.taskId, readHolderRecord(options.rootInput, input.taskId), now());
      if (snapshot.effectiveHolder && sameTaskHolderPrincipal(snapshot.effectiveHolder, input.principal)) return;
      throw new TaskLeaseRequiredError({
        taskId: input.taskId,
        principal: input.principal,
        holder: snapshot.effectiveHolder,
        leaseExpiresAt: snapshot.leaseExpiresAt,
        orphan: snapshot.orphan
      });
    },
    reserveExecution: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = readHolderRecord(options.rootInput, input.taskId);
      const snapshot = holderSnapshot(input.taskId, current, at);
      if (snapshot.effectiveHolder) {
        throw new ExecutionLeaseCollisionError({
          taskId: input.taskId,
          executionId: "executionId" in current! ? current.executionId : "unknown",
          holder: snapshot.effectiveHolder,
          leaseExpiresAt: snapshot.leaseExpiresAt ?? ""
        });
      }
      const acquiredAt = at.toISOString();
      const leaseToken = randomBytes(32).toString("hex");
      const record: ExecutionLeaseRecord = {
        schema: "task-holder/v2",
        taskId: input.taskId,
        executionId: input.executionId,
        phase: "reserving",
        holder: input.principal,
        tokenHash: hashExecutionLeaseToken(leaseToken),
        acquiredVia: "claim",
        acquiredAt,
        leaseExpiresAt: new Date(at.getTime() + ttl(input.ttlMs)).toISOString(),
        releasedAt: null,
        updatedAt: acquiredAt,
        version: holderVersion(acquiredAt)
      };
      writeHolderRecord(options.rootInput, record);
      return { ...holderSnapshot(input.taskId, record, at), executionId: input.executionId, leaseToken, phase: "reserving" };
    }),
    activateExecution: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, at);
      if (current.phase !== "reserving") throw new Error(`execution lease is not reserving: ${input.executionId}`);
      const record: ExecutionLeaseRecord = { ...current, phase: "active", updatedAt: at.toISOString(), version: holderVersion(at.toISOString()) };
      writeHolderRecord(options.rootInput, record);
      return { ...holderSnapshot(input.taskId, record, at), executionId: input.executionId, leaseToken: input.leaseToken, phase: "active" };
    }),
    releaseExecution: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, at);
      const releasedAt = at.toISOString();
      const record = emptyHolderRecord(input.taskId, releasedAt);
      writeHolderRecord(options.rootInput, record);
      return { ...holderSnapshot(input.taskId, record, at), released: true, previousHolder: current.holder, releasedAt };
    }),
    assertExecutionLease: async (input) => {
      const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, now());
      if (current.phase !== "active") throw new Error(`execution lease is not active: ${input.executionId}`);
    },
    reconcileExecution: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const current = readHolderRecord(options.rootInput, input.taskId);
      if (current?.schema !== "task-holder/v2" || current.executionId !== input.executionId) return;
      const at = now().toISOString();
      if (input.authoredState === "active") {
        if (current.phase === "reserving") writeHolderRecord(options.rootInput, { ...current, phase: "active", updatedAt: at, version: holderVersion(at) });
        return;
      }
      writeHolderRecord(options.rootInput, emptyHolderRecord(input.taskId, at));
    }),
    executionLeases: async () => listExecutionLeaseRefs(options.rootInput)
  };
}

export function taskHolderPrincipalFromActor(input: {
  readonly personId: string;
  readonly displayName?: string;
  readonly primaryEmail?: string;
  readonly providerId?: string;
  readonly resolvedCredential?: TaskHolderCredential;
}, options: { readonly executor?: TaskHolderExecutor | null } = {}): TaskHolderPrincipal {
  const principal = {
    personId: input.personId,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.primaryEmail ? { primaryEmail: input.primaryEmail } : {}),
    ...(input.providerId ? { providerId: input.providerId } : {}),
    ...(input.resolvedCredential ? { credential: input.resolvedCredential } : {})
  };
  return taskHolderActor(principal, options.executor ?? null);
}

export function taskHolderExecutorFromJournalActor(input: {
  readonly kind: "agent" | "human" | "system";
  readonly id: string;
}): TaskHolderExecutor | null {
  return input.kind === "agent" ? { kind: "agent", id: input.id } : null;
}

export function taskHolderActor(
  principal: TaskHolderPersonPrincipal,
  executor: TaskHolderExecutor | null
): TaskHolderPrincipal {
  return {
    principal,
    executor,
    responsibleHuman: `person:${principal.personId}`
  };
}

export function runtimeEventActorFromTaskHolderPrincipal(input: TaskHolderPrincipal): {
  readonly principal: TaskHolderPersonPrincipal;
  readonly executor: TaskHolderExecutor | null;
  readonly responsibleHuman: string;
} {
  return {
    principal: input.principal,
    executor: input.executor,
    responsibleHuman: input.responsibleHuman
  };
}

export function isTaskHolderError(error: unknown): error is TaskClaimCollisionError | TaskLeaseRequiredError | TaskReleaseNotHolderError {
  return error instanceof TaskClaimCollisionError ||
    error instanceof TaskLeaseRequiredError ||
    error instanceof TaskReleaseNotHolderError;
}

function holderSnapshot(taskId: string, record: AnyTaskHolderRecord | null, at: Date): TaskHolderSnapshot {
  const effective = effectiveHolder(record, at);
  return {
    taskId,
    holder: record,
    effectiveHolder: effective,
    leaseExpiresAt: record?.leaseExpiresAt ?? null,
    orphan: Boolean(record?.holder && record.leaseExpiresAt && !record.releasedAt && !effective)
  };
}

function effectiveHolder(record: AnyTaskHolderRecord | null, at: Date): TaskHolderPrincipal | null {
  if (!record?.holder || !record.leaseExpiresAt || record.releasedAt) return null;
  return Date.parse(record.leaseExpiresAt) > at.getTime() ? record.holder : null;
}

function readHolderRecord(rootInput: HarnessLayoutInput, taskId: string): AnyTaskHolderRecord | null {
  const filePath = holderRecordPath(rootInput, taskId);
  if (!localRuntimeStateFileSystem.exists(filePath)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(filePath)) as AnyTaskHolderRecord;
  if ((parsed.schema !== "task-holder/v1" && parsed.schema !== "task-holder/v2") || parsed.taskId !== taskId) {
    throw new Error(`invalid task holder record for ${taskId}`);
  }
  return parsed;
}

function writeHolderRecord(rootInput: HarnessLayoutInput, record: AnyTaskHolderRecord): void {
  const filePath = holderRecordPath(rootInput, record.taskId);
  localRuntimeStateFileSystem.mkdirp(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  localRuntimeStateFileSystem.writeText(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  localRuntimeStateFileSystem.rename(tempPath, filePath);
}

interface TaskHolderMutationLockRecord {
  readonly schema: "task-holder-mutation-lock/v1";
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
  readonly ownerToken: string;
}

const mutationLockRetryMs = 5;
const mutationLockWaitMs = 5_000;
const mutationLockStaleMs = 30_000;

async function withTaskHolderMutationLock<Result>(
  rootInput: HarnessLayoutInput,
  taskId: string,
  run: () => Result
): Promise<Result> {
  const lockPath = `${holderRecordPath(rootInput, taskId)}.lock`;
  const ownerToken = await acquireTaskHolderMutationLock(lockPath, taskId);
  try {
    return run();
  } finally {
    releaseTaskHolderMutationLock(lockPath, ownerToken);
  }
}

async function acquireTaskHolderMutationLock(lockPath: string, taskId: string): Promise<string> {
  const ownerToken = randomBytes(12).toString("hex");
  const startedAt = Date.now();
  localRuntimeStateFileSystem.mkdirp(path.dirname(lockPath));
  while (Date.now() - startedAt <= mutationLockWaitMs) {
    const record: TaskHolderMutationLockRecord = {
      schema: "task-holder-mutation-lock/v1",
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      ownerToken
    };
    if (localRuntimeStateFileSystem.createExclusiveText(lockPath, JSON.stringify(record))) return ownerToken;
    recoverAbandonedTaskHolderMutationLock(lockPath);
    await new Promise<void>((resolve) => setTimeout(resolve, mutationLockRetryMs));
  }
  throw new Error(`timed out waiting for task holder mutation lock: ${taskId}`);
}

function recoverAbandonedTaskHolderMutationLock(lockPath: string): void {
  const record = readTaskHolderMutationLock(lockPath);
  const modifiedAtMs = record ? null : readTaskHolderMutationLockModifiedAtMs(lockPath);
  const acquiredAtMs = record ? Date.parse(record.acquiredAt) : modifiedAtMs;
  if (acquiredAtMs === null) return;
  const ageMs = Date.now() - acquiredAtMs;
  const abandoned = record?.hostname === hostname()
    ? !processIsAlive(record.pid)
    : Number.isFinite(ageMs) && ageMs > mutationLockStaleMs;
  if (!abandoned) return;
  const quarantinePath = `${lockPath}.stale.${randomBytes(6).toString("hex")}`;
  try {
    localRuntimeStateFileSystem.rename(lockPath, quarantinePath);
    localRuntimeStateFileSystem.remove(quarantinePath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

function readTaskHolderMutationLockModifiedAtMs(lockPath: string): number | null {
  try {
    return localRuntimeStateFileSystem.modifiedAtMs(lockPath);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function releaseTaskHolderMutationLock(lockPath: string, ownerToken: string): void {
  const record = readTaskHolderMutationLock(lockPath);
  if (record?.ownerToken === ownerToken) localRuntimeStateFileSystem.remove(lockPath);
}

function readTaskHolderMutationLock(lockPath: string): TaskHolderMutationLockRecord | null {
  try {
    const parsed = JSON.parse(localRuntimeStateFileSystem.readText(lockPath)) as Partial<TaskHolderMutationLockRecord>;
    return parsed.schema === "task-holder-mutation-lock/v1" &&
      typeof parsed.pid === "number" &&
      typeof parsed.hostname === "string" &&
      typeof parsed.acquiredAt === "string" &&
      typeof parsed.ownerToken === "string"
      ? parsed as TaskHolderMutationLockRecord
      : null;
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return null;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isMissingProcessError(error);
  }
}

function isMissingFileError(error: unknown): boolean {
  return isNodeErrorCode(error, "ENOENT");
}

function isMissingProcessError(error: unknown): boolean {
  return isNodeErrorCode(error, "ESRCH");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function holderRecordPath(rootInput: HarnessLayoutInput, taskId: string): string {
  if (!/^task_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/u.test(taskId)) {
    throw new Error(`invalid task id: ${taskId}`);
  }
  return path.join(resolveHarnessLayout(rootInput).localRoot, "task-holders", `${taskId}.json`);
}

function emptyHolderRecord(taskId: string, at: string): TaskHolderRecord {
  return {
    schema: "task-holder/v1",
    taskId,
    holder: null,
    acquiredVia: null,
    acquiredAt: null,
    leaseExpiresAt: null,
    releasedAt: null,
    updatedAt: at,
    version: holderVersion(at)
  };
}

function normalizeTtlMs(value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error("ttlMs must be a positive number");
  return Math.floor(value);
}

function requireExecutionCredential(
  record: AnyTaskHolderRecord | null,
  input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal },
  at: Date
): ExecutionLeaseRecord {
  const valid = record?.schema === "task-holder/v2" &&
    Date.parse(record.leaseExpiresAt) > at.getTime() &&
    record.executionId === input.executionId &&
    record.tokenHash === hashExecutionLeaseToken(input.leaseToken) &&
    sameExecutionLeaseActor(record.holder, input.principal);
  if (!valid) throw new TaskLeaseRequiredError({
    taskId: input.taskId,
    principal: input.principal,
    holder: effectiveHolder(record, at),
    leaseExpiresAt: record?.leaseExpiresAt ?? null,
    orphan: Boolean(record?.holder && !effectiveHolder(record, at))
  });
  return record;
}

function holderVersion(at: string): string {
  return `${at}-${randomBytes(6).toString("hex")}`;
}
