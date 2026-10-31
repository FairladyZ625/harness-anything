import type { IdentityAuthenticationContext } from "@harness-anything/kernel";
import type { AuthorizationProvider } from "@harness-anything/kernel";
import type { DaemonSessionEnvironment } from "../protocol/daemon-protocol.contract.ts";
import type { WriterEpochFenceDescriptor } from "../writer-epoch.ts";

export type DaemonTransportKind = "unix-socket" | "fleet-tls";
/** The center's Keycloak location and one service-account token, as plain data a writer can receive. */
export interface KeycloakCenterCredential {
  readonly provider: AuthorizationProvider;
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly accessToken: string;
}

/** Supplies a current center credential; a rejected token is evicted after a Keycloak 401. */
export type KeycloakCenterAuthority = (rejectedAccessToken?: string) => Promise<KeycloakCenterCredential>;

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export interface DaemonAuthenticationContext extends IdentityAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  /** Authenticated fleet node owner, established by transport admission and never by payload data. */
  readonly nodePrincipal?: { readonly nodeId: string; readonly personId: string };
  /** Unverified execution secret carried over Fleet TLS; only the center may authenticate it. */
  readonly executionCredential?: string;
  /** Keycloak-verified execution identity; never populated from a client claim. */
  readonly executionPrincipal?: import("../runtime-execution-credential.ts").RuntimeExecutionPrincipal;
  /** Transport-owned connection lifetime; never accepted from a client payload. */
  readonly connectionSignal?: AbortSignal;
  /** Validated client context for provenance only; never principal or authorization evidence. */
  readonly sessionEnvironment?: DaemonSessionEnvironment;
  readonly endpoint?: string;
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  /** Center-only admission context; never accepted from a client payload. */
  readonly writerEpoch?: number;
  readonly withWriterEpochFence?: <T>(operation: () => T) => T;
  readonly writerEpochFence?: WriterEpochFenceDescriptor;
}
