export const ACCESS_ADMIN_CHANNEL = "harness:access:admin";

/** The facets of one declared action, as the daemon reads them from ActionDeclaration. */
export interface AccessAction {
  readonly action: string;
  readonly executionClass: "repo-write" | "arbiter" | "admin";
  readonly policyTier: "contributor" | "maintainer" | "admin";
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

export interface AccessGroupWrite {
  readonly groupId: string;
  readonly displayName: string;
  readonly scopes: readonly string[];
  readonly composites: readonly string[];
}

/** What the renderer may ask of access administration; the main process adds the operation id of each write. */
export type AccessAdminRequest = { readonly repoId?: string } & (
  | { readonly operation: "team-list" | "group-list" | "grant-list" | "receipt-list" | "session-lifetime" }
  | { readonly operation: "team-create"; readonly teamName: string }
  | ({ readonly operation: "team-update"; readonly teamName: string } & AccessTeamChange)
  | ({ readonly operation: "team-delete" } & AccessTeamChange)
  | ({ readonly operation: "team-member-add" | "team-member-remove"; readonly personId: string } & AccessTeamChange)
  | ({ readonly operation: "group-create" } & AccessGroupWrite)
  | ({ readonly operation: "group-update"; readonly expectedVersion: string } & AccessGroupWrite)
  | { readonly operation: "group-delete"; readonly groupId: string; readonly expectedVersion: string }
  | ({ readonly operation: "grant" | "revoke" } & AccessGrant)
  | { readonly operation: "effective-permissions"; readonly personId: string; readonly resource: string }
  | { readonly operation: "receipt-reconcile"; readonly operationId: string }
  | {
      readonly operation: "session-lifetime-set";
      readonly sessionLifetimeSeconds: number;
      readonly expectedVersion: string;
    }
);

export interface AccessAdminApi {
  readonly forRepository: (repoId?: string) => AccessAdminApi;
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
}
