/** Renderer multi-repo routing: optional repoId attached to bridge payloads. */
export interface RepoScopedPayload {
  readonly repoId?: string;
}

export function withRepoId<T extends object>(
  payload: T | null | undefined,
  repoId: string | undefined
): (T & RepoScopedPayload) | RepoScopedPayload | null {
  if (!repoId) return payload ?? null;
  return payload ? { ...payload, repoId } : { repoId };
}
