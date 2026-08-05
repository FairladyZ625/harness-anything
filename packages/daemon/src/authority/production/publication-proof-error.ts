export const authorityImmutablePublicationProofErrorCodes = [
  "AUTHORITY_CANONICAL_PUBLICATION_PIPELINE_EVIDENCE_MISMATCH",
  "AUTHORITY_CANONICAL_PUBLICATION_CONTENT_ADDRESS_MISMATCH",
  "AUTHORITY_PUBLICATION_TREE_EMPTY",
  "AUTHORITY_PUBLICATION_TREE_MISMATCH",
  "AUTHORITY_PUBLICATION_DECLARED_PATH_MISSING"
] as const;

export type AuthorityImmutablePublicationProofErrorCode =
  typeof authorityImmutablePublicationProofErrorCodes[number];

const immutableProofCodes = new Set<string>(authorityImmutablePublicationProofErrorCodes);

/** A canonical publication was found, but its immutable Git evidence cannot prove the declared mutation. */
export class AuthorityImmutablePublicationProofError extends Error {
  readonly code: AuthorityImmutablePublicationProofErrorCode;

  constructor(code: AuthorityImmutablePublicationProofErrorCode, details?: string) {
    super(details ? `${code}:${details}` : code);
    this.name = "AuthorityImmutablePublicationProofError";
    this.code = code;
  }
}

export function authorityImmutablePublicationProofErrorCode(
  error: unknown
): AuthorityImmutablePublicationProofErrorCode | undefined {
  if (error instanceof AuthorityImmutablePublicationProofError) return error.code;
  if (!(error instanceof Error)) return undefined;
  const code = /^([A-Z][A-Z0-9_]*)(?=[:;]|$)/u.exec(error.message)?.[1];
  return code && immutableProofCodes.has(code)
    ? code as AuthorityImmutablePublicationProofErrorCode
    : undefined;
}
