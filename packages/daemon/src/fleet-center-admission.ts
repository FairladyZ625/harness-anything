import { readFileSync } from "node:fs";
import path from "node:path";
import { timestamp } from "@harness-anything/kernel";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "./fleet/center.ts";
import type { FleetCenterOptions } from "./fleet/center-types.ts";
import { KeycloakPolicyAdapter } from "./keycloak-policy-adapter.ts";
import type { KeycloakCenterAuthority } from "./transport/auth-context.ts";
import { FleetRemoteError, runFleetReplicaPullClient } from "./fleet/edge.ts";
import { applyFleetMirrorCut, withFleetMirrorLock } from "./fleet-edge-mirror.ts";
import { reclaimEdgeTaskWorktrees } from "./fleet-edge-worktree-reclaim.ts";
import type { WriterEpochLease } from "./writer-epoch.ts";
/**
 * The assignments a center serves. It names what each node may reach, never who a node is: machine
 * credentials and node owners live in the center's Keycloak node registry.
 */
export interface FleetRoster {
  readonly assignments: readonly FleetAssignmentRecord[];
}
export class FleetRosterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FleetRosterError";
    this.code = code;
  }
}
const id = /^[A-Za-z0-9_-]{1,96}$/u,
  row = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null,
  shapeText =
    '{ "schema": "fleet-roster/v3", "assignments": [{ "assignmentId": string, "nodeId": string,' +
    ' "repoId": string, "viewId": string, "expiresAt": ISO-8601-Z,' +
    ' "scope": { "kind": "task", "taskId": string, "executionId": string, "paths": string[] }' +
    ' | { "kind": "schedule", "scheduleId": string, "paths": string[] } }] }';
export function readFleetRosterFile(file: string): FleetRoster {
  try {
    return parseFleetRoster(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof FleetRosterError) throw error;
    throw new FleetRosterError(
      "roster_unreadable",
      `Fleet roster at ${file} could not be read or parsed: ${error instanceof Error ? error.message : String(error)}. Provide ${shapeText}.`,
    );
  }
}
export function parseFleetRoster(input: unknown): FleetRoster {
  const record = row(input),
    fail = (detail: string) =>
      new FleetRosterError("roster_invalid", `Fleet roster is invalid: ${detail}. Provide ${shapeText}.`);
  if (record === null || record.schema !== "fleet-roster/v3")
    throw fail("the top-level schema must be fleet-roster/v3");
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "assignments"))
    throw fail("fleet-roster/v3 has unknown or missing top-level fields");
  if (
    !Array.isArray(record.assignments) ||
    record.assignments.length === 0 ||
    record.assignments.some((value) => parseFleetRosterAssignment(value) === null)
  )
    throw fail("assignments must be a non-empty array of complete assignment rows");
  return { assignments: record.assignments.map((value) => parseFleetRosterAssignment(value)!) };
}

function parseFleetRosterAssignment(value: unknown): FleetAssignmentRecord | null {
  const entry = row(value),
    scope = row(entry?.scope),
    assignmentFields = ["assignmentId", "nodeId", "repoId", "viewId", "expiresAt", "scope"],
    scopeFields =
      scope?.kind === "task"
        ? ["kind", "taskId", "executionId", "paths"]
        : scope?.kind === "schedule"
          ? ["kind", "scheduleId", "paths"]
          : [],
    paths = scope?.paths;
  if (
    !entry ||
    Object.keys(entry).length !== assignmentFields.length ||
    !assignmentFields.every((field) => Object.hasOwn(entry, field)) ||
    !["assignmentId", "nodeId", "repoId", "viewId"].every(
      (field) => typeof entry[field] === "string" && id.test(entry[field] as string),
    ) ||
    !timestamp(entry.expiresAt) ||
    !scope ||
    scopeFields.length === 0 ||
    Object.keys(scope).length !== scopeFields.length ||
    !scopeFields.every((field) => Object.hasOwn(scope, field)) ||
    !scopeFields
      .filter((field) => field !== "kind" && field !== "paths")
      .every((field) => typeof scope[field] === "string" && id.test(scope[field] as string)) ||
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 128 ||
    !paths.every(validRosterPath)
  )
    return null;
  return {
    assignmentId: entry.assignmentId as string,
    nodeId: entry.nodeId as string,
    repoId: entry.repoId as string,
    viewId: entry.viewId as string,
    scope:
      scope.kind === "task"
        ? {
            kind: "task",
            taskId: scope.taskId as string,
            executionId: scope.executionId as string,
            paths: paths as string[],
          }
        : { kind: "schedule", scheduleId: scope.scheduleId as string, paths: paths as string[] },
    expiresAt: entry.expiresAt as string,
  };
}

function validRosterPath(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.normalize("NFC") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..")
  );
}

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
  readonly userRoot: string;
  readonly nodes: Pick<FleetCenterOptions, "authenticate" | "nodeOwner" | "loginAuthority" | "verifyHuman">;
  readonly writerEpochLease?: (repoId: string) => WriterEpochLease;
  readonly payload: {
    readonly port: number;
    readonly bind?: string;
    readonly keyPath: string;
    readonly certPath: string;
    readonly rosterPath: string;
    readonly stateRoot?: string;
    readonly quotaBytes: number;
  };
}
const material = (file: string, flag: string): Buffer => {
  try {
    return readFileSync(file);
  } catch (error) {
    throw new FleetRosterError(
      "fleet_material_unreadable",
      `Fleet TLS ${flag} at ${file} could not be read: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
};
export async function startFleetCenterAdmission(
  input: FleetCenterAdmissionRequest,
): Promise<{ readonly center: FleetTlsCenter; readonly roster: FleetRoster; readonly stateRoot: string }> {
  const roster = readFleetRosterFile(input.payload.rosterPath),
    assignmentOf = new Map(roster.assignments.map((entry) => [entry.assignmentId, entry])),
    stateRoot = input.payload.stateRoot ?? path.join(input.userRoot, "fleet");
  return {
    center: await listenFleetTls({
      host: input.host,
      stateRoot,
      writerEpochStateRoot: path.join(input.userRoot, "fleet"),
      ...(input.writerEpochLease ? { writerEpochLease: input.writerEpochLease } : {}),
      key: material(input.payload.keyPath, "--key"),
      cert: material(input.payload.certPath, "--cert"),
      hostname: input.payload.bind,
      port: input.payload.port,
      replicaDiskQuotaBytes: input.payload.quotaBytes,
      ...input.nodes,
      resolveAssignment: (assignmentId) => assignmentOf.get(assignmentId) ?? null,
    }),
    roster,
    stateRoot,
  };
}
export interface FleetEdgeSyncRequest {
  readonly payload: {
    readonly host: string;
    readonly port: number;
    readonly caPath: string;
    readonly servername?: string;
    readonly nodeId: string;
    readonly credential: string;
    readonly assignmentId: string;
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
      assignmentId: input.payload.assignmentId,
      viewRoot: input.payload.viewRoot,
      diskQuotaBytes: input.payload.quotaBytes,
      timeoutMs: input.payload.timeoutMs ?? 60_000,
    }).catch((error: unknown) => {
      if (error instanceof FleetRemoteError)
        throw Object.assign(
          new Error(
            // The machine was recognized and its owner lacks the action; no credential change fixes that.
            error.code === "authorization_denied"
              ? `${error.message} Ask a center administrator to grant the node's owner daemon-fleet-edge-sync` +
                " on this repository, then retry the edge sync."
              : `${error.message} Register the node at the center and use the credential it issued,` +
                " or correct --node-id / --credential / --assignment, then retry the edge sync.",
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
