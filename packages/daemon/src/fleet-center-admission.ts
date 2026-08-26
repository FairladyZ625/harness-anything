import { readFileSync } from "node:fs";
import path from "node:path";
import { timestamp } from "../../kernel/src/index.ts";
import type { DaemonHost } from "./daemon-host.ts";
import { listenFleetTls, type FleetAssignmentRecord, type FleetTlsCenter } from "./fleet/center.ts";
import { FleetRemoteError, runFleetReplicaPullClient } from "./fleet/edge.ts";
import { applyFleetMirrorCut, withFleetMirrorLock } from "./fleet-edge-mirror.ts";
export interface FleetRoster {
  readonly nodes: readonly { readonly nodeId: string; readonly credential: string }[];
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
    '{ "schema": "fleet-roster/v2", "nodes": [{ "nodeId": string, "credential": string }], "assignments": [{ "assignmentId": string, "nodeId": string, "repoId": string, "viewId": string, "personId": string, "executorId"?: string, "expiresAt": ISO-8601-Z, "scope": { "kind": "task", "taskId": string, "executionId": string, "paths": string[] } | { "kind": "schedule", "scheduleId": string, "paths": string[] } }] }';
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
  if (record === null || !["fleet-roster/v1", "fleet-roster/v2"].includes(String(record.schema)))
    throw fail("the top-level schema must be fleet-roster/v1 or fleet-roster/v2");
  if (
    record.schema === "fleet-roster/v2" &&
    (Object.keys(record).length !== 3 ||
      !["schema", "nodes", "assignments"].every((field) => Object.hasOwn(record, field)))
  )
    throw fail("fleet-roster/v2 has unknown or missing top-level fields");
  const node = (value: unknown): { nodeId: string; credential: string } | null => {
    const entry = row(value);
    return entry &&
      (record.schema === "fleet-roster/v1" ||
        (Object.keys(entry).length === 2 && ["nodeId", "credential"].every((field) => Object.hasOwn(entry, field)))) &&
      typeof entry.nodeId === "string" &&
      id.test(entry.nodeId) &&
      typeof entry.credential === "string" &&
      entry.credential.length > 0
      ? { nodeId: entry.nodeId, credential: entry.credential }
      : null;
  };
  if (!Array.isArray(record.nodes) || record.nodes.length === 0 || record.nodes.some((value) => node(value) === null))
    throw fail("nodes must be a non-empty array of { nodeId, credential } rows");
  const nodes = record.nodes.map((value) => node(value)!),
    known = new Set(nodes.map(({ nodeId }) => nodeId));
  const assignment = record.schema === "fleet-roster/v1" ? parseFleetRosterV1Assignment : parseFleetRosterV2Assignment;
  if (
    !Array.isArray(record.assignments) ||
    record.assignments.length === 0 ||
    record.assignments.some((value) => assignment(value) === null)
  )
    throw fail("assignments must be a non-empty array of complete assignment rows");
  const assignments = record.assignments.map((value) => assignment(value)!);
  if (assignments.some(({ nodeId }) => !known.has(nodeId)))
    throw fail("every assignment nodeId must also be declared in nodes");
  return { nodes, assignments };
}

function parseFleetRosterV1Assignment(value: unknown): FleetAssignmentRecord | null {
  const entry = row(value),
    fields = ["assignmentId", "nodeId", "repoId", "taskId", "executionId", "viewId", "personId"];
  return entry &&
    fields.every((field) => typeof entry[field] === "string" && id.test(entry[field] as string)) &&
    (entry.executorId === undefined || (typeof entry.executorId === "string" && id.test(entry.executorId))) &&
    Array.isArray(entry.paths) &&
    entry.paths.length > 0 &&
    entry.paths.length <= 128 &&
    entry.paths.every((item) => typeof item === "string" && item.length > 0) &&
    timestamp(entry.expiresAt)
    ? {
        assignmentId: entry.assignmentId as string,
        nodeId: entry.nodeId as string,
        repoId: entry.repoId as string,
        viewId: entry.viewId as string,
        scope: {
          kind: "task",
          taskId: entry.taskId as string,
          executionId: entry.executionId as string,
          paths: entry.paths as string[],
        },
        expiresAt: entry.expiresAt as string,
        actor: assignmentActor(entry),
      }
    : null;
}

function parseFleetRosterV2Assignment(value: unknown): FleetAssignmentRecord | null {
  const entry = row(value),
    scope = row(entry?.scope),
    assignmentFields = [
      "assignmentId",
      "nodeId",
      "repoId",
      "viewId",
      "personId",
      "expiresAt",
      "scope",
      ...(entry?.executorId === undefined ? [] : ["executorId"]),
    ],
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
    !["assignmentId", "nodeId", "repoId", "viewId", "personId"].every(
      (field) => typeof entry[field] === "string" && id.test(entry[field] as string),
    ) ||
    (entry.executorId !== undefined && (typeof entry.executorId !== "string" || !id.test(entry.executorId))) ||
    !timestamp(entry.expiresAt) ||
    !scope ||
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
    actor: assignmentActor(entry),
  };
}

function assignmentActor(entry: Record<string, unknown>): FleetAssignmentRecord["actor"] {
  return {
    principal: { personId: entry.personId as string },
    executor: typeof entry.executorId === "string" ? { kind: "agent", id: entry.executorId } : null,
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
export function fleetCredentialFromRoster(nodeId: string, rosterPath: string): string {
  const node = readFleetRosterFile(rosterPath).nodes.find((entry) => entry.nodeId === nodeId);
  if (!node)
    throw new FleetRosterError("node_unknown", `Node ${nodeId} is not declared in the fleet roster at ${rosterPath}.`);
  return node.credential;
}
export interface FleetCenterAdmissionRequest {
  readonly host: Pick<DaemonHost, "replica" | "run" | "read" | "runtimeIngress" | "status">;
  readonly userRoot: string;
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
    credentialOf = new Map(roster.nodes.map((node) => [node.nodeId, node.credential])),
    assignmentOf = new Map(roster.assignments.map((entry) => [entry.assignmentId, entry])),
    stateRoot = input.payload.stateRoot ?? path.join(input.userRoot, "fleet");
  return {
    center: await listenFleetTls({
      host: input.host,
      stateRoot,
      key: material(input.payload.keyPath, "--key"),
      cert: material(input.payload.certPath, "--cert"),
      hostname: input.payload.bind,
      port: input.payload.port,
      replicaDiskQuotaBytes: input.payload.quotaBytes,
      authenticate: (nodeId, credential) => credentialOf.get(nodeId) === credential,
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
    readonly credential?: string;
    readonly rosterPath?: string;
    readonly assignmentId: string;
    readonly repoId: string;
    readonly viewRoot: string;
    readonly quotaBytes: number;
    readonly workspaceRoot: string;
    readonly timeoutMs?: number;
  };
}
export async function syncFleetEdgeMirror(input: FleetEdgeSyncRequest): Promise<Record<string, unknown>> {
  const credential =
    input.payload.credential ??
    (input.payload.rosterPath
      ? fleetCredentialFromRoster(input.payload.nodeId, input.payload.rosterPath)
      : (() => {
          throw new FleetRosterError(
            "credential_required",
            "Fleet edge sync requires exactly one machine credential source: --credential or --roster.",
          );
        })());
  return withFleetMirrorLock(input.payload.viewRoot, input.payload.repoId, async () => {
    const pulled = await runFleetReplicaPullClient({
      hostname: input.payload.host,
      port: input.payload.port,
      ca: material(input.payload.caPath, "--ca").toString("utf8"),
      servername: input.payload.servername,
      nodeId: input.payload.nodeId,
      credential,
      assignmentId: input.payload.assignmentId,
      viewRoot: input.payload.viewRoot,
      diskQuotaBytes: input.payload.quotaBytes,
      timeoutMs: input.payload.timeoutMs ?? 60_000,
    }).catch((error: unknown) => {
      if (error instanceof FleetRemoteError)
        throw Object.assign(
          new Error(
            `${error.message} Reissue the credential in the center roster` +
              " or correct --node-id / credential source / --assignment, then retry the edge sync.",
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
    };
  });
}
