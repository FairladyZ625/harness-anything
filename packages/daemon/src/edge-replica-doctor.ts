import { consumeKnownError } from "@harness-anything/kernel";
import path from "node:path";
import { readFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { locateFleetMirrorView } from "./fleet-edge-mirror.ts";
import { isReadDenied, openEdgeReadModel, readHeadConfirmation } from "./fleet/replica-read-model.ts";
import { readReplicaHealth, replicaFailure } from "./fleet/replica-health.ts";

/** Local observations remain available when the replica, transport or canonical writer is broken. */
export function edgeReplicaDoctor(rootDir: string, repoId: string) {
  const replica = {
    currentCut: null as { revision: number; headDigest: string } | null,
    centerCut: null as { revision: number; headDigest: string } | null,
    lag: null as number | null,
    lastSuccessAt: null as string | null,
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
    const confirmation = readHeadConfirmation(viewDir);
    if (confirmation) {
      replica.centerCut = { revision: confirmation.headRevision, headDigest: confirmation.headDigest };
      replica.lastSuccessAt = new Date(confirmation.confirmedAt).toISOString();
    }
    const view = locateFleetMirrorView(viewRoot, repoId, config.nodeId);
    if (view) {
      replica.currentCut = { revision: view.revision, headDigest: view.headDigest };
      replica.authorizationShapeDigest = view.authorizationShapeDigest;
      if (!isReadDenied(viewDir)) {
        const model = openEdgeReadModel(view, path.join(viewRoot, "repos", repoId, "cas", "sha256"));
        if (model) {
          replica.schemaGeneration = model.meta.schemaGeneration;
          model.db.close();
        }
      }
    }
    const health = readReplicaHealth(viewDir),
      failure = health.modelFailure ?? health.syncFailure;
    replica.rebuildCount = health.rebuildCount;
    replica.failureCode = isReadDenied(viewDir)
      ? "authorization_denied"
      : (failure?.code ?? (view ? null : "replica_unavailable"));
    replica.failureMessage = failure?.message ?? null;
    replica.lag =
      replica.currentCut && replica.centerCut
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
