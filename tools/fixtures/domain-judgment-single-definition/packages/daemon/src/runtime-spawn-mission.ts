// Positive control: provider-instance load counted from session liveness instead of lifecycle reservations.
export function liveLoad(sessions: readonly { readonly instanceId: string; readonly liveness: string }[]) {
  const load = new Map<string, number>();
  for (const session of sessions)
    if (session.liveness === "live") load.set(session.instanceId, (load.get(session.instanceId) ?? 0) + 1);
  return load;
}
