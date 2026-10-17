import type { managedRbacReceiptJournal } from "./managed-rbac-service.ts";

export const accessAdminOperations = Object.freeze([
  "group-list",
  "group-create",
  "group-update",
  "group-delete",
  "grant",
  "revoke",
  "grant-list",
  "permission-request-create",
  "permission-request-list",
  "permission-request-decide",
  "permission-request-withdraw",
  "effective-permissions",
  "receipt-list",
  "team-list",
  "team-create",
  "team-update",
  "team-delete",
  "team-member-add",
  "team-member-remove",
  "node-list",
  "node-register",
  "node-unregister",
  "edge-join-create",
  "edge-join-consume",
  "edge-join-status",
  "device-list",
  "device-rename",
  "device-pause",
  "device-resume",
  "device-remove",
  "device-logout-all",
  "receipt-reconcile",
  "session-lifetime",
  "session-lifetime-set",
] as const);
export type AccessAdminOperation = (typeof accessAdminOperations)[number];

export interface AccessAdminRequest {
  readonly operation?: string;
  readonly operationId?: string;
  readonly groupId?: string;
  readonly displayName?: string;
  readonly scopes?: readonly unknown[];
  readonly composites?: readonly unknown[];
  readonly expectedVersion?: string;
  readonly personId?: string;
  readonly resource?: string;
  readonly sessionLifetimeSeconds?: number;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly nodeId?: string;
  readonly systemName?: string;
  readonly platform?: string;
  readonly credentialFile?: string;
  readonly centerUrl?: string;
  readonly spkiSha256?: string;
  readonly ttlMs?: number;
  readonly inviteId?: string;
  readonly link?: string;
  readonly loginPersonId?: string;
  readonly observedSpkiSha256?: string;
  readonly requestId?: string;
  readonly requestVersion?: number;
  readonly decision?: "approve" | "reject";
  readonly rationale?: string;
}

export interface AccessAdminPorts {
  readonly fetch: typeof fetch;
  readonly now: () => string;
  readonly journal: ReturnType<typeof managedRbacReceiptJournal>;
  readonly onNodeRemoved?: (nodeId: string) => void;
}
