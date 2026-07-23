import type {
  AuthorityOperationRecord,
  AuthorityStoredOperationRecord
} from "./types.ts";

export function authorityOperationPublicView(
  stored: AuthorityStoredOperationRecord
): AuthorityOperationRecord {
  const {
    canonicalRequestEnvelope: _canonicalRequestEnvelope,
    canonicalOperation: _canonicalOperation,
    fixedOperationBinding: _fixedOperationBinding,
    recoveryPublicationPolicy: _recoveryPublicationPolicy,
    ...publicRecord
  } = stored;
  return publicRecord;
}
