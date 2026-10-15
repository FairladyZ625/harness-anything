import { runtimeResourceFields } from "./runtime-resource-settings.ts";
import type { RuntimeResourceSample } from "./runtime-resource-sample.ts";

export interface RuntimeResourceLimits {
  readonly minCpuIdle: number;
  readonly minAvailableMemory: number;
  readonly maxConcurrent: number;
}
export function defaultRuntimeResourceLimits(cores: number): RuntimeResourceLimits {
  return {
    minCpuIdle: runtimeResourceFields.minCpuIdlePercent.defaultValue / 100,
    minAvailableMemory: runtimeResourceFields.minAvailableMemoryPercent.defaultValue / 100,
    maxConcurrent: Math.max(1, Math.floor((cores * runtimeResourceFields.concurrentCorePercent.defaultValue) / 100)),
  };
}
export interface RuntimeResourceBlock {
  readonly metric: "sampling" | "cpu" | "memory" | "concurrency";
  readonly observed: number | null;
  readonly threshold: number;
}
export function runtimeResourceBlocks(
  sample: RuntimeResourceSample,
  limits: RuntimeResourceLimits,
  active: number,
): readonly RuntimeResourceBlock[] {
  const blocks: RuntimeResourceBlock[] = [];
  if (sample.cpu === null) blocks.push({ metric: "sampling", observed: null, threshold: limits.minCpuIdle });
  else if (sample.cpu < limits.minCpuIdle)
    blocks.push({ metric: "cpu", observed: sample.cpu, threshold: limits.minCpuIdle });
  if (sample.availableMemoryFraction < limits.minAvailableMemory)
    blocks.push({ metric: "memory", observed: sample.availableMemoryFraction, threshold: limits.minAvailableMemory });
  if (active >= limits.maxConcurrent)
    blocks.push({ metric: "concurrency", observed: active, threshold: limits.maxConcurrent });
  return blocks;
}

export interface RuntimeResourceQueueReason {
  readonly nodeId: string;
  readonly queuedSince: string;
  readonly nextCheckAt: string;
  readonly overdue: boolean;
  readonly blocks: readonly RuntimeResourceBlock[];
}
interface PendingRuntime {
  readonly key: string;
  readonly queuedSince: string;
  readonly start: () => void;
  readonly observe: (reason: RuntimeResourceQueueReason) => void;
}

/** One node owns the reservation from preparation until settlement. A tick grants at most
 * one request, before calling it, so independent repositories cannot share the last slot. */
export function makeRuntimeResourceAdmission(nodeId: string) {
  const active = new Set<string>(),
    pending = new Map<string, PendingRuntime>();
  let closed = false;
  return {
    adopt(key: string): void {
      active.add(key);
    },
    release(key: string): void {
      active.delete(key);
    },
    transfer(from: string, to: string): void {
      if (active.delete(from)) active.add(to);
    },
    enqueue(entry: PendingRuntime): void {
      if (closed) throw new Error("Resource admission is closed");
      if (!pending.has(entry.key) && !active.has(entry.key)) pending.set(entry.key, entry);
    },
    cancel(key: string): boolean {
      return pending.delete(key);
    },
    check(sample: RuntimeResourceSample, limits: RuntimeResourceLimits, now: string): void {
      if (closed) return;
      const first = pending.values().next().value;
      if (first && runtimeResourceBlocks(sample, limits, active.size).length === 0) {
        pending.delete(first.key);
        active.add(first.key);
        first.start();
      }
      for (const entry of pending.values()) {
        entry.observe({
          nodeId,
          queuedSince: entry.queuedSince,
          nextCheckAt: new Date(Date.parse(now) + runtimeResourceFields.sampleIntervalMs.defaultValue).toISOString(),
          overdue: Date.parse(now) - Date.parse(entry.queuedSince) >= runtimeResourceFields.overdueAfterMs.defaultValue,
          blocks: runtimeResourceBlocks(sample, limits, active.size),
        });
      }
    },
    close(): void {
      closed = true;
      pending.clear();
    },
    counts: () => ({ active: active.size, queued: pending.size }),
  };
}
