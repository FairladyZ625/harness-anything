import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import { encodeEdgeJoinLink } from "@harness-anything/daemon/internal/fleet/edge-join";
import { ACCESS_ADMIN_CHANNEL } from "../api/access-admin-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>,
  ) => void;
}

type Field = "text" | "names" | "seconds" | "optional-text";

/** The fields each operation carries to the daemon. Anything else the renderer sends is refused. */
const operationFields: Readonly<Record<string, Readonly<Record<string, Field>>>> = {
  "node-list": {},
  "device-list": {},
  "device-rename": { nodeId: "text", displayName: "text", expectedVersion: "text" },
  "device-pause": { nodeId: "text", expectedVersion: "text" },
  "device-resume": { nodeId: "text", expectedVersion: "text" },
  "device-remove": { nodeId: "text", expectedVersion: "text" },
  "device-logout-all": { expectedVersion: "text" },
  "team-list": {},
  "team-create": { teamName: "text" },
  "team-update": { teamId: "text", teamName: "text", expectedVersion: "text" },
  "team-delete": { teamId: "text", expectedVersion: "text" },
  "team-member-add": { teamId: "text", personId: "text", expectedVersion: "text" },
  "team-member-remove": { teamId: "text", personId: "text", expectedVersion: "text" },
  "group-list": {},
  "grant-list": {},
  "permission-request-list": {},
  "permission-request-create": { groupId: "text", resource: "text", rationale: "optional-text" },
  "permission-request-decide": { requestId: "text", requestVersion: "seconds", decision: "text" },
  "permission-request-withdraw": { requestId: "text", requestVersion: "seconds" },
  "receipt-list": {},
  "session-lifetime": {},
  "group-create": { groupId: "text", displayName: "text", scopes: "names", composites: "names" },
  "group-update": {
    groupId: "text",
    displayName: "text",
    scopes: "names",
    composites: "names",
    expectedVersion: "text",
  },
  "group-delete": { groupId: "text", expectedVersion: "text" },
  grant: { personId: "text", groupId: "text", resource: "text" },
  revoke: { personId: "text", groupId: "text", resource: "text" },
  "effective-permissions": { personId: "text", resource: "text" },
  "receipt-reconcile": { operationId: "text" },
  "session-lifetime-set": { sessionLifetimeSeconds: "seconds", expectedVersion: "text" },
  // The center typed join method owns invite, repository grants, snapshots, and the one-time link.
  "edge-join-create": {
    username: "text",
    email: "text",
    displayName: "text",
    personId: "text",
    repoIds: "names",
    groupIds: "names",
    nodeLabel: "optional-text",
    platform: "optional-text",
  },
  "edge-join-status": { joinId: "text" },
  "edge-join-list": {},
  "edge-join-revoke": { joinId: "text" },
};

/** Operations that change Keycloak; the main process names each one so a lost receipt can be reconciled. */
const writes: ReadonlySet<string> = new Set([
  "device-rename",
  "device-pause",
  "device-resume",
  "device-remove",
  "device-logout-all",
  "team-create",
  "team-update",
  "team-delete",
  "team-member-add",
  "team-member-remove",
  "group-create",
  "group-update",
  "group-delete",
  "grant",
  "revoke",
  "session-lifetime-set",
  "permission-request-decide",
  "permission-request-withdraw",
]);

/**
 * Access administration for the renderer. The daemon holds the Keycloak credentials and decides who
 * may administer; this handler only carries a typed request to it and its answer back, refusals included.
 */
export function registerAccessAdminIpc(
  registrar: Registrar,
  trustPolicy: IpcWebContentsTrustPolicy,
  ports: {
    readonly daemonRequest: (params: JsonObject) => Promise<JsonObject>;
    readonly operationId: () => string;
  },
): void {
  registrar.handle(ACCESS_ADMIN_CHANNEL, async (event, input) => {
    assertTrustedIpcSender(event, trustPolicy);
    const params = accessAdminParams(input, ports.operationId);
    const reply = await ports.daemonRequest(params);
    return params.operation === "edge-join-create" ? edgeJoinIssuedReply(reply) : reply;
  });
}

/**
 * The daemon's edge-join-create success carries the invitation as a struct — token included. The
 * renderer receives the closed form instead: the HTTPS fragment link plus the
 * facts the panel displays, so the token crosses the IPC boundary exactly once and never as a
 * second struct copy. Refusals pass through untouched.
 */
function edgeJoinIssuedReply(reply: JsonObject): JsonObject {
  if (reply.ok !== true) return reply;
  const link = reply.link;
  if (typeof link !== "object" || link === null || Array.isArray(link))
    throw new Error("Edge join creation returned no invitation link.");
  return {
    ok: true,
    joinId: reply.joinId,
    state: reply.state,
    expiresAt: reply.expiresAt,
    inviteLink: encodeEdgeJoinLink(link as unknown as Parameters<typeof encodeEdgeJoinLink>[0]),
  };
}

export function accessAdminParams(input: unknown, operationId: () => string): JsonObject {
  const request = (typeof input === "object" && input !== null ? input : {}) as Readonly<Record<string, unknown>>,
    operation = String(request.operation),
    fields = Object.hasOwn(operationFields, operation) ? operationFields[operation] : undefined;
  if (!fields) throw new Error(`Access administration does not offer ${operation}.`);
  const unknown = Object.keys(request).filter(
    (key) => key !== "operation" && key !== "repoId" && !Object.hasOwn(fields, key),
  );
  if (unknown.length > 0) throw new Error(`Access administration ${operation} does not take ${unknown.join(", ")}.`);
  const params: Record<string, string | number | readonly string[]> = { operation };
  if (request.repoId !== undefined) {
    if (typeof request.repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(request.repoId))
      throw new Error("Select a valid access administration target.");
    params.repoId = request.repoId;
  }
  for (const [name, field] of Object.entries(fields)) {
    const value = request[name],
      valid =
        field === "text"
          ? typeof value === "string" && value.trim() !== ""
          : field === "optional-text"
            ? value === undefined || (typeof value === "string" && value.trim() !== "")
            : field === "names"
              ? Array.isArray(value) && value.every((item) => typeof item === "string")
              : Number.isInteger(value);
    if (!valid) throw new Error(`Access administration ${operation} requires ${name}.`);
    if (value === undefined) continue;
    if (name === "decision" && value !== "approve" && value !== "reject") throw new Error("Choose approve or reject.");
    params[name] = value as string | number | readonly string[];
  }
  if (writes.has(operation)) params.operationId = operationId();
  return params as JsonObject;
}
