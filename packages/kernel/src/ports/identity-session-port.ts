import type { AuthorizationProvider } from "./identity-provider-port.ts";
import type { IdentityAuthenticationContext } from "./identity-session-context.ts";
import type { OidcLoginAuthority, StoredSession, FleetDeviceLoginNotice } from "./identity-session-contracts.ts";
/**
 * Daemon-owned PKCE and Device session. Refresh tokens stay here; a short-lived access token may
 * accompany a fleet request as transient authentication metadata.
 * Access tokens stay short-lived. Ordinary SSO and offline idle limits are separate provider
 * policies; an offline token's refresh_expires_in does not set a local session deadline.
 */
export interface IdentitySessionPort {
  begin(redirectUri: string, loginTarget?: string): Promise<Record<string, unknown>>;
  complete(code: string, state: string): Promise<Record<string, unknown>>;
  beginDevice(
    loginTarget?: string,
    authorityOverride?: OidcLoginAuthority,
    expiresAtLimit?: number,
  ): Promise<Record<string, unknown>>;
  revokeDeviceSessions?(nodeId: string): Promise<void>;
  receiveDeviceNotice?(nodeId: string, personId: string, notice: FleetDeviceLoginNotice): void;
  deviceApproval(userCode: string, loginTarget?: string): Promise<Record<string, unknown>>;
  pollDevice(): Promise<Record<string, unknown>>;
  /** `expiresAt` is the SSO deadline, or null when Keycloak decides offline validity on refresh. */
  status(loginTarget?: string): Promise<Record<string, unknown>>;
  /** Read the selected edge's public authority, independently of this daemon's signed-in session. */
  bindingHealth(loginTarget: string): Promise<Record<string, unknown>>;
  /** Queued behind a renewal in flight, so a session that is being renewed stays signed out. */
  logout(loginTarget?: string): Promise<Record<string, unknown>>;
  bootstrapStatus(): Promise<Record<string, unknown>>;
  /** Public metadata carried by new edge invitations; contains no secret or session token. */
  interactiveAuthority(): Promise<{
    readonly url: string;
    readonly realm: string;
    readonly clientId: string;
    readonly certificate?: string;
  }>;
  /** Whether a Keycloak authority exists at all; without one no request can ever authorize, so callers guide to ha bootstrap. */
  configured(): boolean;
  /** Rejects collaboration-only operations when the selected provider is single-machine builtin. */
  requireCollaboration(): void;
  /** Whether the daemon has the center service credential needed for ownership claims. */
  centerConfigured(): boolean;
  /**
   * Binds the signed-in person to a request. While Keycloak cannot be reached to renew the session
   * only a server-selected edge replica read may retain its unexpired session identity.
   * Every online caller still requires a usable access token.
   */
  bind<T extends IdentityAuthenticationContext>(
    auth: T,
    loginTarget?: string,
    replicaRead?: boolean,
  ): Promise<T & IdentityAuthenticationContext>;
  /** Public metadata comes from the center; an edge never writes a second Keycloak configuration. */
  discovery(nodeId: string): OidcLoginAuthority | null;
  requireRole(role: string, loginTarget?: string): Promise<StoredSession>;
  /** Device administration must observe external session revocation before using center Admin REST. */
  requireSession(loginTarget?: string): Promise<StoredSession>;
  /**
   * The center's single write queue for Keycloak authorization state: first-administrator bootstrap, listener changes
   * and every policy-group or grant mutation run one at a time, each against the state the previous left.
   * Session renewals share it, so concurrent uses of one session renew it once.
   */
  serialize<T>(operation: () => Promise<T>): Promise<T>;
  /** D1: original-socket configuration is open until the first administrator exists. */
  configureAuthority<T>(operation: () => Promise<T>, loginTarget?: string): Promise<T>;
  center(rejectedAccessToken?: string): Promise<{
    readonly url: string;
    readonly realm: string;
    readonly accessToken: string;
    readonly provider: AuthorizationProvider;
  }>;
  bootstrapAdmin(input: {
    readonly username: string;
    readonly email: string;
    readonly displayName: string;
    readonly password: string;
    readonly personId: string;
  }): Promise<Record<string, unknown>>;
  invite(
    input: {
      readonly username: string;
      readonly email: string;
      readonly displayName: string;
      readonly personId: string;
    },
    withinWriter?: boolean,
    loginTarget?: string,
  ): Promise<Record<string, unknown>>;
  /**
   * A provider may exchange a one-time center admission for a short-lived human
   * session.  Fleet uses this only for providers without a remote login service.
   */
  issueInvitationSession?(personId: string, withinWriter?: boolean): Promise<StoredSession>;
  /** Import a center-issued session onto an edge without copying identity state. */
  importSession?(session: StoredSession, withinWriter?: boolean): Promise<void>;
}
