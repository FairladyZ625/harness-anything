// Git-style short-id resolution for read faces: an exact id always wins; otherwise a prefix
// must match exactly one candidate. Ambiguity lists a bounded candidate sample instead of
// guessing, so a one-character prefix can never become a new full-history dump.
export type UniquePrefixResolution =
  | { readonly matched: true; readonly id: string }
  | { readonly matched: false; readonly candidates: readonly string[] };

export function resolveUniquePrefix(requested: string, ids: readonly string[]): UniquePrefixResolution {
  if (ids.includes(requested)) return { matched: true, id: requested };
  const candidates = ids.filter((id) => id.startsWith(requested));
  return candidates.length === 1 ? { matched: true, id: candidates[0]! } : { matched: false, candidates };
}

const listedCandidateLimit = 8;

export function candidateSample(candidates: readonly string[]): string {
  const listed = candidates.slice(0, listedCandidateLimit).join(", ");
  return candidates.length > listedCandidateLimit
    ? `${listed}, … and ${String(candidates.length - listedCandidateLimit)} more`
    : listed;
}
