// Curated port surface. artifact-store-writer.ts is deliberately absent:
// the write seam is flusher-only and must not be reachable from here.
export { authorizeWithAuthority, authorizationPort } from "./authorization-port.ts";
export type { AuthorizationAuthority, AuthorizationContext, AuthorizationPort } from "./authorization-port.ts";

export { ArtifactStore } from "./artifact-store.ts";

export { VcsCommandError } from "./version-control-system.ts";

export type {
  AuthorizationProvider,
  AuthorizationPolicyAdministrationPort,
  AuthorizationIdentityDirectoryPort,
  AuthorizationNodeCredentialPort,
  AuthorizationDecisionPort,
  AuthorizationPermissionDecision,
  AuthorizationNode,
  AuthorizationGrant,
  AuthorizationPolicyGroup,
} from "./identity-provider-port.ts";

export type { IdentitySessionPort } from "./identity-session-port.ts";
export type { IdentityAuthenticationContext } from "./identity-session-context.ts";
export type {
  DeviceLoginRequest,
  OidcLoginAuthority,
  OidcSessionPorts,
  OidcSessionStorePort,
  StoredSession,
  FleetDeviceLoginNotice,
} from "./identity-session-contracts.ts";

export type {
  AccessAdminRequest,
  ManagedRbacRequest,
  ManagedRbacListener,
  CertificateMode,
  IdentityManagementPort,
} from "./identity-management-port.ts";
