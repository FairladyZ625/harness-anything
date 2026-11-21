# Observability, Reproducible Offline Builds, and Helm Deployment

This guide covers the generic operational baseline for running Harness Anything Center in Kubernetes or air-gapped enterprise environments with external PostgreSQL and external OIDC/Keycloak.

## Prometheus metrics and health probes

The daemon provides an opt-in, read-only HTTP server implemented on Node's built-in `node:http` with zero third-party telemetry dependencies. It is disabled by default so local developer daemons do not open TCP listeners.

Enable it via environment variables or CLI flags on `harness-anything-daemon serve`:

| Environment variable | CLI flag | Default | Purpose |
| --- | --- | --- | --- |
| `HARNESS_DAEMON_METRICS_PORT` | `--metrics-port` | unset (disabled) | TCP port (`0..65535`) for `/metrics`, `/healthz`, and `/readyz` |
| `HARNESS_DAEMON_METRICS_BIND` | `--metrics-bind` | `127.0.0.1` | Bind host (`0.0.0.0` inside containers when scraped in-cluster) |
| `HARNESS_DAEMON_METRICS_PATH` | `--metrics-path` | `/metrics` | Scrape path (must start with `/`) |
| `HARNESS_DAEMON_METRICS_BEARER_TOKEN` | — | unset | Optional Bearer token required on `/metrics` (verified with constant-time digest comparison) |

### Endpoints

- `GET /metrics` (`HEAD` allowed): returns Prometheus exposition format (`text/plain; version=0.0.4; charset=utf-8`). All counters, gauges, histograms, and bounded-window latency quantiles are assembled from resident in-memory state in `O(1)` per-scrape work without scanning ledger tables, enumerating directories, or reading `registry.json`.
- `GET /healthz`: returns `200` while the daemon is live and `503` during shutdown.
- `GET /readyz`: returns `200` when the daemon is live and no loaded repository cell is `warming`; otherwise returns `503`.
- Non-`GET`/`HEAD` requests return `405 Method Not Allowed`; unknown routes return `404 Not Found`.

### Exposed metric families

- Process and build: `ha_daemon_up`, `ha_daemon_uptime_seconds`, `ha_daemon_build_info`, `ha_daemon_process_resident_memory_bytes`, `ha_daemon_process_heap_used_bytes`.
- Write queue depth: `ha_daemon_repos_loaded`, `ha_daemon_write_queue_depth`, `ha_daemon_write_queue_depth_total`.
- RPC counters and latency: `ha_daemon_rpc_requests_total`, `ha_daemon_rpc_inflight`, `ha_daemon_rpc_duration_seconds` (`_bucket`, `_sum`, `_count`), `ha_daemon_rpc_latency_quantile_seconds`.
- Runtime sessions: `ha_daemon_runtime_sessions_active`.
- Fleet center connections: `ha_daemon_fleet_center_enabled`, `ha_daemon_fleet_connections_active`, `ha_daemon_fleet_nodes_connected`, `ha_daemon_fleet_replication_streams_active`, `ha_daemon_fleet_deliveries_pending`.
- Projection lag: `ha_daemon_projection_watermark`, `ha_daemon_ledger_revision`, `ha_daemon_projection_lag_revisions`, `ha_daemon_projection_lag_revisions_max`.

## Reproducible offline build verification

`tools/reproducible-build.mjs` builds workspace deliverables from a pinned Git commit inside clean archive trees with `SOURCE_DATE_EPOCH` pinned to the commit timestamp, deterministic USTAR/gzip archive packaging, and sorted SHA-256 manifests (`harness-anything/reproducible-build-manifest/v1`).

```bash
# Build a deterministic bundle from a pre-seeded offline npm cache
node tools/reproducible-build.mjs build \
  --revision HEAD \
  --offline-cache /path/to/npm-cache \
  --out ./out/bundle \
  --archive ./out/bundle.tar.gz

# Run two independent clean builds and verify bit-for-bit digest parity
node tools/reproducible-build.mjs verify \
  --revision HEAD \
  --mirror-node-modules \
  --verify-archive

# Verify an extracted bundle offline against its build-manifest.json
node tools/reproducible-build.mjs verify-manifest \
  --bundle ./out/bundle
```

## Generic Helm Chart

The generic chart at [deploy/helm/harness-center/Chart.yaml](../deploy/helm/harness-center/Chart.yaml) targets external PostgreSQL (see [PostgreSQL daemon deployment](postgres-daemon.md)) and external OIDC/Keycloak (see [Server Daemon operations](operations-server-daemon.md)):

- **Stateless vs. stateful workloads**: set `workloadKind: Deployment` (default) for PostgreSQL-backed stateless centers (`materialize: false`), or `workloadKind: StatefulSet` when persistent per-pod volumes (`volumeClaimTemplates`) are needed.
- **Secret isolation**: database connection strings (`daemon-storage.json`), Fleet TLS keypairs, OIDC client secrets, and optional Prometheus scrape Bearer tokens are mounted exclusively from Kubernetes Secrets referenced by name in `values.yaml`.
- **Kubernetes probes & Prometheus Operator**: wires `/healthz` and `/readyz` probes by default, plus opt-in `ServiceMonitor` (`metrics.serviceMonitor.enabled: true`) and `PrometheusRule` (`metrics.prometheusRule.enabled: true`).
