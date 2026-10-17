import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { lookup } from "node:dns/promises";
import { createSecureContext } from "node:tls";
import { readDaemonRegistry } from "@harness-anything/kernel";
import { listenFleetTls, type FleetTlsCenter } from "./fleet/center.ts";
import type { EdgeJoinAdmission, FleetCenterOptions } from "./fleet/center-types.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import type { KeycloakCenterAuthority } from "./transport/auth-context.ts";
import { readReplicaGeneration, revokeReplicaView } from "./fleet/replica-generation.ts";
import { FleetRemoteError, readFleetRepositoryMetadataClient } from "./fleet/peer.ts";
import { failFleetReplicaSync, waitForFleetReplicaSequence } from "./fleet/replica-sync.ts";
import { applyFleetMirrorCut, withFleetMirrorLock } from "./fleet-edge-mirror.ts";
import { reclaimEdgeTaskWorktrees } from "./fleet-edge-worktree-reclaim.ts";
import type { WriterEpochLease } from "./writer-epoch.ts";
import { readFleetEdgeConfig, writeFleetEdgeConfig } from "./client/fleet-edge-config.ts";
import { mapListenerBindError, validateCertificateNames } from "./tls-listener-admission.ts";
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
      const node = await adapter.readNode(token, nodeId);
      return node?.state === "active" && node.revocation === "complete" ? node.personId : null;
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
    "authenticate" | "nodeOwner" | "loginAuthority" | "verifyHuman" | "deviceLoginNotice" | "revokeDeviceSessions"
  > & {
    readonly edgeJoin?: (
      input: Parameters<NonNullable<FleetCenterOptions["edgeJoin"]>>[0],
    ) => Promise<Omit<EdgeJoinAdmission, "repoId" | "harnessYaml">>;
  };
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
  const bind = request.bind ?? "127.0.0.1";
  await lookup(bind);
  validateCertificateNames(cert, [bind]);
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
    ...withoutEdgeJoin(input.nodes),
    ...(input.nodes.edgeJoin ? { edgeJoin: edgeJoinFor(input, input.nodes.edgeJoin) } : {}),
  };
}
function withoutEdgeJoin<T extends { readonly edgeJoin?: unknown }>(nodes: T): Omit<T, "edgeJoin"> {
  const { edgeJoin: _edgeJoin, ...rest } = nodes;
  return rest;
}
/** An edge joins the authority repository; its layout file is public and lets the edge register the mirror. */
function edgeJoinFor(
  input: FleetCenterAdmissionRequest,
  admit: NonNullable<FleetCenterAdmissionRequest["nodes"]["edgeJoin"]>,
): NonNullable<FleetCenterOptions["edgeJoin"]> {
  return async (join) => {
    const admitted = await admit(join),
      authority = readDaemonRegistry({ userRoot: input.userRoot }).repos.find(
        (repo) => repo.repoId === input.payload.repoId && repo.canonicalRoot !== null,
      );
    if (!authority?.canonicalRoot) throw new Error("Fleet center authority repository is not registered.");
    return {
      ...admitted,
      repoId: input.payload.repoId,
      harnessYaml: readFileSync(path.join(authority.canonicalRoot, "harness", "harness.yaml"), "utf8"),
    };
  };
}
export async function startFleetCenterAdmission(
  options: FleetCenterOptions,
): Promise<{ readonly center: FleetTlsCenter; readonly stateRoot: string }> {
  try {
    return { center: await listenFleetTls(options), stateRoot: options.stateRoot };
  } catch (error) {
    throw mapListenerBindError(error);
  }
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
export async function syncFleetEdgeMirror(
  input: FleetEdgeSyncRequest,
  readAccessToken?: () => Promise<string | undefined>,
  onAdmitted?: () => void,
): Promise<Record<string, unknown>> {
  // Sync means "caught up with the center now": ask for its replication head and whether the node's
  // owner may read the repository (the replica's own admission), then let the resident stream reach
  // the head. There is no second pull path; a stopped or failing stream fails the sync.
  const request = input.payload,
    advise = (code: string, message: string): never => {
      // A sync the center denies withholds the rows already delivered: the view stops answering, and
      // the resident stream installs a fresh one once the center admits the replica again.
      if (code === "authorization_denied") {
        revokeReplicaView(path.join(request.viewRoot, "repos", request.repoId, "views", request.nodeId));
        failFleetReplicaSync(request, Object.assign(new Error(message), { code }));
      }
      throw Object.assign(
        new Error(
          // The machine was recognized and its owner lacks the action; no credential change fixes that.
          code === "authorization_denied"
            ? `${message} Ask a center administrator to grant the node's owner repository-read` +
              " on this repository, then retry the edge sync."
            : code === "authentication_failed" || code === "node_owner_unregistered"
              ? `${message} Register the node at the center and use the credential it issued,` +
                " or correct --node-id / --credential, then retry the edge sync."
              : `Center replica admission failed: ${message}`,
        ),
        { code },
      );
    },
    head = await readFleetRepositoryMetadataClient({
      ...(readAccessToken ? { readAccessToken } : {}),
      hostname: request.host,
      port: request.port,
      ca: material(request.caPath, "--ca"),
      ...(request.servername ? { servername: request.servername } : {}),
      nodeId: request.nodeId,
      credential: request.credential,
      repoId: request.repoId,
      actionKind: "repository-read",
      ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    }).catch((error: unknown) =>
      error instanceof FleetRemoteError ? advise(error.code, error.message) : Promise.reject(error),
    );
  if (head.actionAllowed !== true)
    advise("authorization_denied", "authorization_denied: The node owner may not read this repository.");
  // The admitted connection becomes the workspace's fleet-edge.json, which the resident stream follows
  // (started or restarted by onAdmitted); sync then waits on that stream.
  persistEdgeConnection(request);
  onAdmitted?.();
  if (head.replicationSequence !== null) await waitForFleetReplicaSequence(request, head.replicationSequence);
  return withFleetMirrorLock(input.payload.viewRoot, input.payload.repoId, async () => {
    const generation = readReplicaGeneration(
      path.join(input.payload.viewRoot, "repos", input.payload.repoId, "views", input.payload.nodeId),
    );
    if (!generation) throw new Error("replica generation is unavailable");
    const pulled = { replica: { viewId: input.payload.nodeId, knownHead: generation.metadata.position } };
    const materialized = applyFleetMirrorCut(
      input.payload.viewRoot,
      input.payload.repoId,
      input.payload.workspaceRoot,
      "pull",
      { viewId: input.payload.nodeId },
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
      status: "fleet.replica.current/v1",
      knownHead: {
        revision: pulled.replica.knownHead.revision,
        headDigest: `sha256:${pulled.replica.knownHead.history}:${pulled.replica.knownHead.sequence}`,
      },
      lagRevisions: 0,
      ackCut: pulled.replica.knownHead.revision,
      viewId: input.payload.nodeId,
      cut: {
        revision: pulled.replica.knownHead.revision,
        headDigest: `sha256:${pulled.replica.knownHead.history}:${pulled.replica.knownHead.sequence}`,
      },
      manifestDigest: `sha256:${pulled.replica.knownHead.history}:${pulled.replica.knownHead.sequence}`,
      mirrorOutcome: materialized.outcome,
      dirtyPaths: materialized.dirtyPaths,
      conflicts: materialized.conflicts,
      ...(worktrees ? { worktrees } : {}),
    };
  });
}

/** Keeps the operator's freshness tuning from an existing fleet-edge.json; an invalid one fails the sync. */
function persistEdgeConnection(request: FleetEdgeSyncRequest["payload"]): void {
  const previous = readFleetEdgeConfig(request.workspaceRoot);
  writeFleetEdgeConfig(request.workspaceRoot, {
    repoId: request.repoId,
    host: request.host,
    port: request.port,
    caPath: request.caPath,
    ...(request.servername ? { servername: request.servername } : {}),
    nodeId: request.nodeId,
    credential: request.credential,
    viewRoot: request.viewRoot,
    quotaBytes: request.quotaBytes,
    ...(previous?.waitTimeoutMs !== undefined ? { waitTimeoutMs: previous.waitTimeoutMs } : {}),
    ...(previous?.maxAgeMs !== undefined ? { maxAgeMs: previous.maxAgeMs } : {}),
    ...(previous?.maxLagRevisions !== undefined ? { maxLagRevisions: previous.maxLagRevisions } : {}),
  });
}
