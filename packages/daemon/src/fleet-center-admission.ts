import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { createSecureContext } from "node:tls";
import { listenFleetTls, type FleetTlsCenter } from "./fleet/center.ts";
import type { FleetCenterOptions } from "./fleet/center-types.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import type { KeycloakCenterAuthority } from "./transport/auth-context.ts";
import { FleetRemoteError, runFleetReplicaPullClient } from "./fleet/edge.ts";
import { applyFleetMirrorCut, withFleetMirrorLock } from "./fleet-edge-mirror.ts";
import { reclaimEdgeTaskWorktrees } from "./fleet-edge-worktree-reclaim.ts";
import type { WriterEpochLease } from "./writer-epoch.ts";
/** The center's node registry: Keycloak verifies the machine credential and names the node's owner. */
export function keycloakNodeRegistry(
  center: KeycloakCenterAuthority,
  fetchPort?: typeof fetch,
): Pick<FleetCenterOptions, "authenticate" | "nodeOwner"> {
  const open = async () => {
    const authority = await center();
    return {
      token: authority.accessToken,
      adapter: new KeycloakPolicyAdapter(
        { url: authority.url, realm: authority.realm, resourceServerClientId: authority.clientId },
        fetchPort,
      ),
    };
  };
  return {
    authenticate: async (nodeId, credential) => (await open()).adapter.authenticateNode(nodeId, credential),
    nodeOwner: async (nodeId) => {
      const { adapter, token } = await open();
      return (await adapter.readNode(token, nodeId))?.personId || null;
    },
  };
}
export interface FleetCenterAdmissionRequest {
  readonly host: FleetCenterOptions["host"];
  readonly buildDraining?: FleetCenterOptions["buildDraining"];
  readonly onDeliverySettled?: FleetCenterOptions["onDeliverySettled"];
  readonly userRoot: string;
  readonly nodes: Pick<
    FleetCenterOptions,
    "authenticate" | "nodeOwner" | "loginAuthority" | "verifyHuman" | "deviceLoginNotice"
  >;
  readonly writerEpochLease?: (repoId: string) => WriterEpochLease;
  readonly payload: {
    readonly port: number;
    readonly bind?: string;
    readonly keyPath: string;
    readonly certPath: string;
    readonly repoId: string;
    readonly stateRoot?: string;
    readonly quotaBytes: number;
  };
}
const material = (file: string, flag: string): Buffer => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new Error(
      `Fleet TLS ${flag} at ${file} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
};
export async function prepareFleetCenterAdmission(input: FleetCenterAdmissionRequest): Promise<FleetCenterOptions> {
  const request = input.payload;
  if (!Number.isSafeInteger(request.port) || request.port < 0 || request.port > 65535)
    throw new Error("Fleet TLS --port must be an integer between 0 and 65535.");
  if (!Number.isSafeInteger(request.quotaBytes) || request.quotaBytes <= 0)
    throw new Error("Fleet TLS --quota-bytes must be a positive safe integer.");
  for (const field of ["keyPath", "certPath", "repoId", "bind", "stateRoot"] as const) {
    const value = request[field];
    if ((field === "bind" || field === "stateRoot") && value === undefined) continue;
    if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
      throw new Error(`Fleet TLS ${field} must be nonempty.`);
  }
  if (request.stateRoot && existsSync(request.stateRoot) && !statSync(request.stateRoot).isDirectory())
    throw new Error("Fleet TLS stateRoot must be a directory.");
  const key = material(request.keyPath, "--key"),
    cert = material(request.certPath, "--cert");
  createSecureContext({ key, cert });
  await lookup(request.bind ?? "127.0.0.1");
  return {
    host: input.host,
    buildDraining: input.buildDraining,
    onDeliverySettled: input.onDeliverySettled,
    stateRoot: request.stateRoot ?? path.join(input.userRoot, "fleet"),
    writerEpochStateRoot: path.join(input.userRoot, "fleet"),
    ...(input.writerEpochLease ? { writerEpochLease: input.writerEpochLease } : {}),
    key,
    cert,
    hostname: request.bind,
    port: request.port,
    replicaDiskQuotaBytes: request.quotaBytes,
    ...input.nodes,
  };
}
export async function startFleetCenterAdmission(
  options: FleetCenterOptions,
): Promise<{ readonly center: FleetTlsCenter; readonly stateRoot: string }> {
  return { center: await listenFleetTls(options), stateRoot: options.stateRoot };
}
export interface FleetEdgeSyncRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot: string;
    readonly timeoutMs?: number;
  };
}
export async function syncFleetEdgeMirror(input: FleetEdgeSyncRequest): Promise<Record<string, unknown>> {
  return withFleetMirrorLock(input.payload.viewRoot, input.payload.repoId, async () => {
    const pulled = await runFleetReplicaPullClient({
      hostname: input.payload.host,
      port: input.payload.port,
      ca: material(input.payload.caPath, "--ca").toString("utf8"),
      servername: input.payload.servername,
      nodeId: input.payload.nodeId,
      credential: input.payload.credential,
      repoId: input.payload.repoId,
      viewRoot: input.payload.viewRoot,
      diskQuotaBytes: input.payload.quotaBytes,
      timeoutMs: input.payload.timeoutMs ?? 60_000,
    }).catch((error: unknown) => {
      if (error instanceof FleetRemoteError)
        throw Object.assign(
          new Error(
            // The machine was recognized and its owner lacks the action; no credential change fixes that.
            error.code === "authorization_denied"
              ? `${error.message} Ask a center administrator to grant the node's owner repository-read` +
                " on this repository, then retry the edge sync."
              : error.code === "authentication_failed" || error.code === "node_owner_unregistered"
                ? `${error.message} Register the node at the center and use the credential it issued,` +
                  " or correct --node-id / --credential, then retry the edge sync."
                : `Center replica admission failed: ${error.message}`,
          ),
          { code: error.code },
        );
      throw error;
    });
    const materialized = applyFleetMirrorCut(
      input.payload.viewRoot,
      input.payload.repoId,
      input.payload.workspaceRoot,
      "pull",
      { viewId: pulled.replica.viewId },
    );
    const worktrees = await reclaimEdgeTaskWorktrees(input.payload, materialized);
    const blocked = materialized.outcome === "pull_blocked";
    const blockedHint =
      materialized.conflicts.length === 0
        ? "The registered harness could not be materialized; inspect the edge mirror state."
        : `Divergence staged at ${materialized.conflicts[0]!.dir}; exit explicitly with` +
          ` ha doc conflict resolve|discard-local|overwrite-center ${materialized.conflicts[0]!.conflictId}.`;
    return {
      schema: "command-receipt/v2",
      ok: !blocked,
      command: "daemon-fleet-edge-sync",
      outcome: blocked ? "op_rejected" : "applied",
      ...(blocked ? { code: "pull_blocked", error: { code: "pull_blocked", hint: blockedHint } } : {}),
      status: pulled.replica.schema,
      knownHead: pulled.replica.knownHead,
      lagRevisions: pulled.replica.knownHead.revision - pulled.current.cut.revision,
      ackCut: "ackCut" in pulled.replica ? pulled.replica.ackCut : pulled.current.cut.revision,
      viewId: pulled.replica.viewId,
      cut: pulled.current.cut,
      manifestDigest: pulled.current.manifestDigest,
      mirrorOutcome: materialized.outcome,
      dirtyPaths: materialized.dirtyPaths,
      conflicts: materialized.conflicts,
      ...(worktrees ? { worktrees } : {}),
    };
  });
}
