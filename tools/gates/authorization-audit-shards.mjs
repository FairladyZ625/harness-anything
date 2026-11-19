// Source rows that consume a server proof follow that descriptor's shard. Native
// sources follow their entry route even when different actions share the entry.
export function authorizationShardBuckets(actions, durable) {
  const buckets = new Map(durable.map((descriptor, ordinal) => [descriptor.id, ordinal]));
  let nextBucket = durable.length;
  for (const action of actions)
    for (const { route } of action.ontology.sources) if (!buckets.has(route)) buckets.set(route, nextBucket++);

  // The script manifest is proved under the first passing descriptor of its
  // action kind. Keep those descriptors and script targets together.
  for (const action of actions) {
    if (!action.ontology.scriptManifest || action.catalogId !== "script-execution/run") continue;
    const parents = durable.filter(
      (row) => (row.kindRewrite?.authorizedKind ?? row.actionKind ?? row.id) === action.kind,
    );
    if (parents.length === 0) continue;
    const bucket = buckets.get(parents[0].id);
    for (const parent of parents) buckets.set(parent.id, bucket);
    for (const source of action.ontology.sources) if (source.role === "script") buckets.set(source.route, bucket);
  }
  return buckets;
}

export function partitionAuthorizationSources(actions, buckets, { index, count }) {
  return actions.flatMap((action) => {
    const sources = action.ontology.sources.filter((source) => buckets.get(source.route) % count === index);
    return sources.length > 0 ? [{ ...action, ontology: { ...action.ontology, sources } }] : [];
  });
}

export function findingsFor(rows, receipt, sourceRows) {
  return [
    ...rows
      .filter((row) => !row.ok)
      .map((row) =>
        row.violations.length > 0
          ? `${row.id} (${row.kind}): ${row.violations.join("; ")}`
          : `${row.id} (${row.kind}): no ${row.authority} authority dominates the effect of ${row.method}`,
      ),
    ...(receipt.nonNullable
      ? []
      : [`${receipt.file}:${receipt.line} receipt.authorizationDecision is optional or nullable`]),
    ...sourceRows.filter((source) => !source.ok).map((source) => `${source.id}: ${source.violations.join("; ")}`),
  ];
}

// A multiplexed client can depend on descriptors in several shards. Resolve
// its evidence against the same complete row set on the serial and parallel paths.
export function finishSourceRows(sourceProofs, rows, descriptorBindings) {
  const descriptorKinds = new Map(descriptorBindings);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  return sourceProofs.map((source) => {
    const { row, rawClient, port, proof, output, repoRead, delegated, hostEntry, hostRequired, trace, traceProof } =
      source;
    const badRoute = row.clientRoutes.find((route) => {
      if (!descriptorKinds.has(route) || (route === row.route && descriptorKinds.get(route) !== row.kind)) return true;
      const routeRow = rowsById.get(route);
      if (routeRow) return !routeRow.ok;
      // A scoped audit may intentionally omit an unmodified route. For the
      // declared route, any evaluated owner of the kind must still pass.
      return route === row.route && rows.some((owner) => owner.kind === row.kind && !owner.ok);
    });
    const client = badRoute === undefined ? rawClient : null;
    const authorityProof = hostRequired
      ? hostEntry
      : proof || port || client || output || repoRead || delegated || traceProof;
    const ok = Boolean(source.witnessed && source.within && authorityProof);
    return {
      ...row,
      authority: hostRequired
        ? "host-service-entry"
        : port
          ? "technical-port"
          : client
            ? "client-entry"
            : source.support
              ? "intrinsic-support"
              : output
                ? "process-stdio"
                : repoRead
                  ? "repo-read-service"
                  : hostEntry
                    ? "host-service-entry"
                    : delegated
                      ? "delegated-service-entry"
                      : source.authority,
      ok,
      evidence:
        port ??
        client ??
        (proof
          ? ["typed process-local intrinsic; no external effect"]
          : output
            ? ["Node process-owned stdout/stderr; caller-process residency"]
            : (repoRead ?? hostEntry ?? delegated ?? trace?.evidence ?? [])),
      violations: ok
        ? []
        : [
            source.within && badRoute !== undefined
              ? `client source route ${badRoute} targets an unverified server authorization descriptor`
              : source.missing,
          ],
    };
  });
}
