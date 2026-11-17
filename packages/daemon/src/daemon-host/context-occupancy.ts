import type { TaskProjection } from "@harness-anything/kernel";
import { dispatchStreamPath, readLatestStreamRecord } from "./dispatch-stream.ts";

/**
 * How full a session's context window currently is, as its provider reports it.
 *
 * This is the only place context fill enters the daemon read model. Both numbers are provider
 * observations, never derived: ACP `usage_update` frames carry `used`/`size`
 * (agentclientprotocol.com/rfds/session-usage), and codex/zcode `result` frames carry
 * `projection.contextUsed`/`projection.contextWindow`. Consumption counters (`inputTokens`,
 * `cacheReadTokens`, …) are cumulative billing totals that re-count the same cached prefix on
 * every turn, so they never stand in for fill level, and no window default is invented for a
 * provider that reports none: absence stays absence.
 */
export type ContextOccupancy = {
  readonly usedTokens: number;
  readonly windowTokens: number;
};

/** The last `usage_update` of a real run sits a few KB before EOF (1.6 KB from the end of a
 * 3.4 MB stream), so the backward scan normally stops inside its first chunk. The 2 MiB bound
 * matches the settled-metrics probe and keeps a pathological stream from an end-to-end scan. */
const occupancyProbeBytes = 2 * 1024 * 1024;

export function readRuntimeSessionContextOccupancy(
  projection: Pick<TaskProjection, "readRuntimeSession" | "readRuntimeDispatch">,
  rootDir: string,
  runtimeSessionId: string,
): ContextOccupancy | null {
  const session = projection.readRuntimeSession(runtimeSessionId);
  if (session === null) return null;
  const dispatch = projection.readRuntimeDispatch(runtimeSessionId, session.definitionSnapshotRef);
  return dispatch === null ? null : readDispatchContextOccupancy(rootDir, dispatch.payload.dispatchId);
}

/** Latest provider-reported fill of one dispatch's stream, or null when the dispatch's provider
 * vocabulary carries no window (or the stream is gone). */
export function readDispatchContextOccupancy(rootDir: string, dispatchId: string): ContextOccupancy | null {
  if (!/^dispatch_[a-f0-9]{24}$/u.test(dispatchId)) return null;
  return readLatestStreamRecord(
    dispatchStreamPath(rootDir, dispatchId),
    occupancyProbeBytes,
    ["provider_event", "runtime_metrics"],
    occupancyOfStreamRecord,
  );
}

/** Occupancy of one persisted stream record, in any of the shapes providers produce. */
export function occupancyOfStreamRecord(value: unknown): ContextOccupancy | null {
  const record = plainRecord(value);
  if (record === null) return null;
  const event = plainRecord(record.event),
    raw = plainRecord(record.raw);
  return (
    occupancyOfUsage(plainRecord(event?.usage)) ??
    occupancyOfUsage(plainRecord(event?.update)) ??
    occupancyOfProjection(plainRecord(event?.projection)) ??
    occupancyOfUsage(raw) ??
    occupancyOfProjection(plainRecord(raw?.projection))
  );
}

/** ACP reports fill as `used` against `size`; the same neutral names survive in `raw`. */
function occupancyOfUsage(usage: Record<string, unknown> | null): ContextOccupancy | null {
  return usage === null
    ? null
    : occupancy(numberValue(usage.used), numberValue(usage.context_size) ?? numberValue(usage.size));
}

function occupancyOfProjection(projection: Record<string, unknown> | null): ContextOccupancy | null {
  return projection === null
    ? null
    : occupancy(numberValue(projection.contextUsed), numberValue(projection.contextWindow));
}

function occupancy(usedTokens: number | null, windowTokens: number | null): ContextOccupancy | null {
  return usedTokens === null || windowTokens === null || windowTokens <= 0 || usedTokens < 0
    ? null
    : { usedTokens, windowTokens };
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
