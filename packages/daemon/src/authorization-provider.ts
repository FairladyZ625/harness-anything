import {
  KeycloakPolicyAdapter,
  keycloakLoginAttributes,
  keycloakLoginMappers,
} from "@harness-anything/authorization-keycloak";
import type { AuthorizationResource, PolicyGroup } from "@harness-anything/kernel";

export interface AuthorizationPolicyGroup extends PolicyGroup {
  readonly displayName: string;
}

export interface AuthorizationGrant {
  readonly groupId: string;
  readonly resource: string;
  readonly userIds: readonly string[];
}

export interface AuthorizationNode {
  readonly nodeId: string;
  readonly personId: string;
  readonly systemName: string;
  readonly displayName: string;
  readonly platform: string;
  readonly registeredAt: string;
  readonly state: "active" | "paused" | "removed";
  readonly revision: number;
  readonly revocation: "complete" | "pending";
}

export interface AuthorizationPermissionDecision {
  readonly outcome: "allowed" | "denied";
  readonly reasonCode: string;
  readonly resource: string;
  readonly scope: string;
}

export interface AuthorizationPolicyAdministrationPort {
  readonly syncBasePolicy: (
    adminAccessToken: string,
  ) => Promise<{ readonly scopeCount: number; readonly groupCount: number }>;
  readonly validatePolicyGroups: (groups: readonly PolicyGroup[]) => void;
  readonly syncLoginClients: (adminAccessToken: string) => Promise<void>;
  readonly readPolicyGroups: (adminAccessToken: string) => Promise<readonly AuthorizationPolicyGroup[]>;
  readonly writePolicyGroup: (
    adminAccessToken: string,
    group: AuthorizationPolicyGroup,
    current: AuthorizationPolicyGroup | undefined,
  ) => Promise<void>;
  readonly deletePolicyGroup: (adminAccessToken: string, groupId: string) => Promise<void>;
  readonly readGrants: (adminAccessToken: string) => Promise<readonly AuthorizationGrant[]>;
  readonly writeGrant: (
    adminAccessToken: string,
    grant: AuthorizationGrant,
    scopes: readonly string[],
  ) => Promise<void>;
  readonly claimRepositoryOwner: (adminAccessToken: string, repoId: string, personId: string) => Promise<void>;
  readonly materializeGrants: (adminAccessToken: string, groupIds?: ReadonlySet<string>) => Promise<void>;
}

export interface AuthorizationIdentityDirectoryPort {
  readonly readPeople: (
    adminAccessToken: string,
  ) => Promise<readonly { readonly userId: string; readonly personId: string; readonly username: string }[]>;
  readonly findUserId: (adminAccessToken: string, personId: string) => Promise<string | undefined>;
  readonly readPersonTeams: (adminAccessToken: string, personId: string) => Promise<readonly string[]>;
  readonly readTeam: (
    adminAccessToken: string,
    teamId: string,
  ) => Promise<{ readonly id: string; readonly name: string }>;
  readonly readTeams: (adminAccessToken: string) => Promise<readonly { readonly id: string; readonly name: string }[]>;
  readonly readTeamMembers: (adminAccessToken: string, teamId: string) => Promise<readonly string[]>;
  readonly createTeam: (adminAccessToken: string, name: string) => Promise<void>;
  readonly updateTeam: (adminAccessToken: string, teamId: string, name: string) => Promise<void>;
  readonly deleteTeam: (adminAccessToken: string, teamId: string) => Promise<void>;
  readonly setTeamMember: (adminAccessToken: string, teamId: string, userId: string, held: boolean) => Promise<void>;
}

export interface AuthorizationNodeCredentialPort {
  readonly readNodes: (adminAccessToken: string) => Promise<readonly AuthorizationNode[]>;
  readonly readNode: (adminAccessToken: string, nodeId: string) => Promise<AuthorizationNode | undefined>;
  readonly createNode: (
    adminAccessToken: string,
    registration: Pick<AuthorizationNode, "nodeId" | "personId"> &
      Partial<Pick<AuthorizationNode, "systemName" | "displayName" | "platform" | "registeredAt">>,
    secret: string,
  ) => Promise<void>;
  readonly writeNode: (adminAccessToken: string, node: AuthorizationNode) => Promise<void>;
  readonly rotateNodeCredential: (adminAccessToken: string, node: AuthorizationNode, secret: string) => Promise<void>;
  readonly deleteNode: (adminAccessToken: string, nodeId: string) => Promise<void>;
  readonly revokeNode: (adminAccessToken: string, node: AuthorizationNode) => Promise<void>;
  readonly transferNode: (adminAccessToken: string, node: AuthorizationNode, previousPersonId: string) => Promise<void>;
  readonly revokeNodes: (adminAccessToken: string, nodes: readonly AuthorizationNode[]) => Promise<void>;
  readonly revokeNodeConsent: (adminAccessToken: string, nodeId: string, personId?: string) => Promise<void>;
  readonly authenticateNode: (nodeId: string, credential: string) => Promise<boolean>;
}

export interface AuthorizationDecisionPort {
  readonly authorize: (input: {
    readonly userAccessToken: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
    readonly resourceAncestors?: readonly AuthorizationResource[];
  }) => Promise<AuthorizationPermissionDecision>;
  readonly authorizePerson: (input: {
    readonly adminAccessToken: string;
    readonly personId: string;
    readonly action: string;
    readonly resource: AuthorizationResource;
    readonly resourceAncestors?: readonly AuthorizationResource[];
  }) => Promise<AuthorizationPermissionDecision>;
  readonly validateUserAccessToken: (token: string, personId: string) => Promise<boolean>;
}

/**
 * Composition-root seam for the configured identity provider. Callers use this structural
 * capability instead of constructing a provider implementation or importing its package.
 */
/**
 * The daemon-facing capability contract. The implementation class is intentionally hidden behind
 * this structural surface, so a replacement provider can satisfy the same operations without
 * importing the Keycloak package into daemon consumers.
 */
export type AuthorizationProvider = AuthorizationPolicyAdministrationPort &
  AuthorizationIdentityDirectoryPort &
  AuthorizationNodeCredentialPort &
  AuthorizationDecisionPort;
export interface AuthorizationProviderConfig {
  readonly url: string;
  readonly realm: string;
  readonly resourceServerClientId: string;
}
export { keycloakLoginAttributes, keycloakLoginMappers };

export function createAuthorizationProvider(
  config: AuthorizationProviderConfig,
  fetchPort?: typeof fetch,
  refreshAdminAccessToken?: (rejectedAccessToken: string) => Promise<string>,
): AuthorizationProvider {
  return new KeycloakPolicyAdapter(config, fetchPort, refreshAdminAccessToken);
}
