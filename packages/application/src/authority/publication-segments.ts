import type { PreparedAuthoritySubmission } from "./service-admission-types.ts";

export function authorityPublicationSegments(
  prepared: ReadonlyArray<PreparedAuthoritySubmission>
): ReadonlyArray<ReadonlyArray<PreparedAuthoritySubmission>> {
  if (prepared.length < 2 || !requiresSegmentation(prepared)) return [prepared];

  const segments: PreparedAuthoritySubmission[][] = [];
  let current: PreparedAuthoritySubmission[] = [];
  const flush = (): void => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  for (const entry of prepared) {
    if (entry.publicationRevalidation || entry.recoveryMode) {
      flush();
      segments.push([entry]);
      continue;
    }
    if (current.length > 0
      && Boolean(current[0]!.authorityIntegrity) !== Boolean(entry.authorityIntegrity)) {
      flush();
    }
    current.push(entry);
  }
  flush();
  return segments;
}

function requiresSegmentation(prepared: ReadonlyArray<PreparedAuthoritySubmission>): boolean {
  return prepared.some((entry) => entry.publicationRevalidation || entry.recoveryMode)
    || (prepared.some((entry) => entry.authorityIntegrity)
      && prepared.some((entry) => !entry.authorityIntegrity));
}
