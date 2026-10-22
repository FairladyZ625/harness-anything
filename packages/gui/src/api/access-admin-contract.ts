import type { EdgeJoinPlatform } from "@harness-anything/daemon/protocol";

export type { EdgeJoinPlatform };

export const ACCESS_ADMIN_CHANNEL = "harness:access:admin";

/** The facets of one declared action, as the daemon reads them from ActionDeclaration. */
export interface AccessAction {
  readonly action: string;
  readonly presentation: { readonly domain: string; readonly name: string; readonly description: string };
  readonly executionClass: "repo-read" | "repo-write" | "arbiter" | "admin";
  readonly policyTier: "viewer" | "contributor" | "maintainer" | "admin";
  readonly residencyScope: "canonical" | "runtime-local" | "host-local";
}

export interface AccessPolicyGroup {
  readonly id: string;
  readonly base: boolean;
  readonly displayName: string;
  /** Actions the group names itself, before inheritance. */
  readonly scopes: readonly string[];
  readonly composites: readonly string[];
  readonly effectiveScopes: readonly string[];
  readonly version: string;
}

export interface AccessGrant {
  readonly personId: string;
  readonly groupId: string;
  readonly resource: string;
}

export interface PermissionRequest {
  readonly requestId: string;
  readonly version: number;
  readonly state: "pending" | "approved" | "rejected" | "withdrawn";
  readonly personId: string;
  readonly groupId: string;
  readonly resource: string;
  readonly actions: readonly string[];
  readonly rationale: string;
  readonly createdAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
}

/** One administration operation as the audit journal holds it; `phase: "intent"` has no settled receipt yet. */
export interface AccessReceipt {
  readonly operationId: string;
  readonly operation: string;
  readonly actor: string;
  readonly phase: "intent" | "settled";
  readonly outcome?: "applied" | "failed" | "version_conflict";
  readonly recordedAt?: string;
  readonly settledAt?: string;
  readonly groupId?: string;
  readonly expect?:
    | { readonly kind: "group"; readonly groupId: string }
    | { readonly kind: "grant"; readonly groupId: string; readonly resource: string; readonly personId: string }
    | { readonly kind: "session-lifetime"; readonly seconds: number };
}

/** A daemon refusal. `version_conflict` carries the version the caller read and the one Keycloak holds now. */
export interface AccessRejection {
  readonly ok: false;
  readonly code: string;
  readonly rejectionExplanation?: string;
  readonly groupId?: string;
  readonly expectedVersion?: string;
  readonly currentVersion?: string;
}

type Reply<T> = Promise<({ readonly ok: true } & T) | AccessRejection>;

export interface AccessTeam {
  readonly id: string;
  readonly name: string;
  readonly personIds: readonly string[];
  readonly version: string;
}
export interface AccessTeamsReply {
  readonly teams: readonly AccessTeam[];
  readonly people: readonly { readonly personId: string; readonly username: string }[];
}
export interface AccessTeamChange {
  readonly teamId: string;
  readonly expectedVersion: string;
}

export interface AccessGroupsReply {
  readonly groups: readonly AccessPolicyGroup[];
  readonly actions: readonly AccessAction[];
}

export interface AccessGrantsReply {
  readonly people: readonly { readonly personId: string; readonly username: string }[];
  readonly grants: readonly AccessGrant[];
}

export interface AccessEffectivePermissionsReply {
  readonly personId: string;
  readonly resource: string;
  readonly grants: readonly {
    readonly groupId: string;
    readonly resource: string;
    readonly inheritedGroups: readonly string[];
  }[];
  readonly actions: readonly {
    readonly action: string;
    readonly sources: readonly {
      readonly grantedGroup: string;
      readonly sourceGroup: string;
      readonly resource: string;
    }[];
  }[];
  readonly receipts: readonly AccessReceipt[];
}

export interface AccessSessionLifetimeReply {
  readonly seconds: number;
  readonly version: string;
  readonly minimumSeconds: number;
  readonly maximumSeconds: number;
}

/** One signed edge invitation. The daemon returns the pasteable link as a harness-edge URI string. */
export interface EdgeJoinIssued {
  readonly joinId: string;
  readonly state: "pending";
  readonly expiresAt: string;
  readonly link: string;
}

/** Status contains no token or credential. */
export interface EdgeJoinStatusReply {
  readonly joinId: string;
  readonly state: "pending" | "consumed" | "expired" | "revoked";
  readonly nodeId?: string;
  readonly tunnelState?: "connecting" | "connected" | "reconnecting" | "stopped";
}
export interface EdgeJoinSummary extends EdgeJoinStatusReply {
  readonly personId: string;
  readonly repoIds: readonly string[];
  readonly groupIds: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly transport?: "ssh-reverse";
}

export interface AccessGroupWrite {
  readonly groupId: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly composites: readonly string[];
}

/** What the renderer may ask of access administration; the main process adds the operation id of each write. */
export type AccessAdminRequest = { readonly repoId?: string } & (
  | {
      readonly operation:
        | "device-list"
        | "node-list"
        | "team-list"
        | "group-list"
        | "grant-list"
        | "permission-request-list"
        | "receipt-list"
        | "session-lifetime";
    }
  | ({ readonly operation: "device-rename"; readonly displayName: string } & AccessDeviceChange)
  | ({ readonly operation: "device-pause" | "device-resume" | "device-remove" } & AccessDeviceChange)
  | { readonly operation: "device-logout-all"; readonly expectedVersion: string }
  | { readonly operation: "team-create"; readonly teamName: string }
  | ({ readonly operation: "team-update"; readonly teamName: string } & AccessTeamChange)
  | ({ readonly operation: "team-delete" } & AccessTeamChange)
  | ({ readonly operation: "team-member-add" | "team-member-remove"; readonly personId: string } & AccessTeamChange)
  | ({ readonly operation: "group-create" } & AccessGroupWrite)
  | ({ readonly operation: "group-update"; readonly expectedVersion: string } & AccessGroupWrite)
  | { readonly operation: "group-delete"; readonly groupId: string; readonly expectedVersion: string }
  | ({ readonly operation: "grant" | "revoke" } & AccessGrant)
  | {
      readonly operation: "permission-request-create";
      readonly groupId: string;
      readonly resource: string;
      readonly rationale?: string;
    }
  | {
      readonly operation: "permission-request-decide";
      readonly requestId: string;
      readonly requestVersion: number;
      readonly decision: "approve" | "reject";
    }
  | { readonly operation: "permission-request-withdraw"; readonly requestId: string; readonly requestVersion: number }
  | { readonly operation: "effective-permissions"; readonly personId: string; readonly resource: string }
  | { readonly operation: "receipt-reconcile"; readonly operationId: string }
  | {
      readonly operation: "session-lifetime-set";
      readonly sessionLifetimeSeconds: number;
      readonly expectedVersion: string;
    }
  | {
      /**
       * Creates the invited Keycloak user, multi-repository grants and one-time pinned link on the daemon
       * writer. Username, email, and displayName create a new member; an existing person is invited without them.
       */
      readonly operation: "edge-join-create";
      readonly personId: string;
      readonly username?: string;
      readonly email?: string;
      readonly displayName?: string;
      readonly repoIds: readonly string[];
      readonly groupIds: readonly string[];
      readonly nodeLabel?: string;
      readonly platform?: EdgeJoinPlatform;
      readonly transport?: "direct" | "ssh-reverse";
      readonly sshTarget?: string;
    }
  | { readonly operation: "edge-join-status"; readonly joinId: string }
  | { readonly operation: "edge-join-list" }
  | { readonly operation: "edge-join-revoke"; readonly joinId: string }
);

export interface AccessDevice {
  readonly nodeId: string;
  readonly personId: string;
  readonly systemName: string;
  readonly displayName: string;
  readonly platform: string;
  readonly registeredAt: string;
  readonly state: "active" | "paused" | "removed";
  readonly revocation: "pending" | "complete";
  readonly version: string;
}
export interface AccessDeviceChange {
  readonly nodeId: string;
  readonly expectedVersion: string;
}

export interface AccessAdminApi {
  readonly forRepository: (repoId?: string) => AccessAdminApi;
  readonly nodes: () => Reply<{
    readonly nodes: readonly { readonly nodeId: string; readonly personId: string; readonly version: string }[];
  }>;
  readonly devices: () => Reply<{ readonly nodes: readonly AccessDevice[]; readonly version: string }>;
  readonly renameDevice: (input: AccessDeviceChange & { readonly displayName: string }) => Reply<AccessReceipt>;
  readonly pauseDevice: (input: AccessDeviceChange) => Reply<AccessReceipt>;
  readonly resumeDevice: (input: AccessDeviceChange) => Reply<AccessReceipt>;
  readonly removeDevice: (input: AccessDeviceChange) => Reply<AccessReceipt>;
  readonly logoutDevices: (input: { readonly expectedVersion: string }) => Reply<AccessReceipt>;
  readonly teams: () => Reply<AccessTeamsReply>;
  readonly createTeam: (input: { readonly teamName: string }) => Reply<AccessReceipt>;
  readonly updateTeam: (input: AccessTeamChange & { readonly teamName: string }) => Reply<AccessReceipt>;
  readonly deleteTeam: (input: AccessTeamChange) => Reply<AccessReceipt>;
  readonly addTeamMember: (input: AccessTeamChange & { readonly personId: string }) => Reply<AccessReceipt>;
  readonly removeTeamMember: (input: AccessTeamChange & { readonly personId: string }) => Reply<AccessReceipt>;
  readonly groups: () => Reply<AccessGroupsReply>;
  readonly createGroup: (input: AccessGroupWrite) => Reply<AccessReceipt>;
  readonly updateGroup: (input: AccessGroupWrite & { readonly expectedVersion: string }) => Reply<AccessReceipt>;
  readonly deleteGroup: (input: { readonly groupId: string; readonly expectedVersion: string }) => Reply<AccessReceipt>;
  readonly grants: () => Reply<AccessGrantsReply>;
  readonly permissionRequests: () => Reply<{
    readonly canDecide: boolean;
    readonly requests: readonly PermissionRequest[];
  }>;
  readonly requestPermission: (input: {
    readonly groupId: string;
    readonly resource: string;
    readonly rationale?: string;
  }) => Reply<{ readonly request: PermissionRequest }>;
  readonly decidePermissionRequest: (input: {
    readonly requestId: string;
    readonly requestVersion: number;
    readonly decision: "approve" | "reject";
  }) => Reply<{ readonly request: PermissionRequest }>;
  readonly withdrawPermissionRequest: (input: {
    readonly requestId: string;
    readonly requestVersion: number;
  }) => Reply<{ readonly request: PermissionRequest }>;
  readonly grant: (input: AccessGrant) => Reply<AccessReceipt>;
  readonly revoke: (input: AccessGrant) => Reply<AccessReceipt>;
  readonly effectivePermissions: (input: {
    readonly personId: string;
    readonly resource: string;
  }) => Reply<AccessEffectivePermissionsReply>;
  readonly receipts: () => Reply<{ readonly receipts: readonly AccessReceipt[] }>;
  readonly reconcile: (input: { readonly operationId: string }) => Reply<AccessReceipt>;
  readonly sessionLifetime: () => Reply<AccessSessionLifetimeReply>;
  readonly setSessionLifetime: (input: {
    readonly sessionLifetimeSeconds: number;
    readonly expectedVersion: string;
  }) => Reply<AccessReceipt>;
  readonly issueEdgeJoin: (input: {
    readonly personId: string;
    /** New-member fields; the daemon ignores them when the person already exists. */
    readonly username?: string;
    readonly email?: string;
    readonly displayName?: string;
    readonly repoIds: readonly string[];
    readonly groupIds: readonly string[];
    readonly nodeLabel?: string;
    readonly platform?: EdgeJoinPlatform;
  }) => Reply<EdgeJoinIssued>;
  readonly edgeJoinStatus: (input: { readonly joinId: string }) => Reply<EdgeJoinStatusReply>;
  readonly edgeJoinList: () => Reply<{ readonly joins: readonly EdgeJoinSummary[] }>;
  readonly revokeEdgeJoin: (input: { readonly joinId: string }) => Reply<EdgeJoinStatusReply>;
}
