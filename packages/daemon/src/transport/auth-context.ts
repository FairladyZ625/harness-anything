import type { FleetAssignmentBinding } from "../fleet/contract.ts";

export type DaemonTransportKind = "unix-socket" | "fleet-tls";
export interface DaemonFleetAssignmentBinding extends FleetAssignmentBinding { readonly nodeId: FleetAssignmentBinding["nodeId"]; readonly assignmentId: FleetAssignmentBinding["assignmentId"] }

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export interface DaemonAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  /** Transport-owned connection lifetime; never accepted from a client payload. */
  readonly connectionSignal?: AbortSignal;
  readonly endpoint?: string;
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  readonly assignmentBinding?: DaemonFleetAssignmentBinding;
  /** Center-only admission context; never accepted from a client payload. */
  readonly writerEpoch?: number;
  readonly assertWriterEpoch?: () => void;
  readonly withWriterEpochFence?: <T>(operation: () => T) => T;
}
