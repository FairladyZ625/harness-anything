import type { FleetAssignmentBinding } from "../fleet/contract.ts";
import type { DaemonSessionEnvironment } from "../protocol/daemon-protocol.contract.ts";
import type { WriterEpochFenceDescriptor } from "../writer-epoch.ts";

export type DaemonTransportKind = "unix-socket" | "fleet-tls";
export interface DaemonFleetAssignmentBinding extends FleetAssignmentBinding {
  readonly nodeId: FleetAssignmentBinding["nodeId"];
  readonly assignmentId: FleetAssignmentBinding["assignmentId"];
}

/** The center's Keycloak location and one service-account token, as plain data a writer can receive. */
export interface KeycloakCenterCredential {
  readonly url: string;
  readonly realm: string;
  readonly clientId: string;
  readonly accessToken: string;
}

/** Mints a fresh center credential; the host calls it once per request that needs one. */
export type KeycloakCenterAuthority = () => Promise<KeycloakCenterCredential>;

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export interface DaemonAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  /** Transport-owned connection lifetime; never accepted from a client payload. */
  readonly connectionSignal?: AbortSignal;
  /** Validated client context for provenance only; never principal or authorization evidence. */
  readonly sessionEnvironment?: DaemonSessionEnvironment;
  readonly endpoint?: string;
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  /** Principal established by the daemon's OIDC session service; never accepted from JSON-RPC payloads. */
  readonly oidcPrincipal?: {
    readonly personId: string;
    readonly subject: string;
    readonly expiresAt: number;
    readonly accessToken: string;
    readonly authority: { readonly url: string; readonly realm: string; readonly clientId: string };
  };
  /** Center service authority for evaluating a person who holds no token here; attached by the host only. */
  readonly keycloakCenter?: KeycloakCenterAuthority;
  readonly assignmentBinding?: DaemonFleetAssignmentBinding;
  /** The authenticated node and its owner from the center node registry; never accepted from a fleet frame. */
  readonly nodePrincipal?: { readonly nodeId: string; readonly personId: string };
  /** Transient fleet credential, consumed by the center's online introspection, never action data. */
  readonly humanAccessToken?: string;
  /** Center-only admission context; never accepted from a client payload. */
  readonly writerEpoch?: number;
  readonly withWriterEpochFence?: <T>(operation: () => T) => T;
  readonly writerEpochFence?: WriterEpochFenceDescriptor;
}
