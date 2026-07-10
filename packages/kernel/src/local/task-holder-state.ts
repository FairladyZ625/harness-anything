// @slice-activation MC-B1 exposes task holder lease runtime state over localRoot for daemon and CLI writer gates.
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "./local-layout-file-system.ts";

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

export interface TaskHolderSnapshot {
  readonly taskId: string;
  readonly holder: TaskHolderRecord | null;
  readonly effectiveHolder: TaskHolderPrincipal | null;
  readonly leaseExpiresAt: string | null;
  readonly orphan: boolean;
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
  readonly code = "task_claim_collision";
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
      if (snapshot.effectiveHolder && !samePrincipal(snapshot.effectiveHolder, input.principal)) {
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
      if (!snapshot.effectiveHolder || !samePrincipal(snapshot.effectiveHolder, input.principal)) {
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
        ...(current ?? emptyHolderRecord(input.taskId, releasedAt)),
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
      if (snapshot.effectiveHolder && samePrincipal(snapshot.effectiveHolder, input.principal)) return;
      throw new TaskLeaseRequiredError({
        taskId: input.taskId,
        principal: input.principal,
        holder: snapshot.effectiveHolder,
        leaseExpiresAt: snapshot.leaseExpiresAt,
        orphan: snapshot.orphan
      });
    }
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

function holderSnapshot(taskId: string, record: TaskHolderRecord | null, at: Date): TaskHolderSnapshot {
  const effective = effectiveHolder(record, at);
  return {
    taskId,
    holder: record,
    effectiveHolder: effective,
    leaseExpiresAt: record?.leaseExpiresAt ?? null,
    orphan: Boolean(record?.holder && record.leaseExpiresAt && !record.releasedAt && !effective)
  };
}

function effectiveHolder(record: TaskHolderRecord | null, at: Date): TaskHolderPrincipal | null {
  if (!record?.holder || !record.leaseExpiresAt || record.releasedAt) return null;
  return Date.parse(record.leaseExpiresAt) > at.getTime() ? record.holder : null;
}

function readHolderRecord(rootInput: HarnessLayoutInput, taskId: string): TaskHolderRecord | null {
  const filePath = holderRecordPath(rootInput, taskId);
  if (!localRuntimeStateFileSystem.exists(filePath)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(filePath)) as TaskHolderRecord;
  if (parsed.schema !== "task-holder/v1" || parsed.taskId !== taskId) {
    throw new Error(`invalid task holder record for ${taskId}`);
  }
  return parsed;
}

function writeHolderRecord(rootInput: HarnessLayoutInput, record: TaskHolderRecord): void {
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
  if (!localRuntimeStateFileSystem.exists(lockPath)) return;
  const record = readTaskHolderMutationLock(lockPath);
  const ageMs = Date.now() - (record ? Date.parse(record.acquiredAt) : localRuntimeStateFileSystem.modifiedAtMs(lockPath));
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

function samePrincipal(left: TaskHolderPrincipal, right: TaskHolderPrincipal): boolean {
  return left.principal.personId === right.principal.personId;
}

function holderVersion(at: string): string {
  return `${at}-${randomBytes(6).toString("hex")}`;
}
