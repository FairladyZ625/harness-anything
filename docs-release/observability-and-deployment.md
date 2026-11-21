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
| `HARNESS_DAEMON_METRICS_BEARER_TOKEN` | — | unset | Optional Bearer token required on `/metrics` (verified with constant-time digest comparison; responds with RFC 6750 `WWW-Authenticate: Bearer` on `401`) |

### Endpoints

- `GET /metrics` (`HEAD` allowed): returns Prometheus exposition format (`text/plain; version=0.0.4; charset=utf-8`). All counters, gauges, histograms, and bounded-window latency quantiles are assembled in `O(1)` bounded work per loaded repository from resident in-memory state plus a single-row projection watermark read—never scanning ledger tables, enumerating directories, or reading `registry.json`. `ha_daemon_build_info` resolves the installed `@harness-anything/daemon` package version even when launched directly via `node` outside npm.
- `GET /healthz`: returns `200` while the daemon is live and `503` during shutdown or probe failure.
- `GET /readyz`: returns `200` when the daemon is live and no loaded repository cell is `warming`; otherwise returns `503`.
- Collector or probe exceptions are isolated per request, recorded through the daemon diagnostics log, and answered with bounded `500` (`/metrics`) or `503` (`/healthz`, `/readyz`) responses without terminating the daemon.
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
- **External OIDC / Keycloak and Fleet TLS startup wiring**: the chart mounts `/etc/harness/entrypoint/start-center.sh` from `entrypoint-configmap.yaml` as the container entrypoint (aligned with `deploy/center.Dockerfile` paths `/opt/ha/current/packages/daemon/dist/index.js` and `/opt/ha/current/packages/cli/dist/cli/src/index.js`):
  - When `identity.mode=external`, `identity.issuerUrl`, and `identity.existingClientSecret` are set, the entrypoint starts the daemon, waits for its local Unix socket, and runs `ha bootstrap --mode external --url ... --realm ... --client-id ... --client-secret-stdin < /etc/harness/oidc/<clientSecretKey>` whenever `<userRoot>/rbac/config.json` is not yet present.
  - When `fleet.enabled=true`, `fleet.authorityRepoId`, and `fleet.tlsExistingSecret` are set, the entrypoint idempotently writes `harness-daemon-registry/v2` and `fleet-center-config/v1` referencing `/etc/harness/fleet-tls/{tlsCertKey,tlsKeyKey}` before daemon launch so `openDaemonHost` restores and binds the Fleet TLS listener on boot. Operators who omit `fleet.authorityRepoId` can instead run `ha bootstrap --operation login` and `ha daemon fleet center start` interactively over the pod's local socket.
- **Secret isolation**: database connection strings (`daemon-storage.json`), Fleet TLS keypairs, OIDC client secrets, and optional Prometheus scrape Bearer tokens are mounted exclusively from Kubernetes Secrets referenced by name in `values.yaml`.
- **Kubernetes probes & Prometheus Operator**: wires `/healthz` and `/readyz` probes by default, plus opt-in `ServiceMonitor` (`metrics.serviceMonitor.enabled: true`) and `PrometheusRule` (`metrics.prometheusRule.enabled: true`, alerting on `up == 0 or absent(ha_daemon_up) == 1`, queue saturation, projection lag, and aggregated `sum(rate(...{outcome="error"}[5m])) / clamp_min(sum(rate(...[5m])), 1e-9)` RPC error ratio).
