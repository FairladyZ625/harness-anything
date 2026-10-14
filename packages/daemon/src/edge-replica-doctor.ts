import { consumeKnownError } from "@harness-anything/kernel";
import path from "node:path";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { readReplicaGeneration } from "./fleet/replica-generation.ts";
import { readReplicaHealth, replicaFailure } from "./fleet/replica-health.ts";

/** Three missed center keepalives: a stream this quiet is not delivering (REPLICATION_KEEPALIVE_MS). */
const REPLICA_STREAM_SILENT_MS = 45_000;

/** Local observations remain available when the replica, transport or canonical writer is broken. */
export function edgeReplicaDoctor(rootDir: string, repoId: string, now: () => number = Date.now) {
  const replica = {
    currentCut: null as { revision: number; headDigest: string } | null,
    centerCut: null as { revision: number; headDigest: string } | null,
    lag: null as number | null,
    lastSuccessAt: null as string | null,
    lastHeartbeatAt: null as string | null,
    failureCode: null as string | null,
    failureMessage: null as string | null,
    rebuildCount: null as number | null,
    schemaGeneration: null as number | null,
    authorizationShapeDigest: null as string | null,
  };
  try {
    const config = readFleetEdgeConfig(rootDir);
    if (!config || config.repoId !== repoId)
      throw Object.assign(new Error("Replica configuration is unavailable"), { code: "fleet_edge_config_invalid" });
    const viewRoot = path.resolve(rootDir, config.viewRoot),
      viewDir = path.join(viewRoot, "repos", repoId, "views", config.nodeId);
    const view = locateFleetMirrorView(viewRoot, repoId, config.nodeId);
    if (view) {
      replica.currentCut = { revision: view.revision, headDigest: view.headDigest };
      replica.authorizationShapeDigest = view.authorizationShapeDigest;
      const generation = readReplicaGeneration(viewDir);
      replica.schemaGeneration = generation?.metadata.projectionSchema ?? null;
      // The edge learns the center head only from the stream: its last confirmation is that head.
      replica.centerCut = replica.currentCut;
    }
    const health = readReplicaHealth(viewDir),
      failure = health.modelFailure ?? health.syncFailure,
      heartbeatAge = health.lastHeartbeatAt === null ? null : now() - Date.parse(health.lastHeartbeatAt),
      silent = view !== null && failure === null && (heartbeatAge === null || heartbeatAge > REPLICA_STREAM_SILENT_MS);
    replica.rebuildCount = health.rebuildCount;
    replica.lastHeartbeatAt = health.lastHeartbeatAt;
    replica.lastSuccessAt = health.lastHeartbeatAt;
    replica.failureCode = failure?.code ?? (view ? (silent ? "replica_stream_silent" : null) : "replica_unavailable");
    replica.failureMessage =
      failure?.message ??
      (silent
        ? health.lastHeartbeatAt === null
          ? "The replication stream has never confirmed a position."
          : `No center confirmation since ${health.lastHeartbeatAt}; the replication stream is not delivering.`
        : null);
    // Lag is only known while the stream confirms the center head; a silent or failed stream's lag is unknown.
    replica.lag =
      replica.currentCut && replica.centerCut && replica.failureCode === null
        ? Math.max(0, replica.centerCut.revision - replica.currentCut.revision)
        : null;
  } catch (error) {
    consumeKnownError(error);
    const failure = replicaFailure(error, "replica_health_unreadable");
    replica.failureCode = failure.code;
    replica.failureMessage = failure.message;
  }
  const center = unavailableCenterDoctor(repoId),
    failed = replica.failureCode !== null;
  return {
    ...center,
    opId: "doctor-edge-replica",
    scope: {
      ...center.scope,
      note: "Local replica observations; centerCut is the last confirmed center head. Center process checks require its own doctor.",
    },
    ...replica,
    checks: [
      {
        id: "edge-replica",
        status: failed ? ("fail" as const) : ("ok" as const),
        count: replica.lag ?? 0,
        summary: failed
          ? `${replica.failureCode}: ${replica.failureMessage ?? "Replica unavailable"}`
          : `Replica at revision ${replica.currentCut?.revision}; lag ${replica.lag ?? "unknown"}`,
        next: failed ? "Inspect the replica failure and retry edge sync." : "No action required.",
      },
      ...center.checks,
    ],
  };
}

function unavailableCenterDoctor(repoId: string) {
  const note =
    "ha doctor observes center-local health. Center observations are unavailable from a remote-edge; run ha doctor on the center.";
  return {
    schema: "doctor-health/v1",
    ok: true,
    outcome: "applied" as const,
    opId: "doctor-center-unavailable",
    scope: { repoId, productBaseRef: null, productBaseTip: null, ledgerBaseRef: null, ledgerBaseTip: null, note },
    checks: ["stale-delivered", "executor-undeclared", "orphan-lease", "wip-pressure", "doc-debt", "build-drift"].map(
      (id) => ({
        id,
        status: "indeterminate" as const,
        summary: note,
        count: 0,
        next: "Run ha doctor on the center.",
      }),
    ),
  };
}
