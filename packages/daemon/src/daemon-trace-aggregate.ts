import type { DaemonOperationTrace, DaemonOperationUpdate } from "./daemon-operation.ts";
import {
  countSecondBuckets,
  pruneNodeBuckets,
  pruneSecondBuckets,
  retainedNodeSeconds,
  TRACE_BUCKET_WINDOW_SECONDS,
  type SecondBuckets,
} from "./daemon-trace-buckets.ts";

const SAMPLE_WINDOW_MS = 60_000,
  SAMPLES_PER_METHOD = 1_024,
  MAX_METHODS = 256,
  MAX_NODES = 256,
  MAX_SLOWEST = 16;
interface ActiveOperation {
  readonly method: string;
  repoId: string | null;
  actor: string | null;
  nodeId: string | null;
  phase: string;
  phaseStartedAtMs: number;
  readonly startedAtMs: number;
  traceId: string;
  spanId: string;
  requestBytes: number;
  replyBytes: number;
}
interface Sample {
  readonly endedAtMs: number;
  readonly durationMs: number;
  readonly ok: boolean;
}
interface QueueState {
  queueDepth: number | null;
  atMs: number;
}

/** Main-thread aggregation; one trace snapshot per heartbeat instead of one message per phase. */
export class DaemonTraceAggregate {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly completedByMethod = new Map<string, Sample[]>();
  private readonly perSecond: SecondBuckets = new Map();
  private readonly nodeSecond = new Map<string, SecondBuckets>();
  private readonly writeQueues = new Map<string, QueueState>();
  private readonly slowest: Record<string, unknown>[] = [];
  private readonly counts = new Map<string, { count: number; errors: number }>();
  private completed = 0;
  private errors = 0;

  get inFlightCount(): number {
    return this.active.size;
  }

  begin(
    id: string,
    fields: {
      readonly method: string;
      phase?: string;
      repoId?: string | null;
      actor?: string | null;
      nodeId?: string | null;
      traceId?: string;
      spanId?: string;
      startedAtMs?: number;
      requestBytes?: number;
    },
    force = false,
  ): void {
    if (!force && Number(id) % 5 !== 0) return;
    const startedAtMs = fields.startedAtMs ?? this.now();
    this.active.set(id, {
      method: fields.method,
      repoId: fields.repoId ?? null,
      actor: fields.actor ?? null,
      nodeId: fields.nodeId ?? null,
      phase: fields.phase ?? "started",
      phaseStartedAtMs: startedAtMs,
      startedAtMs,
      traceId: fields.traceId ?? "",
      spanId: fields.spanId ?? "",
      requestBytes: fields.requestBytes ?? 0,
      replyBytes: 0,
    });
  }

  update(id: string, fields: DaemonOperationUpdate): void {
    const operation = this.active.get(id);
    if (!operation) return;
    if (fields.phase !== undefined) {
      operation.phase = fields.phase;
      operation.phaseStartedAtMs = this.now();
    }
    if (fields.repoId !== undefined) operation.repoId = fields.repoId;
    if (fields.actor !== undefined) operation.actor = fields.actor;
    if (fields.nodeId !== undefined) operation.nodeId = fields.nodeId;
    if (fields.requestBytes !== undefined) operation.requestBytes = fields.requestBytes;
    if (fields.replyBytes !== undefined) operation.replyBytes = fields.replyBytes;
  }

  end(id: string, trace: DaemonOperationTrace | undefined, forceSample = false): void {
    const operation = this.active.get(id);
    if (!operation && trace === undefined) return;
    const endedAtMs = trace?.endedAtMs ?? this.now(),
      startedAtMs = operation?.startedAtMs ?? trace?.startedAtMs ?? endedAtMs,
      durationMs = Math.max(0, endedAtMs - startedAtMs),
      ok = (trace?.outcome ?? null) !== "error",
      method = operation?.method ?? trace?.method ?? "<unknown>";
    if (operation) this.active.delete(id);
    const counts = this.counts.get(method) ?? { count: 0, errors: 0 };
    counts.count += 1;
    if (!ok) counts.errors += 1;
    this.counts.set(method, counts);
    // Fast successful requests are sampled for live percentiles; slow and error requests always
    // contribute an exact sample. Counts above remain exact for every request.
    if (forceSample || durationMs >= 1_000 || !ok || Number(id) % 10 === 0) {
      const samples = this.completedByMethod.get(method) ?? [];
      samples.push({ endedAtMs, durationMs, ok });
      if (samples.length > SAMPLES_PER_METHOD) samples.splice(0, samples.length - SAMPLES_PER_METHOD);
      this.completedByMethod.set(method, samples);
      if (this.completedByMethod.size > MAX_METHODS) {
        const oldest = [...this.completedByMethod.entries()].sort(
          (left, right) => (left[1][0]?.endedAtMs ?? 0) - (right[1][0]?.endedAtMs ?? 0),
        )[0];
        if (oldest) this.completedByMethod.delete(oldest[0]);
      }
    }
    const second = Math.floor(endedAtMs / 1_000);
    this.perSecond.set(second, (this.perSecond.get(second) ?? 0) + 1);
    pruneSecondBuckets(this.perSecond, second);
    const nodeId = operation?.nodeId ?? trace?.nodeId ?? "local",
      nodeBuckets = this.nodeSecond.get(nodeId) ?? new Map<number, number>();
    nodeBuckets.set(second, (nodeBuckets.get(second) ?? 0) + 1);
    this.nodeSecond.set(nodeId, nodeBuckets);
    pruneSecondBuckets(nodeBuckets, second);
    this.completed += 1;
    if (!ok) this.errors += 1;
    if (durationMs >= 1_000) {
      this.slowest.push({ method, durationMs, at: new Date().toISOString(), ok, nodeId });
      this.slowest.sort((left, right) => Number(right.durationMs) - Number(left.durationMs));
      if (this.slowest.length > MAX_SLOWEST) this.slowest.length = MAX_SLOWEST;
    }
  }

  setQueues(queues: readonly { readonly repoId: string; readonly queueDepth: number | null }[], atMs: number): void {
    for (const queue of queues) this.writeQueues.set(queue.repoId, { queueDepth: queue.queueDepth, atMs });
  }

  snapshot(): Record<string, unknown> {
    const now = this.now(),
      since = now - SAMPLE_WINDOW_MS,
      nowSecond = Math.floor(now / 1_000);
    pruneSecondBuckets(this.perSecond, nowSecond);
    pruneNodeBuckets(this.nodeSecond, nowSecond);
    return {
      windowMs: SAMPLE_WINDOW_MS,
      requestsPerSecond: {
        last1s: countSecondBuckets(this.perSecond, now - 1_000),
        last5s: Math.round((countSecondBuckets(this.perSecond, now - 5_000) / 5) * 100) / 100,
        last60s: Math.round((countSecondBuckets(this.perSecond, since) / 60) * 100) / 100,
      },
      completed: this.completed,
      errors: this.errors,
      inFlight: this.active.size,
      byMethod: [...this.counts.entries()]
        .flatMap(([method, counts]) => {
          const samples = this.completedByMethod.get(method) ?? [],
            recent = samples.filter((sample) => sample.endedAtMs >= since);
          if (recent.length === 0) return [{ method, count: counts.count, errors: counts.errors, sampled: 0 }];
          return [{ method, count: counts.count, sampled: recent.length, ...percentiles(recent) }];
        })
        .sort((left, right) => right.count - left.count)
        .slice(0, 64),
      byNode: [...this.nodeSecond.entries()]
        .flatMap(([nodeId, seconds]) => {
          const count = countSecondBuckets(seconds, since);
          return count === 0 ? [] : [{ nodeId, requests: count }];
        })
        .sort((left, right) => right.requests - left.requests)
        .slice(0, MAX_NODES),
      writeQueues: [...this.writeQueues.entries()]
        .map(([repoId, state]) => ({ repoId, queueDepth: state.queueDepth, ageMs: Math.max(0, now - state.atMs) }))
        .sort((left, right) => left.repoId.localeCompare(right.repoId)),
      slowest: this.slowest,
      slowThresholdMs: 1_000,
      bucketWindowSeconds: TRACE_BUCKET_WINDOW_SECONDS,
      retainedNodeSeconds: retainedNodeSeconds(this.nodeSecond),
      inFlightOperations: [...this.active.entries()].map(([id, operation]) => ({
        id,
        method: operation.method,
        repoId: operation.repoId,
        actor: operation.actor,
        nodeId: operation.nodeId,
        traceId: operation.traceId,
        spanId: operation.spanId,
        phase: operation.phase,
        startedAt: new Date(operation.startedAtMs).toISOString(),
        elapsedMs: Math.max(0, now - operation.startedAtMs),
        requestBytes: operation.requestBytes,
        replyBytes: operation.replyBytes,
        phases: [{ name: operation.phase, startedAtMs: operation.phaseStartedAtMs, endedAtMs: now }],
      })),
    };
  }

  private now(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}

function percentiles(samples: readonly Sample[]) {
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right),
    at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
  return {
    p50Ms: at(0.5),
    p99Ms: at(0.99),
    maxMs: sorted.at(-1) ?? 0,
    errors: samples.filter((sample) => !sample.ok).length,
  };
}
