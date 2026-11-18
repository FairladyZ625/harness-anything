/** Host telemetry is an input, never a new durable source of repository membership. */
export function fleetVersionWarningMessages(input: {
  readonly warnings: readonly { readonly nodeId: string; readonly message: string }[];
  readonly sessions: readonly { readonly nodeId: string; readonly lastRepoId: string | null }[];
  readonly replicas: readonly { readonly nodeId: string; readonly repoId: string }[];
  readonly repoId?: string;
}): readonly string[] {
  const repos = new Map<string, Set<string>>();
  const associate = (nodeId: string, repoId: string) => {
    const ids = repos.get(nodeId) ?? new Set<string>();
    ids.add(repoId);
    repos.set(nodeId, ids);
  };
  for (const row of input.sessions) if (row.lastRepoId) associate(row.nodeId, row.lastRepoId);
  for (const row of input.replicas) associate(row.nodeId, row.repoId);
  return input.warnings.flatMap(({ nodeId, message }) => {
    const ids = repos.get(nodeId);
    if (input.repoId !== undefined && !ids?.has(input.repoId)) return [];
    return [`node=${nodeId} role=edge repoIds=${ids ? [...ids].sort().join(",") : "unknown"}: ${message}`];
  });
}
