export function edgeJoinOrigins(values: readonly string[] | undefined): Record<string, string> | undefined {
  if (!values) return undefined;
  const origins: Record<string, string> = {};
  for (const value of values) {
    const qualified = /^([a-z][a-z0-9-]{0,62})=(.*)$/su.exec(value),
      repoId = qualified?.[1] ?? "*",
      url = (qualified?.[2] ?? value).trim();
    if (!url || Object.hasOwn(origins, repoId)) return undefined;
    origins[repoId] = url;
  }
  return origins;
}

export function edgeJoinFields(flags: {
  readonly one: ReadonlyMap<string, string>;
  readonly many: ReadonlyMap<string, string[]>;
}): Record<string, unknown> {
  return {
    ...(flags.one.get("--join-mode") ? { joinMode: flags.one.get("--join-mode") } : {}),
    ...(flags.one.get("--join-id") ? { joinId: flags.one.get("--join-id") } : {}),
    ...(flags.many.get("--join-repo") ? { repoIds: flags.many.get("--join-repo") } : {}),
    ...(flags.many.get("--join-group") ? { groupIds: flags.many.get("--join-group") } : {}),
    ...(flags.one.get("--node-label") ? { nodeLabel: flags.one.get("--node-label") } : {}),
    ...(flags.one.get("--transport") ? { transport: flags.one.get("--transport") } : {}),
    ...(flags.one.get("--ssh-target") ? { sshTarget: flags.one.get("--ssh-target") } : {}),
  };
}
