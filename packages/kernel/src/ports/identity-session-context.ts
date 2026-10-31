import type { AuthorizationProvider } from "./identity-provider-port.ts";
export interface IdentityAuthenticationContext {
  readonly transportKind: "unix-socket" | "fleet-tls";
  /** Principal established by the daemon's OIDC session service; never accepted from JSON-RPC payloads. */
  readonly oidcPrincipal?: {
    readonly provider: AuthorizationProvider;
    readonly personId: string;
    readonly subject: string;
    readonly expiresAt: number;
    readonly accessToken: string;
    readonly authority: {
      readonly url: string;
      readonly realm: string;
      readonly clientId: string;
      /** Public CA root selected by the invitation; used only for matching that invitation on reuse. */
      readonly certificate?: string;
    };
  };
  /** Resolves the bound local login token at use time; never supplied by a fleet client. */
  readonly localSessionAccessToken?: () => Promise<string>;
  /** Daemon-owned identity for an unreachable renewal, usable only in a server-selected edge replica read. */
  readonly replicaReadPrincipal?: { readonly personId: string; readonly sessionExpiresAt: number | null };
  /** Center service authority for evaluating a person who holds no token here; attached by the host only. */
  readonly keycloakCenter?: (rejectedAccessToken?: string) => Promise<{
    readonly url: string;
    readonly realm: string;
    readonly clientId: string;
    readonly accessToken: string;
    readonly provider: AuthorizationProvider;
  }>;
  /** The authenticated node and its owner from the center node registry; never accepted from a fleet frame. */
  readonly nodePrincipal?: { readonly nodeId: string; readonly personId: string };
  /** Transient fleet credential, consumed by the center's online introspection, never action data. */
  readonly humanAccessToken?: string;
  /** Center-selected clients for invitation-bound sessions; never accepted from a fleet payload. */
  readonly fleetExpectedAzps?: readonly { readonly clientId: string; readonly personId?: string }[];
}
