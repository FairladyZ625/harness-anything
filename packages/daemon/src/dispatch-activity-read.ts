import { latestRuntimeActivityAt } from "@harness-anything/kernel";
import { readDispatchStreamSummary } from "./dispatch-stream.ts";
import { dispatchActivityStatus, dispatchActivityIdleMinutes, providerConnectionFailure } from "./dispatch-activity.ts";
import type { TaskDispatchRow } from "./protocol/task-dispatch-contract.ts";

/**
 * Join the executing node's own dispatch stream into rows served by the center. The center keeps
 * the canonical identity, task and outcome fields; only the evidence that can exist solely on the
 * node that ran the provider is replaced: the live activity judgment, the progress clock, the
 * process fact and the transcript ref. A row whose stream is not on this node is returned untouched,
 * so a plain center read behaves exactly as before.
 */
export function withLocalDispatchStreamEvidence(
  rows: readonly TaskDispatchRow[],
  input: { readonly rootDir: string; readonly nowMs?: number },
): readonly TaskDispatchRow[] {
  const nowMs = input.nowMs ?? Date.now();
  return rows.map((row) => {
    const stream = readDispatchStreamSummary(input.rootDir, row.dispatchId);
    if (stream === null) return row;
    const eventStreamRef = stream.header.eventStreamRef;
    // A submitted implementation waits on the PR/CI/review path; that canonical judgment outranks
    // any provider frame still trickling in locally.
    if (row.status !== "running" || row.activityStatus === "waiting") return { ...row, eventStreamRef };
    const processAlive = row.lifecycle?.policy?.canSteer === true,
      providerUnreachable = providerConnectionFailure(
        {
          lastProgressAt: stream.lastProgressAt,
          providerReconnect: stream.lastProviderReconnect,
          processAlive,
          ...(stream.header.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: stream.header.stallTimeoutMs }),
        },
        nowMs,
      ),
      lastObservedAt = latestRuntimeActivityAt([
        ...(row.lastObservedAt === undefined ? [row.startedAt] : [row.lastObservedAt]),
        stream.lastObservedAt,
      ]),
      activityObservedAt = stream.lastProgressAt,
      { providerUnreachable: _reported, ...rest } = row;
    return {
      ...rest,
      eventStreamRef,
      lastObservedAt,
      activityStatus: dispatchActivityStatus(
        {
          status: row.status,
          taskStatus: undefined,
          role: row.role,
          lastObservedAt: activityObservedAt,
          lastProgressAt: stream.lastProgressAt,
          stallTimeoutMs: stream.header.stallTimeoutMs,
          stalledAt: stream.stalledAt,
          processAlive,
          providerActivity: stream.lastProviderActivity?.kind ?? null,
          providerReconnect: stream.lastProviderReconnect ?? null,
          reportedProviderUnreachable: null,
        },
        nowMs,
      ),
      activityObservedAt,
      activityIdleMinutes: dispatchActivityIdleMinutes(activityObservedAt, nowMs),
      ...(providerUnreachable === null ? {} : { providerUnreachable }),
    };
  });
}
