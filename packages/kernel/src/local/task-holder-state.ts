// @slice-activation MC-B1 exposes task holder lease runtime state over localRoot for daemon and CLI writer gates.
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { localRuntimeStateFileSystem } from "./local-layout-file-system.ts";
import { taskHolderRecordPath, withTaskHolderMutationLock } from "./task-holder-mutation-lock.ts";
import { listExecutionLeaseRefs } from "./task-holder-state-source.ts";
import { hashExecutionLeaseToken, leaseDurationMs, renewExecutionLeaseCredential, requireExecutionCredential,
  sameExecutionLeaseActor, sameTaskHolderPrincipal } from "./execution-lease-credential.ts";
import {
  emitExecutionLeaseEvents,
  executionLeaseRuntimeEvent,
  type ExecutionLeaseEventSink,
  type ExecutionLeaseRuntimeEvent
} from "./task-holder-lease-events.ts";
import {
  ExecutionLeaseCollisionError,
  TaskClaimCollisionError,
  TaskLeaseRequiredError,
  TaskReleaseNotHolderError
} from "./task-holder-errors.ts";
export { ExecutionLeaseCollisionError, TaskClaimCollisionError, TaskLeaseRequiredError, TaskReleaseNotHolderError } from "./task-holder-errors.ts";

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
  readonly reservationVersion: string;
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

export interface TaskHolderServiceOptions {
  readonly rootInput: HarnessLayoutInput;
  readonly now?: () => Date;
  readonly defaultTtlMs?: number;
  readonly appendLeaseEvent?: ExecutionLeaseEventSink;
}

export interface TaskHolderService {
  readonly claim: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal; readonly ttlMs?: number }) => Promise<TaskHolderClaimResult>;
  readonly holder: (input: { readonly taskId: string }) => Promise<TaskHolderSnapshot>;
  readonly release: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal }) => Promise<TaskHolderReleaseResult>;
  readonly assertActiveLease: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal }) => Promise<void>;
  readonly reserveExecution: (input: { readonly taskId: string; readonly executionId: string; readonly principal: TaskHolderPrincipal; readonly ttlMs?: number }) => Promise<ExecutionLeaseReservation>;
  readonly withExecutionReservation: <Result>(input: {
    readonly taskId: string;
    readonly executionId: string;
    readonly leaseToken: string;
    readonly reservationVersion: string;
    readonly principal: TaskHolderPrincipal;
  }, run: () => Promise<Result>) => Promise<Result>;
  readonly renewExecution: (input: { readonly taskId: string; readonly principal: TaskHolderPrincipal; readonly ttlMs?: number }) => Promise<ExecutionLeaseContext | null>;
  readonly activateExecution: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken: string; readonly principal: TaskHolderPrincipal }) => Promise<ExecutionLeaseContext>;
  readonly releaseExecution: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken?: string; readonly principal: TaskHolderPrincipal }) => Promise<TaskHolderReleaseResult>;
  readonly assertExecutionLease: (input: { readonly taskId: string; readonly executionId: string; readonly leaseToken?: string; readonly principal: TaskHolderPrincipal }) => Promise<void>;
  readonly reconcileExecution: (input: { readonly taskId: string; readonly executionId: string; readonly authoredState: "active" | "submitted" | "missing" }) => Promise<void>;
  readonly executionLeases: () => Promise<ReadonlyArray<Pick<ExecutionLeaseRecord, "taskId" | "executionId">>>;
}

const defaultTtlMs = 24 * 60 * 60 * 1_000;

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
          principal: input.principal,
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
    release: async (input) => {
      const mutation = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const at = now();
        const current = readHolderRecord(options.rootInput, input.taskId);
        const snapshot = holderSnapshot(input.taskId, current, at);
        const callerOwnsHolder = current?.schema === "task-holder/v1"
          ? Boolean(current.holder && sameTaskHolderPrincipal(current.holder, input.principal))
          : Boolean(current?.holder && sameExecutionLeaseActor(current.holder, input.principal));
        if (!current || !current.holder || !callerOwnsHolder) {
          throw new TaskReleaseNotHolderError({
            taskId: input.taskId,
            principal: input.principal,
            holder: current?.holder ?? null,
            leaseExpiresAt: snapshot.leaseExpiresAt,
            orphan: snapshot.orphan
          });
        }
        const releasedAt = at.toISOString();
        const previousHolder = current.holder;
        const record = emptyHolderRecord(input.taskId, releasedAt);
        writeHolderRecord(options.rootInput, record);
        return {
          result: {
            ...holderSnapshot(input.taskId, record, at),
            released: true,
            previousHolder,
            releasedAt
          } satisfies TaskHolderReleaseResult,
          events: current.schema === "task-holder/v2"
            ? [executionLeaseRuntimeEvent(current, "released", "released", { releasedAt, previousHolder })]
            : []
        };
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, mutation.events);
      return mutation.result;
    },
    assertActiveLease: (input) => withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
      const at = now();
      const current = readHolderRecord(options.rootInput, input.taskId);
      const snapshot = holderSnapshot(input.taskId, current, at);
      if (current?.schema === "task-holder/v1" && current.holder && sameTaskHolderPrincipal(current.holder, input.principal)) {
        const updatedAt = at.toISOString();
        writeHolderRecord(options.rootInput, {
          ...current,
          holder: input.principal,
          leaseExpiresAt: new Date(at.getTime() + leaseDurationMs(current, ttl(undefined))).toISOString(),
          updatedAt,
          version: holderVersion(updatedAt)
        });
        return;
      }
      if (snapshot.effectiveHolder && sameTaskHolderPrincipal(snapshot.effectiveHolder, input.principal)) return;
      throw new TaskLeaseRequiredError({
        taskId: input.taskId,
        principal: input.principal,
        holder: current?.holder ?? null,
        leaseExpiresAt: snapshot.leaseExpiresAt,
        orphan: snapshot.orphan
      });
    }),
    reserveExecution: async (input) => {
      const mutation = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const at = now();
        const current = readHolderRecord(options.rootInput, input.taskId);
        const snapshot = holderSnapshot(input.taskId, current, at);
        const upgradesOwnedV1 = current?.schema === "task-holder/v1"
          && current.holder
          && snapshot.effectiveHolder
          && sameTaskHolderPrincipal(current.holder, input.principal);
        if (snapshot.effectiveHolder && !upgradesOwnedV1) {
          throw new ExecutionLeaseCollisionError({
            taskId: input.taskId,
            principal: input.principal,
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
        const previous = current?.schema === "task-holder/v2" && current.leaseExpiresAt && Date.parse(current.leaseExpiresAt) <= at.getTime()
          ? current
          : null;
        const events: ExecutionLeaseRuntimeEvent[] = previous
          ? [executionLeaseRuntimeEvent(previous, "expired", "expired", { previousHolder: previous.holder })]
          : [];
        events.push(executionLeaseRuntimeEvent(record, "reserved", "reserving", {
          previousHolder: previous?.holder ?? (upgradesOwnedV1 ? current.holder : undefined)
        }));
        return {
          result: {
            ...holderSnapshot(input.taskId, record, at),
            executionId: input.executionId,
            leaseToken,
            reservationVersion: record.version,
            phase: "reserving"
          } as ExecutionLeaseReservation,
          events
        };
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, mutation.events);
      return mutation.result;
    },
    withExecutionReservation: async (input, run) => {
      let releaseEvent: ExecutionLeaseRuntimeEvent | null = null;
      try {
        return await withTaskHolderMutationLock(options.rootInput, input.taskId, async () => {
          const acquiredAt = now();
          const reserved = requireExecutionCredential(
            readHolderRecord(options.rootInput, input.taskId),
            input,
            acquiredAt
          );
          if (reserved.phase !== "reserving" || reserved.version !== input.reservationVersion) {
            throw new Error(`execution reservation generation changed: ${input.executionId}`);
          }
          let outcome:
            | { readonly ok: true; readonly value: Awaited<ReturnType<typeof run>> }
            | { readonly ok: false; readonly error: unknown };
          try {
            outcome = { ok: true, value: await run() };
          } catch (error) {
            outcome = { ok: false, error };
          }
          const current = readHolderRecord(options.rootInput, input.taskId);
          if (current?.schema !== "task-holder/v2"
            || current.phase !== "reserving"
            || current.executionId !== input.executionId
            || current.version !== input.reservationVersion
            || current.tokenHash !== hashExecutionLeaseToken(input.leaseToken)
            || !sameExecutionLeaseActor(current.holder, input.principal)) {
            throw new Error(`execution reservation fence changed during transaction: ${input.executionId}`);
          }
          const releasedAt = now().toISOString();
          writeHolderRecord(options.rootInput, emptyHolderRecord(input.taskId, releasedAt));
          releaseEvent = executionLeaseRuntimeEvent(current, "released", "released", {
            releasedAt,
            previousHolder: current.holder
          });
          if (!outcome.ok) throw outcome.error;
          return outcome.value;
        });
      } finally {
        await emitExecutionLeaseEvents(options.appendLeaseEvent, releaseEvent ? [releaseEvent] : []);
      }
    },
    renewExecution: async (input) => {
      const mutation = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const at = now();
        const current = readHolderRecord(options.rootInput, input.taskId);
        if (current?.schema !== "task-holder/v2" || Date.parse(current.leaseExpiresAt) <= at.getTime()) {
          return { result: null, events: [] };
        }
        const leaseDuration = input.ttlMs === undefined
          ? leaseDurationMs(current, ttl(undefined))
          : ttl(input.ttlMs);
        const { record, leaseToken } = renewExecutionLeaseCredential(
          current,
          { principal: input.principal, leaseDurationMs: leaseDuration },
          at
        );
        writeHolderRecord(options.rootInput, record);
        return {
          result: { ...holderSnapshot(input.taskId, record, at), executionId: record.executionId, leaseToken, phase: "active" } as ExecutionLeaseContext,
          events: [executionLeaseRuntimeEvent(record, "renewed", "active")]
        };
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, mutation.events);
      return mutation.result;
    },
    activateExecution: async (input) => {
      const mutation = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const at = now();
        const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, at);
        if (current.phase !== "reserving") throw new Error(`execution lease is not reserving: ${input.executionId}`);
        const record: ExecutionLeaseRecord = { ...current, phase: "active", updatedAt: at.toISOString(), version: holderVersion(at.toISOString()) };
        writeHolderRecord(options.rootInput, record);
        return {
          result: { ...holderSnapshot(input.taskId, record, at), executionId: input.executionId, leaseToken: input.leaseToken, phase: "active" } as ExecutionLeaseContext,
          events: [executionLeaseRuntimeEvent(record, "activated", "active")]
        };
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, mutation.events);
      return mutation.result;
    },
    releaseExecution: async (input) => {
      const mutation = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const at = now();
        const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, at);
        const releasedAt = at.toISOString();
        const record = emptyHolderRecord(input.taskId, releasedAt);
        writeHolderRecord(options.rootInput, record);
        return {
          result: { ...holderSnapshot(input.taskId, record, at), released: true, previousHolder: current.holder, releasedAt } as TaskHolderReleaseResult,
          events: [executionLeaseRuntimeEvent(current, "released", "released", { releasedAt, previousHolder: current.holder })]
        };
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, mutation.events);
      return mutation.result;
    },
    assertExecutionLease: async (input) => {
      const current = requireExecutionCredential(readHolderRecord(options.rootInput, input.taskId), input, now());
      if (current.phase !== "active") throw new Error(`execution lease is not active: ${input.executionId}`);
    },
    reconcileExecution: async (input) => {
      const events = await withTaskHolderMutationLock(options.rootInput, input.taskId, () => {
        const current = readHolderRecord(options.rootInput, input.taskId);
        if (current?.schema !== "task-holder/v2" || current.executionId !== input.executionId) return [];
        const at = now().toISOString();
        if (Date.parse(current.leaseExpiresAt) <= Date.parse(at)) {
          writeHolderRecord(options.rootInput, emptyHolderRecord(input.taskId, at));
          return [executionLeaseRuntimeEvent(current, "expired", "expired", { previousHolder: current.holder })];
        }
        if (input.authoredState === "active") {
          if (current.phase !== "reserving") return [];
          const active: ExecutionLeaseRecord = { ...current, phase: "active", updatedAt: at, version: holderVersion(at) };
          writeHolderRecord(options.rootInput, active);
          return [executionLeaseRuntimeEvent(active, "reconciled", "active")];
        }
        writeHolderRecord(options.rootInput, emptyHolderRecord(input.taskId, at));
        return [executionLeaseRuntimeEvent(current, "reconciled", "released", { releasedAt: at, previousHolder: current.holder })];
      });
      await emitExecutionLeaseEvents(options.appendLeaseEvent, events);
    },
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
  if (input.kind === "system") {
    throw new Error("system actor cannot be projected to a direct-human task holder; use an agent executor with a person principal");
  }
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
  readonly principal: { readonly kind: "person"; readonly personId: string };
  readonly executor: TaskHolderExecutor | null;
} {
  return {
    principal: { kind: "person", personId: input.principal.personId },
    executor: input.executor
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
  const filePath = taskHolderRecordPath(rootInput, taskId);
  if (!localRuntimeStateFileSystem.exists(filePath)) return null;
  const parsed = JSON.parse(localRuntimeStateFileSystem.readText(filePath)) as AnyTaskHolderRecord;
  if ((parsed.schema !== "task-holder/v1" && parsed.schema !== "task-holder/v2") || parsed.taskId !== taskId) {
    throw new Error(`invalid task holder record for ${taskId}`);
  }
  return parsed;
}

function writeHolderRecord(rootInput: HarnessLayoutInput, record: AnyTaskHolderRecord): void {
  const filePath = taskHolderRecordPath(rootInput, record.taskId);
  localRuntimeStateFileSystem.mkdirp(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  localRuntimeStateFileSystem.writeText(tempPath, `${JSON.stringify(record, null, 2)}\n`);
  localRuntimeStateFileSystem.rename(tempPath, filePath);
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

function holderVersion(at: string): string {
  return `${at}-${randomBytes(6).toString("hex")}`;
}
