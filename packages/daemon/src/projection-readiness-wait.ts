import { performance } from "node:perf_hooks";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  isMigrationImportEvent,
  isTaskBootstrapEvent,
  isTaskEvent,
  type CanonicalEventStore,
  type TaskProjection,
} from "../../kernel/src/index.ts";

export const defaultProjectionWaitMs = 30_000;

export interface ProjectionWaitBudget {
  readonly maxWaitMs: number;
  readonly startedAt: number;
}

interface ProjectionCut {
  readonly watermark: number;
  readonly sourceRevision: number;
}

export function isProjectionWaitMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function projectionWaitBudget(maxWaitMs: number): ProjectionWaitBudget {
  return { maxWaitMs, startedAt: performance.now() };
}

export async function waitForProjectionCut<T extends ProjectionCut>(input: {
  readonly budget: ProjectionWaitBudget;
  readonly label: string;
  readonly read: () => T;
  readonly ready?: (read: T) => boolean;
}): Promise<T> {
  const ready = input.ready ?? ((read: T) => read.watermark >= read.sourceRevision);
  for (;;) {
    const read = input.read();
    if (ready(read)) return read;
    const waitedMs = elapsed(input.budget);
    if (waitedMs >= input.budget.maxWaitMs)
      throw projectionWaitError(input.label, read, waitedMs, input.budget.maxWaitMs);
    await yieldToEventLoop();
  }
}

export async function waitForTaskProjection(input: {
  readonly budget: ProjectionWaitBudget;
  readonly projection: TaskProjection;
  readonly store: CanonicalEventStore;
  readonly taskId: string;
  readonly purpose: string;
}): Promise<ReturnType<TaskProjection["read"]>> {
  let canonicalRevision: number | null | undefined;
  return waitForProjectionCut({
    budget: input.budget,
    label: `Task ${input.taskId} package projection for ${input.purpose}`,
    read: () => {
      const read = input.projection.read(input.taskId);
      if (!read.snapshot.task || !read.packagePath) {
        canonicalRevision ??= canonicalTaskRevision(input.store, input.taskId);
        if (canonicalRevision === null)
          throw Object.assign(new Error(`Task ${input.taskId} does not exist in the canonical event stream.`), {
            code: "task_not_found",
          });
        if (read.watermark >= canonicalRevision && read.watermark >= read.sourceRevision)
          throw projectionWaitError(
            `Task ${input.taskId} has a canonical event but no projected package for ${input.purpose}`,
            read,
            elapsed(input.budget),
            input.budget.maxWaitMs,
          );
      }
      return read;
    },
    ready: (read) => read.watermark >= read.sourceRevision && read.snapshot.task !== null && read.packagePath !== null,
  });
}

export async function waitForOptionalTaskProjection(input: {
  readonly invalidWait: (message: string) => Error;
  readonly projection: TaskProjection;
  readonly purpose: string;
  readonly store: CanonicalEventStore;
  readonly taskId: string | null;
  readonly waitProjectionMs: unknown;
}): Promise<ReturnType<TaskProjection["read"]> | null> {
  const waitProjectionMs = input.waitProjectionMs ?? defaultProjectionWaitMs;
  if (!isProjectionWaitMs(waitProjectionMs))
    throw input.invalidWait("waitProjectionMs must be a non-negative safe integer number of milliseconds.");
  return input.taskId
    ? waitForTaskProjection({
        budget: projectionWaitBudget(waitProjectionMs),
        projection: input.projection,
        store: input.store,
        taskId: input.taskId,
        purpose: input.purpose,
      })
    : null;
}

export function canonicalTaskRevision(store: CanonicalEventStore, taskId: string): number | null {
  let revision: number | null = null;
  for (const event of store.read().events) {
    const matches =
      (isTaskEvent(event) && event.taskId === taskId) ||
      (isTaskBootstrapEvent(event) && event.taskId === taskId) ||
      (isMigrationImportEvent(event) &&
        event.payload.entity.kind === "task" &&
        event.payload.entity.task.taskId === taskId);
    if (matches) revision = Math.max(revision ?? 0, event.workspaceRevision);
  }
  return revision;
}

function projectionWaitError(label: string, cut: ProjectionCut, waitedMs: number, maxWaitMs: number): Error {
  const rounded = Math.ceil(waitedMs);
  return Object.assign(
    new Error(
      `${label} did not become ready within ${String(maxWaitMs)} ms: ` +
        `watermark ${String(cut.watermark)}, source revision ${String(cut.sourceRevision)}, ` +
        `waited ${String(rounded)} ms.`,
    ),
    {
      code: "content_not_ready",
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
      waitedMs: rounded,
    },
  );
}

function elapsed(budget: ProjectionWaitBudget): number {
  return Math.max(0, performance.now() - budget.startedAt);
}
