// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RPC_LATENCY_BUCKETS_SECONDS,
  PROMETHEUS_METRIC_NAMES,
  PROMETHEUS_TEXT_CONTENT_TYPE,
  createRpcMetricsAccumulator,
  formatPrometheusMetrics,
  type DaemonMetricsSnapshot,
} from "../../src/domain/prometheus-metrics.ts";

const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;
const LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;

function parsePrometheusText(body: string): {
  readonly help: Map<string, string>;
  readonly types: Map<string, string>;
  readonly samples: { readonly name: string; readonly labels: string; readonly value: string }[];
} {
  const help = new Map<string, string>();
  const types = new Map<string, string>();
  const samples: { readonly name: string; readonly labels: string; readonly value: string }[] = [];

  for (const line of body.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# HELP ")) {
      const rest = line.slice("# HELP ".length);
      const space = rest.indexOf(" ");
      assert.ok(space > 0, `invalid HELP line: ${line}`);
      const name = rest.slice(0, space);
      assert.ok(!help.has(name), `duplicate HELP for ${name}`);
      assert.match(name, METRIC_NAME_PATTERN);
      help.set(name, rest.slice(space + 1));
      continue;
    }
    if (line.startsWith("# TYPE ")) {
      const parts = line.slice("# TYPE ".length).split(" ");
      assert.equal(parts.length, 2, `invalid TYPE line: ${line}`);
      const [name, kind] = parts as [string, string];
      assert.ok(!types.has(name), `duplicate TYPE for ${name}`);
      assert.match(name, METRIC_NAME_PATTERN);
      assert.ok(["counter", "gauge", "histogram", "summary", "untyped"].includes(kind), `invalid metric type: ${kind}`);
      types.set(name, kind);
      continue;
    }
    assert.ok(!line.startsWith("#"), `unexpected comment line: ${line}`);
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)$/u.exec(line);
    assert.ok(match, `invalid Prometheus sample line: ${line}`);
    const [, name, rawLabels = "", value] = match as unknown as [string, string, string, string];
    if (rawLabels) {
      const inner = rawLabels.slice(1, -1);
      const labelRe = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"(?:,|$)/gu;
      let consumed = 0;
      for (const m of inner.matchAll(labelRe)) {
        assert.equal(m.index, consumed, `malformed label syntax in ${line}`);
        assert.match(m[1]!, LABEL_NAME_PATTERN);
        consumed += m[0].length;
      }
      assert.equal(consumed, inner.length, `unparsed label remainder in ${line}`);
    }
    assert.ok(
      value === "NaN" || value === "+Inf" || value === "-Inf" || Number.isFinite(Number(value)),
      `invalid sample value in ${line}`,
    );
    samples.push({ name, labels: rawLabels, value });
  }

  return { help, types, samples };
}

test("PROMETHEUS_TEXT_CONTENT_TYPE follows Prometheus exposition 0.0.4 media type", () => {
  assert.equal(PROMETHEUS_TEXT_CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8");
  assert.ok(DEFAULT_RPC_LATENCY_BUCKETS_SECONDS.length >= 5);
  for (let index = 1; index < DEFAULT_RPC_LATENCY_BUCKETS_SECONDS.length; index += 1) {
    assert.ok(
      DEFAULT_RPC_LATENCY_BUCKETS_SECONDS[index]! > DEFAULT_RPC_LATENCY_BUCKETS_SECONDS[index - 1]!,
      "buckets must be strictly ascending",
    );
  }
});

test("createRpcMetricsAccumulator maintains O(1) bounded histogram and quantile window", () => {
  const acc = createRpcMetricsAccumulator({
    buckets: [0.01, 0.05, 0.25, 1],
    quantileWindowSize: 64,
  });

  for (let i = 1; i <= 1_000; i += 1) {
    // Values cycle through 0.004, 0.02, 0.1, 0.5, 2.0 seconds
    const duration = [0.004, 0.02, 0.1, 0.5, 2.0][i % 5]!;
    acc.observeDuration(duration, i % 10 !== 0);
  }
  acc.observeDuration(-5, true); // negative clamped to 0
  acc.observeDuration(Number.NaN, false); // non-finite ignored for histogram duration, still counted as error

  const snap = acc.snapshot(3);
  assert.equal(snap.inflight, 3);
  assert.equal(snap.requestsOk, 901);
  assert.equal(snap.requestsError, 101);
  assert.equal(snap.durationCount, 1_001);
  assert.equal(snap.durationBuckets.length, 4);
  for (let i = 1; i < snap.durationBuckets.length; i += 1) {
    assert.ok(snap.durationBuckets[i]!.count >= snap.durationBuckets[i - 1]!.count);
  }
  assert.ok(snap.durationBuckets.at(-1)!.count <= snap.durationCount);
  assert.ok(snap.quantiles.p50 <= snap.quantiles.p95);
  assert.ok(snap.quantiles.p95 <= snap.quantiles.p99);
  assert.ok(snap.quantiles.p99 > 0);
});

test("formatPrometheusMetrics renders compliant 0.0.4 text with escaping, deterministic sorting, and lag clamping", () => {
  const rpc = createRpcMetricsAccumulator({ buckets: [0.01, 0.1, 1] });
  rpc.observeDuration(0.005, true);
  rpc.observeDuration(0.05, true);
  rpc.observeDuration(0.8, false);

  const snapshot: DaemonMetricsSnapshot = {
    daemonId: 'center-"prod"\n\\1',
    version: "0.1.0",
    commit: "bb7e55c9",
    uptimeSeconds: 42.5,
    processResidentMemoryBytes: 128_000_000,
    processHeapUsedBytes: 32_000_000,
    activeRuntimeSessions: 4,
    rpc: rpc.snapshot(2),
    fleet: {
      centerEnabled: true,
      activeConnections: 7,
      authenticatedNodes: 5,
      replicationStreams: 6,
      pendingDeliveries: 2,
    },
    repos: [
      {
        repoId: "repo-b",
        state: "attached",
        queueDepth: 3,
        projectionWatermark: 120,
        ledgerRevision: 100, // watermark ahead of revision must clamp lag to 0
      },
      {
        repoId: 'repo-a\\"\n',
        state: "attached",
        queueDepth: 5,
        projectionWatermark: 90,
        ledgerRevision: 115,
      },
      {
        repoId: "repo-c",
        state: "warming",
        queueDepth: null,
        projectionWatermark: null,
        ledgerRevision: null,
      },
    ],
  };

  const rendered = formatPrometheusMetrics(snapshot);
  assert.ok(rendered.endsWith("\n"), "exposition must terminate with LF");

  const parsed = parsePrometheusText(rendered);
  for (const name of Object.values(PROMETHEUS_METRIC_NAMES)) {
    assert.ok(parsed.help.has(name), `missing HELP for ${name}`);
    assert.ok(parsed.types.has(name), `missing TYPE for ${name}`);
  }

  // Escaping check
  assert.ok(rendered.includes('daemon_id="center-\\"prod\\"\\n\\\\1"'));
  assert.ok(rendered.includes('repo_id="repo-a\\\\\\"\\n"'));

  // Deterministic ordering by repoId: repo-a comes before repo-b
  const repoAIndex = rendered.indexOf('ha_daemon_write_queue_depth{repo_id="repo-a');
  const repoBIndex = rendered.indexOf('ha_daemon_write_queue_depth{repo_id="repo-b"');
  assert.ok(repoAIndex > 0 && repoBIndex > repoAIndex, "repos must be sorted deterministically");

  // Totals & lag clamping
  assert.ok(rendered.includes("ha_daemon_write_queue_depth_total 8\n"));
  assert.ok(rendered.includes('ha_daemon_projection_lag_revisions{repo_id="repo-a\\\\\\"\\n"} 25\n'));
  assert.ok(rendered.includes('ha_daemon_projection_lag_revisions{repo_id="repo-b"} 0\n'));
  assert.ok(rendered.includes("ha_daemon_projection_lag_revisions_max 25\n"));

  // Histogram monotonicity & +Inf
  assert.ok(rendered.includes('ha_daemon_rpc_duration_seconds_bucket{le="0.01"} 1\n'));
  assert.ok(rendered.includes('ha_daemon_rpc_duration_seconds_bucket{le="0.1"} 2\n'));
  assert.ok(rendered.includes('ha_daemon_rpc_duration_seconds_bucket{le="1"} 3\n'));
  assert.ok(rendered.includes('ha_daemon_rpc_duration_seconds_bucket{le="+Inf"} 3\n'));
  assert.ok(rendered.includes("ha_daemon_rpc_duration_seconds_count 3\n"));

  // Fleet & runtime gauges
  assert.ok(rendered.includes("ha_daemon_runtime_sessions_active 4\n"));
  assert.ok(rendered.includes("ha_daemon_fleet_center_enabled 1\n"));
  assert.ok(rendered.includes("ha_daemon_fleet_connections_active 7\n"));
  assert.ok(rendered.includes("ha_daemon_fleet_nodes_connected 5\n"));
  assert.ok(rendered.includes("ha_daemon_fleet_replication_streams_active 6\n"));
  assert.ok(rendered.includes("ha_daemon_fleet_deliveries_pending 2\n"));
});
