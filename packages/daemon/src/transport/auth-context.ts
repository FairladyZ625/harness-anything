export type DaemonTransportKind = "unix-socket";

export interface UnixSocketOwnerBoundary {
  readonly ownerUid: number;
  readonly source: "unix-socket-filesystem-owner-boundary";
}

export interface DaemonAuthenticationContext {
  readonly transportKind: DaemonTransportKind;
  readonly endpoint?: string;
  readonly unixSocketOwnerBoundary?: UnixSocketOwnerBoundary;
  /** Future Fleet ingress supplies this only after assignment lookup/authentication. */
  readonly assignmentBinding?: {
    readonly nodeId: string; readonly repoId: string; readonly taskId: string; readonly executionId: string;
    readonly assignmentId: string; readonly paths: readonly string[];
    readonly actor: {
      readonly principal: { readonly personId: string };
      readonly executor: { readonly kind: "agent"; readonly id: string } | null;
    };
  };
}
