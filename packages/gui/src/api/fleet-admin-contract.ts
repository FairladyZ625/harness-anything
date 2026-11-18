export interface FleetNodeUnregisterInput {
  readonly nodeId: string;
  readonly expectedVersion?: string;
  readonly confirm?: boolean;
  readonly force?: boolean;
}

export interface FleetAdminApi {
  readonly unregisterNode: (input: FleetNodeUnregisterInput) => Promise<Record<string, unknown>>;
  readonly forRepository?: (repoId: string) => FleetAdminApi;
}
