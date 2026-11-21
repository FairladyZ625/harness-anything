import type { RepoCellAttachmentState } from "./operational-status.ts";

export const PROMETHEUS_TEXT_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8" as const;

export const DEFAULT_RPC_LATENCY_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

export const PROMETHEUS_METRIC_NAMES = Object.freeze({
  daemonUp: "ha_daemon_up",
  daemonUptimeSeconds: "ha_daemon_uptime_seconds",
  daemonBuildInfo: "ha_daemon_build_info",
  processResidentMemoryBytes: "ha_daemon_process_resident_memory_bytes",
  processHeapUsedBytes: "ha_daemon_process_heap_used_bytes",
  reposLoaded: "ha_daemon_repos_loaded",
  writeQueueDepth: "ha_daemon_write_queue_depth",
  writeQueueDepthTotal: "ha_daemon_write_queue_depth_total",
  rpcRequestsTotal: "ha_daemon_rpc_requests_total",
  rpcInflight: "ha_daemon_rpc_inflight",
  rpcDurationSeconds: "ha_daemon_rpc_duration_seconds",
  rpcLatencyQuantileSeconds: "ha_daemon_rpc_latency_quantile_seconds",
  runtimeSessionsActive: "ha_daemon_runtime_sessions_active",
  fleetCenterEnabled: "ha_daemon_fleet_center_enabled",
  fleetConnectionsActive: "ha_daemon_fleet_connections_active",
  fleetNodesConnected: "ha_daemon_fleet_nodes_connected",
  fleetReplicationStreamsActive: "ha_daemon_fleet_replication_streams_active",
  fleetDeliveriesPending: "ha_daemon_fleet_deliveries_pending",
  projectionWatermark: "ha_daemon_projection_watermark",
  ledgerRevision: "ha_daemon_ledger_revision",
  projectionLagRevisions: "ha_daemon_projection_lag_revisions",
  projectionLagRevisionsMax: "ha_daemon_projection_lag_revisions_max",
});

export interface RepoMetricsSnapshot {
  readonly repoId: string;
  readonly state: RepoCellAttachmentState;
  readonly queueDepth: number | null;
  readonly projectionWatermark: number | null;
  readonly ledgerRevision: number | null;
}

export interface RepoMetricsAggregates {
  readonly stateCounts: {
    readonly attached: number;
    readonly warming: number;
    readonly unavailable: number;
  };
  readonly totalQueueDepth: number;
  readonly maxProjectionLag: number;
}

export interface FleetMetricsSnapshot {
  readonly centerEnabled: boolean;
  readonly activeConnections: number;
  readonly authenticatedNodes: number;
  readonly replicationStreams: number;
  readonly pendingDeliveries: number;
}

export interface RpcHistogramBucket {
  readonly le: number;
  readonly count: number;
}

export interface RpcLatencyQuantiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface RpcMetricsSnapshot {
  readonly requestsOk: number;
  readonly requestsError: number;
  readonly inflight: number;
  readonly durationBuckets: readonly RpcHistogramBucket[];
  readonly durationSumSeconds: number;
  readonly durationCount: number;
  readonly quantiles: RpcLatencyQuantiles;
}

export interface DaemonMetricsSnapshot {
  readonly daemonId: string;
  readonly version: string;
  readonly commit: string;
  readonly uptimeSeconds: number;
  readonly processResidentMemoryBytes: number;
  readonly processHeapUsedBytes: number;
  readonly activeRuntimeSessions: number;
  readonly rpc: RpcMetricsSnapshot;
  readonly fleet: FleetMetricsSnapshot;
  readonly repos: readonly RepoMetricsSnapshot[];
  /** Optional event-maintained O(1) repository aggregates so scrapes never re-aggregate across repos. */
  readonly repoAggregates?: RepoMetricsAggregates;
  /** When true, snapshot.repos is guaranteed pre-sorted by repoId so formatter skips order verification. */
  readonly reposPresorted?: boolean;
}

export interface RpcMetricsAccumulator {
  readonly observeDuration: (durationSeconds: number, ok: boolean) => void;
  readonly snapshot: (inflight: number) => RpcMetricsSnapshot;
}

const DEFAULT_QUANTILE_WINDOW_SIZE = 256;

export function createRpcMetricsAccumulator(options?: {
  readonly buckets?: readonly number[];
  readonly quantileWindowSize?: number;
}): RpcMetricsAccumulator {
  const buckets = normalizeBuckets(options?.buckets ?? DEFAULT_RPC_LATENCY_BUCKETS_SECONDS);
  const windowSize = normalizeWindowSize(options?.quantileWindowSize ?? DEFAULT_QUANTILE_WINDOW_SIZE);
  const bucketCounts = new Array<number>(buckets.length).fill(0);
  const ring = new Float64Array(windowSize);

  let requestsOk = 0;
  let requestsError = 0;
  let durationSumSeconds = 0;
  let durationCount = 0;
  let ringCursor = 0;
  let ringFilled = 0;

  return {
    observeDuration: (durationSeconds, ok) => {
      if (ok) requestsOk += 1;
      else requestsError += 1;

      if (!Number.isFinite(durationSeconds)) return;
      const clamped = durationSeconds < 0 ? 0 : durationSeconds;
      durationSumSeconds += clamped;
      durationCount += 1;
      for (let index = 0; index < buckets.length; index += 1) {
        if (clamped <= buckets[index]!) bucketCounts[index] = bucketCounts[index]! + 1;
      }
      ring[ringCursor] = clamped;
      ringCursor = (ringCursor + 1) % windowSize;
      if (ringFilled < windowSize) ringFilled += 1;
    },
    snapshot: (inflight) => {
      const quantiles = computeQuantiles(ring, ringFilled);
      return {
        requestsOk,
        requestsError,
        inflight: safeNonNegative(inflight),
        durationBuckets: buckets.map((le, index) => ({ le, count: bucketCounts[index]! })),
        durationSumSeconds,
        durationCount,
        quantiles,
      };
    },
  };
}

export function formatPrometheusMetrics(snapshot: DaemonMetricsSnapshot): string {
  const lines: string[] = [];
  const sortedRepos = snapshot.reposPresorted ? snapshot.repos : orderedRepos(snapshot.repos);

  pushHeader(lines, PROMETHEUS_METRIC_NAMES.daemonUp, "gauge", "Whether the Harness Anything daemon process is up.");
  pushSample(lines, PROMETHEUS_METRIC_NAMES.daemonUp, undefined, 1);

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.daemonUptimeSeconds,
    "gauge",
    "Monotonic uptime of the daemon process in seconds.",
  );
  pushSample(lines, PROMETHEUS_METRIC_NAMES.daemonUptimeSeconds, undefined, safeNonNegative(snapshot.uptimeSeconds));

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.daemonBuildInfo,
    "gauge",
    "Static build identity of the running daemon instance.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.daemonBuildInfo,
    [
      ["daemon_id", snapshot.daemonId],
      ["version", snapshot.version],
      ["commit", snapshot.commit],
    ],
    1,
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.processResidentMemoryBytes,
    "gauge",
    "Resident set size (RSS) of the daemon process in bytes.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.processResidentMemoryBytes,
    undefined,
    safeNonNegative(snapshot.processResidentMemoryBytes),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.processHeapUsedBytes,
    "gauge",
    "V8 heap memory currently used by the daemon process in bytes.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.processHeapUsedBytes,
    undefined,
    safeNonNegative(snapshot.processHeapUsedBytes),
  );

  let stateCounts: { attached: number; warming: number; unavailable: number };
  let totalQueueDepth: number;
  if (snapshot.repoAggregates) {
    stateCounts = {
      attached: safeNonNegative(snapshot.repoAggregates.stateCounts.attached),
      warming: safeNonNegative(snapshot.repoAggregates.stateCounts.warming),
      unavailable: safeNonNegative(snapshot.repoAggregates.stateCounts.unavailable),
    };
    totalQueueDepth = safeNonNegative(snapshot.repoAggregates.totalQueueDepth);
  } else {
    stateCounts = { attached: 0, warming: 0, unavailable: 0 };
    totalQueueDepth = 0;
    for (const repo of sortedRepos) {
      if (repo.state === "attached" || repo.state === "warming" || repo.state === "unavailable") {
        stateCounts[repo.state] += 1;
      }
      if (repo.queueDepth !== null && Number.isFinite(repo.queueDepth)) {
        totalQueueDepth += Math.max(0, repo.queueDepth);
      }
    }
  }

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.reposLoaded,
    "gauge",
    "Number of repositories currently tracked in daemon memory by state.",
  );
  for (const state of ["attached", "warming", "unavailable"] as const) {
    pushSample(lines, PROMETHEUS_METRIC_NAMES.reposLoaded, [["state", state]], stateCounts[state]);
  }

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.writeQueueDepth,
    "gauge",
    "Current single-writer queue depth per loaded repository.",
  );
  for (const repo of sortedRepos) {
    if (repo.queueDepth === null) continue;
    pushSample(
      lines,
      PROMETHEUS_METRIC_NAMES.writeQueueDepth,
      [
        ["repo_id", repo.repoId],
        ["state", repo.state],
      ],
      safeNonNegative(repo.queueDepth),
    );
  }

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.writeQueueDepthTotal,
    "gauge",
    "Total pending single-writer queue depth across all loaded repositories.",
  );
  pushSample(lines, PROMETHEUS_METRIC_NAMES.writeQueueDepthTotal, undefined, totalQueueDepth);

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcRequestsTotal,
    "counter",
    "Total completed daemon RPC requests partitioned by outcome.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcRequestsTotal,
    [["outcome", "ok"]],
    safeNonNegative(snapshot.rpc.requestsOk),
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcRequestsTotal,
    [["outcome", "error"]],
    safeNonNegative(snapshot.rpc.requestsError),
  );

  pushHeader(lines, PROMETHEUS_METRIC_NAMES.rpcInflight, "gauge", "Number of daemon RPC requests currently in flight.");
  pushSample(lines, PROMETHEUS_METRIC_NAMES.rpcInflight, undefined, safeNonNegative(snapshot.rpc.inflight));

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcDurationSeconds,
    "histogram",
    "Histogram of daemon RPC request durations in seconds.",
  );
  const bucketName = `${PROMETHEUS_METRIC_NAMES.rpcDurationSeconds}_bucket`;
  let previousCount = 0;
  for (const bucket of snapshot.rpc.durationBuckets) {
    const monotonicCount = Math.max(previousCount, safeNonNegative(bucket.count));
    previousCount = monotonicCount;
    pushSample(lines, bucketName, [["le", formatFloat(bucket.le)]], monotonicCount);
  }
  const totalCount = Math.max(previousCount, safeNonNegative(snapshot.rpc.durationCount));
  pushSample(lines, bucketName, [["le", "+Inf"]], totalCount);
  pushSample(
    lines,
    `${PROMETHEUS_METRIC_NAMES.rpcDurationSeconds}_sum`,
    undefined,
    safeNonNegative(snapshot.rpc.durationSumSeconds),
  );
  pushSample(lines, `${PROMETHEUS_METRIC_NAMES.rpcDurationSeconds}_count`, undefined, totalCount);

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcLatencyQuantileSeconds,
    "gauge",
    "Recent bounded-window RPC latency quantiles in seconds.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcLatencyQuantileSeconds,
    [["quantile", "0.5"]],
    safeNonNegative(snapshot.rpc.quantiles.p50),
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcLatencyQuantileSeconds,
    [["quantile", "0.95"]],
    safeNonNegative(snapshot.rpc.quantiles.p95),
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.rpcLatencyQuantileSeconds,
    [["quantile", "0.99"]],
    safeNonNegative(snapshot.rpc.quantiles.p99),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.runtimeSessionsActive,
    "gauge",
    "Active agent runtime sessions tracked in daemon memory.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.runtimeSessionsActive,
    undefined,
    safeNonNegative(snapshot.activeRuntimeSessions),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetCenterEnabled,
    "gauge",
    "Whether the Fleet TLS center listener is active (1) or disabled (0).",
  );
  pushSample(lines, PROMETHEUS_METRIC_NAMES.fleetCenterEnabled, undefined, snapshot.fleet.centerEnabled ? 1 : 0);

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetConnectionsActive,
    "gauge",
    "Active Fleet TLS socket connections currently held by the center.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetConnectionsActive,
    undefined,
    safeNonNegative(snapshot.fleet.activeConnections),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetNodesConnected,
    "gauge",
    "Authenticated Fleet edge nodes currently connected to the center.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetNodesConnected,
    undefined,
    safeNonNegative(snapshot.fleet.authenticatedNodes),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetReplicationStreamsActive,
    "gauge",
    "Active Fleet replication streams currently served by the center.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetReplicationStreamsActive,
    undefined,
    safeNonNegative(snapshot.fleet.replicationStreams),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetDeliveriesPending,
    "gauge",
    "Pending Fleet center command deliveries awaiting settlement.",
  );
  pushSample(
    lines,
    PROMETHEUS_METRIC_NAMES.fleetDeliveriesPending,
    undefined,
    safeNonNegative(snapshot.fleet.pendingDeliveries),
  );

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.projectionWatermark,
    "gauge",
    "Latest projected event revision watermark per attached repository.",
  );
  for (const repo of sortedRepos) {
    if (repo.projectionWatermark === null) continue;
    pushSample(
      lines,
      PROMETHEUS_METRIC_NAMES.projectionWatermark,
      [["repo_id", repo.repoId]],
      safeNonNegative(repo.projectionWatermark),
    );
  }

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.ledgerRevision,
    "gauge",
    "Latest canonical ledger head revision per attached repository.",
  );
  for (const repo of sortedRepos) {
    if (repo.ledgerRevision === null) continue;
    pushSample(
      lines,
      PROMETHEUS_METRIC_NAMES.ledgerRevision,
      [["repo_id", repo.repoId]],
      safeNonNegative(repo.ledgerRevision),
    );
  }

  const hasPrecomputedMaxLag = snapshot.repoAggregates !== undefined;
  let maxLag = hasPrecomputedMaxLag ? safeNonNegative(snapshot.repoAggregates!.maxProjectionLag) : 0;
  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.projectionLagRevisions,
    "gauge",
    "Projection lag in revisions (max(0, ledger_revision - projection_watermark)) per repository.",
  );
  for (const repo of sortedRepos) {
    if (repo.projectionWatermark === null || repo.ledgerRevision === null) continue;
    const lag = Math.max(0, safeNonNegative(repo.ledgerRevision) - safeNonNegative(repo.projectionWatermark));
    if (!hasPrecomputedMaxLag && lag > maxLag) maxLag = lag;
    pushSample(lines, PROMETHEUS_METRIC_NAMES.projectionLagRevisions, [["repo_id", repo.repoId]], lag);
  }

  pushHeader(
    lines,
    PROMETHEUS_METRIC_NAMES.projectionLagRevisionsMax,
    "gauge",
    "Maximum projection lag in revisions across all loaded repositories.",
  );
  pushSample(lines, PROMETHEUS_METRIC_NAMES.projectionLagRevisionsMax, undefined, maxLag);

  return `${lines.join("\n")}\n`;
}

function orderedRepos(repos: readonly RepoMetricsSnapshot[]): readonly RepoMetricsSnapshot[] {
  for (let index = 1; index < repos.length; index += 1) {
    if (repos[index - 1]!.repoId > repos[index]!.repoId) {
      return [...repos].sort((left, right) => (left.repoId < right.repoId ? -1 : left.repoId > right.repoId ? 1 : 0));
    }
  }
  return repos;
}

function normalizeBuckets(buckets: readonly number[]): readonly number[] {
  const cleaned = buckets.filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right);
  const unique: number[] = [];
  for (const value of cleaned) {
    if (unique.length === 0 || unique.at(-1) !== value) unique.push(value);
  }
  return unique.length > 0 ? unique : DEFAULT_RPC_LATENCY_BUCKETS_SECONDS;
}

function normalizeWindowSize(size: number): number {
  return Number.isInteger(size) && size > 0 ? size : DEFAULT_QUANTILE_WINDOW_SIZE;
}

function computeQuantiles(ring: Float64Array, filled: number): RpcLatencyQuantiles {
  if (filled <= 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = Array.from(ring.subarray(0, filled)).sort((left, right) => left - right);
  const at = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1));
    return sorted[index] ?? 0;
  };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

function safeNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function escapeHelp(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("\n", "\\n");
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n");
}

function formatFloat(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  if (Object.is(value, -0)) return "0";
  return String(value);
}

function pushHeader(lines: string[], name: string, type: "counter" | "gauge" | "histogram", help: string): void {
  lines.push(`# HELP ${name} ${escapeHelp(help)}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function pushSample(
  lines: string[],
  name: string,
  labels: readonly (readonly [string, string])[] | undefined,
  value: number,
): void {
  if (!labels || labels.length === 0) {
    lines.push(`${name} ${formatFloat(value)}`);
    return;
  }
  const formattedLabels = labels.map(([key, raw]) => `${key}="${escapeLabelValue(raw)}"`).join(",");
  lines.push(`${name}{${formattedLabels}} ${formatFloat(value)}`);
}
