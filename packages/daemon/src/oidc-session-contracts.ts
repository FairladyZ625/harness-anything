import type { randomBytes } from "node:crypto";
import type { FleetDeviceLoginNotice } from "./fleet/command-protocol.ts";

export interface OidcLoginAuthority {
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly browserUrl?: string;
  readonly certificate?: string;
  readonly servername?: string;
}

export interface DeviceLoginRequest {
  readonly nodeId: string;
  readonly personId: string;
  readonly userCode: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly verificationUriComplete: string;
}

export interface OidcSessionStorePort {
  readonly read: () => string | undefined;
  readonly write: (value: string) => void;
  readonly delete: () => void;
  readonly retireBootstrap: () => void;
}

export interface OidcSessionPorts {
  readonly fetch: typeof fetch;
  /** Test seam for public and OS TLS trust roots; production excludes NODE_EXTRA_CA_CERTS. */
  readonly defaultCaCertificates?: () => readonly string[];
  readonly now: () => number;
  readonly randomBytes: typeof randomBytes;
  readonly sessionStore: OidcSessionStorePort;
  readonly reportDevice?: (target: string, notice: FleetDeviceLoginNotice) => Promise<void>;
  readonly loginAuthority?: (target: string) => Promise<OidcLoginAuthority>;
}

export interface StoredSession {
  readonly schema: "harness-oidc-session/v2";
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly subject: string;
  readonly personId: string;
  /** When the access token lapses; a use at or near this moment renews it first. */
  readonly expiresAt: number;
  /** Ordinary SSO expiry; offline sessions have no locally inferred deadline. Keycloak decides on refresh. */
  readonly sessionExpiresAt: number | null;
  readonly roles: readonly string[];
  readonly loginTarget?: string;
  /** The Keycloak issuer this session was issued by; binding a request reads it instead of asking the center. */
  readonly authority?: {
    readonly url: string;
    readonly realm: string;
    readonly clientId?: string;
    readonly certificate?: string;
    readonly servername?: string;
  };
}
