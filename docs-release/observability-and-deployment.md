# Observability, Reproducible Offline Builds, and Helm Deployment

This guide covers the generic operational baseline for running Harness Anything Center in Kubernetes or air-gapped enterprise environments with external PostgreSQL and external OIDC/Keycloak.

## Prometheus metrics and health probes

The daemon provides an opt-in, read-only HTTP server implemented on Node's built-in `node:http` with zero third-party telemetry dependencies. It is disabled by default so local developer daemons do not open TCP listeners.

Enable it via environment variables or CLI flags on `harness-anything-daemon serve`:

| Environment variable                  | CLI flag         | Default          | Purpose                                                                                                                                                                                                                       |
| ------------------------------------- | ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HARNESS_DAEMON_METRICS_PORT`         | `--metrics-port` | unset (disabled) | TCP port (`0..65535`) for `/metrics`, `/healthz`, and `/readyz`                                                                                                                                                               |
| `HARNESS_DAEMON_METRICS_BIND`         | `--metrics-bind` | `127.0.0.1`      | Bind host (`0.0.0.0` inside containers when scraped in-cluster)                                                                                                                                                               |
| `HARNESS_DAEMON_METRICS_PATH`         | `--metrics-path` | `/metrics`       | Clean ASCII scrape path (`^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`; rejects dot segments, non-ASCII, and reserved `/healthz` or `/readyz`)                                                                                      |
| `HARNESS_DAEMON_METRICS_BEARER_TOKEN` | —                | unset            | Optional Bearer token required on `/metrics` (fails closed when set to empty/whitespace; verified with constant-time digest comparison; responds with RFC 6750 `WWW-Authenticate: Bearer` on `401`)                           |
| `HARNESS_DAEMON_METRICS_REQUIRE_AUTH` | —                | unset (`0`)      | When `1`/`true`, requires a non-empty `HARNESS_DAEMON_METRICS_BEARER_TOKEN` at startup and fails closed otherwise                                                                                                             |
| `HARNESS_DAEMON_REQUIRE_IDENTITY`     | —                | unset (`0`)      | When `1`/`true`, `/readyz` returns `503` (`identity_not_configured`, `identity_verifying`, `identity_authority_sync_pending`, or `identity_unavailable`) until authoritative live OIDC/managed identity verification succeeds |

### Endpoints

- `GET /metrics` (`HEAD` allowed): returns Prometheus exposition format (`text/plain; version=0.0.4; charset=utf-8`). All counters, gauges, histograms, and bounded-window latency quantiles are assembled strictly from resident in-memory host/writer state (`publishedStatus()`) with zero synchronous disk reads even on the very first cold scrape (package version is resolved eagerly at startup and sorted repository membership is maintained incrementally on attach/detach), zero ledger table scans, zero `registry.json` reads, and linear `O(R)` output formatting. Incoming request pathnames normalize RFC 3986 percent-encoded unreserved octets before route matching, and `ha_daemon_rpc_inflight` accounts for both local Unix JSON-RPC and Fleet TLS RPC requests.
- `GET /healthz`: process liveness probe; returns `200` (`live`) while the daemon process is running and `503` during shutdown or probe failure.
- `GET /readyz`: service readiness probe; returns `200` (`ready`) only when the daemon is live, initial attachments have settled, no repository is `warming` or `unavailable`, any configured Fleet center listener restored cleanly, and (when `HARNESS_DAEMON_REQUIRE_IDENTITY=1`) authoritative live identity verification has succeeded without pending authority sync; otherwise returns `503` (`not_ready`) with machine-readable `reasons`.
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

`tools/reproducible-build.mjs` builds workspace deliverables from a pinned Git commit inside clean archive trees with `SOURCE_DATE_EPOCH` pinned to the commit timestamp, installs locked build-time `devDependencies` via `npm ci --offline --include=dev` in `--offline-cache` mode, verifies unified deliverable entries (regular files, normalized POSIX executable modes, and symbolic links) across `build-manifest.json`, output directories, and deterministic USTAR/gzip archives (`harness-anything/reproducible-build-manifest/v1`).

```bash
# Build a deterministic bundle from a pre-seeded offline npm cache
node tools/reproducible-build.mjs build \
  --revision HEAD \
  --offline-cache /path/to/npm-cache \
  --out ./out/bundle \
  --archive ./out/bundle.tar.gz

# Run two independent clean builds against one pinned commit and verify bit-for-bit parity
node tools/reproducible-build.mjs verify \
  --revision HEAD \
  --mirror-node-modules \
  --verify-archive

# Verify an extracted bundle offline against its build-manifest.json (bytes, mode bits, symlinks)
node tools/reproducible-build.mjs verify-manifest \
  --bundle ./out/bundle
```

## Generic Helm Chart

The generic chart at [deploy/helm/harness-center/Chart.yaml](../deploy/helm/harness-center/Chart.yaml) targets external PostgreSQL (see [PostgreSQL daemon deployment](postgres-daemon.md)) and external OIDC/Keycloak (see [Server Daemon operations](operations-server-daemon.md)):

- **Single-authority topology & workloads**: `replicaCount` is locked to `1` in both `values.schema.json` and render-time template checks (avoiding PostgreSQL writer fencing or split SQLite volumes). Set `workloadKind: Deployment` (default) for stateless PostgreSQL-backed centers (`materialize: false`), or `workloadKind: StatefulSet` (paired with a governing headless Service `clusterIP: None`) when persistent per-pod volumes (`volumeClaimTemplates`) are required.
- **PostgreSQL enforcement**: when `storage.backend=postgres`, `storage.existingSecret` is mandatory and `start-center.sh` validates `<userRoot>/daemon-storage.json` against every enabled registered repository in `registry.json` (plus `fleet.authorityRepoId`) before launch, failing closed with redacted parse diagnostics so the daemon never silently falls back to local SQLite and never logs Secret contents.
- **External OIDC / Keycloak and Fleet TLS lifecycle (`start-center.sh`)**:
  - Reconciles `harness-daemon-registry/v2` and `fleet-center-config/v1` atomically on every start/upgrade when `fleet.enabled=true` with `fleet.authorityRepoId` and `fleet.tlsExistingSecret`, and removes stale persisted `center.json` when `fleet.enabled=false`.
  - On first boot with `identity.mode=external`, `identity.issuerUrl`, and `identity.existingClientSecret`, starts the daemon with `HARNESS_DAEMON_REQUIRE_IDENTITY=1` (keeping `/readyz` at `503` while `/healthz` passes), runs `ha bootstrap --mode external --client-secret-stdin` via interruptible async waiting (so `SIGTERM`/`SIGINT` interrupts blocked bootstrap calls immediately and drains the daemon cleanly), and hands off via `exec node` so the daemon runs directly as PID 1.
  - **Rotating or changing external OIDC / Keycloak configuration**: persisted `rbac/config.json` and `center-client-secret` drift causes `start-center.sh` to exit fail-closed before launching the daemon. Always rotate in order:
    1. Keep the existing Helm values / Secret (or run `helm rollback <release>` if an upgrade already triggered drift) so the Pod starts cleanly with its persisted OIDC authority.
    2. Exec into the **running** Pod, sign in as an administrator (`ha bootstrap --operation login`), and rotate the authority against its live daemon socket (`ha bootstrap --mode external --url <new-issuer> --realm <new-realm> --client-id <new-id> --client-secret-stdin`).
    3. Update the Kubernetes OIDC client Secret and run `helm upgrade` with matching `identity.*` values so future restarts match the rotated persisted state.
- **Separated & collision-free Service boundaries**: `service.yaml` exposes only `fleet-tls` (`ClusterIP`/`NodePort`/`LoadBalancer`), `service-metrics.yaml` always uses `ClusterIP` exclusively for the `metrics` port and is targeted by `ServiceMonitor` (`app.kubernetes.io/component: metrics`), and `service-headless.yaml` (`clusterIP: None`) governs `StatefulSet` pod DNS. Long release names and `fullnameOverride` values are truncated with a deterministic hash before suffixing so primary, `-metrics`, `-headless`, and `-entrypoint` names stay `<= 63` characters and never collide. When `metrics.bearerTokenExistingSecret` is set, empty or whitespace-only Secret values fail closed at both entrypoint startup and daemon HTTP server initialization.
- **Release-scoped Prometheus Operator alerts**: `PrometheusRule` scopes all alerts (`HarnessDaemonDown`, `HarnessWriteQueueSaturated`, `HarnessProjectionLagHigh`, `HarnessRpcErrorRateHigh`) by `namespace` and the release's dedicated `service` label, preserves `(namespace, service)` grouping in `HarnessRpcErrorRateHigh` (`sum by (namespace, service)`), and attaches `release: <release-name>` to every alert rule's `labels:` so multiple releases firing simultaneously produce distinct alert identities.
