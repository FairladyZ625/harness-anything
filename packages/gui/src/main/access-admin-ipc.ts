import type { IpcMainInvokeEvent } from "electron";
import type { JsonObject } from "@harness-anything/daemon";
import { ACCESS_ADMIN_CHANNEL } from "../api/access-admin-contract.ts";
import { assertTrustedIpcSender } from "./ipc-handlers.ts";
import type { IpcWebContentsTrustPolicy } from "./security-policy.ts";

interface Registrar {
  readonly handle: (
    channel: string,
    listener: (event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>,
  ) => void;
}

type Field = "text" | "names" | "seconds";

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
    return ports.daemonRequest(accessAdminParams(input, ports.operationId));
  });
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
          : field === "names"
            ? Array.isArray(value) && value.every((item) => typeof item === "string")
            : Number.isInteger(value);
    if (!valid) throw new Error(`Access administration ${operation} requires ${name}.`);
    params[name] = value as string | number | readonly string[];
  }
  if (writes.has(operation)) params.operationId = operationId();
  return params as JsonObject;
}
