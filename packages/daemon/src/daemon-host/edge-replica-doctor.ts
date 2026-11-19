import { consumeKnownError } from "@harness-anything/kernel";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import {
  fleetEdgeCaPath,
  fleetEdgeConfigDir,
  fleetEdgeConfigPath,
  readFleetEdgeConfig,
} from "./client/fleet-edge-config.ts";
import { daemonUserRoot } from "./client/local-daemon-target.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { readReplicaGeneration } from "../fleet-sync/fleet/replica-generation.ts";
import { readReplicaHealth, replicaFailure } from "../fleet-sync/fleet/replica-health.ts";

/** Three missed center keepalives: a stream this quiet is not delivering (REPLICATION_KEEPALIVE_MS). */
const REPLICA_STREAM_SILENT_MS = 45_000;

/** Workspace residue check: machine-local edge files with credentials must live under userRoot, never in the repo. */
export function edgeConfigResidueDoctorCheck(rootDir: string, repoId: string, userRoot: string = daemonUserRoot()) {
  const candidates = ["fleet-edge.json", "fleet-center-ca.pem"] as const,
    present = candidates
      .map((name) => ({ name, fullPath: path.join(rootDir, name) }))
      .filter(({ fullPath }) => lstatSync(fullPath, { throwIfNoEntry: false }) !== undefined);
  if (present.length === 0)
    return {
      id: "edge-config-residue" as const,
      status: "ok" as const,
      count: 0,
      summary: "No fleet-edge.json or fleet-center-ca.pem residue in repository workspace.",
      next: "Nothing to do.",
    };
  const targetDir = fleetEdgeConfigDir(userRoot, repoId),
    targetConfig = fleetEdgeConfigPath(userRoot, repoId),
    targetCa = fleetEdgeCaPath(userRoot, repoId),
    hasTargetConfig = existsSync(targetConfig),
    names = present.map((item) => item.name),
    paths = present.map((item) => item.fullPath);
  return {
    id: "edge-config-residue" as const,
    status: "fail" as const,
    count: present.length,
    summary: `Repository workspace still holds machine-local edge file(s) (${names.join(", ")}) that may expose credentials to Git and are no longer read from the workspace.`,
    next: hasTargetConfig
      ? `Node config already exists at ${targetDir}. Remove the workspace residue: rm -f ${paths.map((p) => JSON.stringify(p)).join(" ")}, then rerun ha doctor.`
      : `Move residual edge config out of the workspace to ${targetDir}: mkdir -p ${JSON.stringify(targetDir)} && mv ${paths.map((p) => JSON.stringify(p)).join(" ")} ${JSON.stringify(`${targetDir}/`)}, update caPath in ${JSON.stringify(targetConfig)} to ${JSON.stringify(targetCa)} (or rerun ha daemon fleet edge sync), then rerun ha doctor.`,
  };
}

/** Local observations remain available when the replica, transport or canonical writer is broken. */
export function edgeReplicaDoctor(
  rootDir: string,
  repoId: string,
  now: () => number = Date.now,
  userRoot: string = daemonUserRoot(),
) {
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
    const config = readFleetEdgeConfig(userRoot, repoId);
    if (!config || config.repoId !== repoId)
      throw Object.assign(new Error("Replica configuration is unavailable"), { code: "fleet_edge_config_invalid" });
    const viewRoot = path.resolve(rootDir, config.viewRoot),
      viewDir = path.join(viewRoot, "repos", repoId, "views", config.nodeId);
    const view = locateFleetMirrorView(viewRoot, repoId, config.nodeId, { includeEntries: false });
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
      edgeConfigResidueDoctorCheck(rootDir, repoId, userRoot),
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
    checks: [
      "stale-delivered",
      "executor-undeclared",
      "orphan-lease",
      "wip-pressure",
      "local-root-residue",
      "doc-debt",
      "exited-unsettled-runtime",
      "workspace-links",
      "build-drift",
    ].map((id) => ({
      id,
      status: "indeterminate" as const,
      summary: note,
      count: 0,
      next: "Run ha doctor on the center.",
    })),
  };
}
