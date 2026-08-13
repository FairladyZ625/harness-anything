import type { FleetAssignmentBinding } from "../fleet/contract.ts";

export type DaemonTransportKind = "unix-socket" | "fleet-tls";
export interface DaemonFleetAssignmentBinding extends FleetAssignmentBinding { readonly nodeId: FleetAssignmentBinding["nodeId"]; readonly assignmentId: FleetAssignmentBinding["assignmentId"] }

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export interface DaemonAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  readonly endpoint?: string;
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  readonly assignmentBinding?: DaemonFleetAssignmentBinding;
}
