// @slice-activation TW-01 authority application contract consumed by forced-command transport and TW-02/TW-03.
export { createInMemoryAuthorityOperationRegistry, createInMemoryReplicaChangeLog } from "./memory-stores.ts";
export { canonicalAuthorityRequestDigest, createAuthoritySubmissionService } from "./service.ts";
export {
  createInMemoryShadowPublicationLog,
  reconcileShadowPublications,
  shadowPublicationSchema,
  shadowReconciliationSchema
} from "./shadow.ts";
export type { AuthoritySubmissionServiceOptions } from "./service.ts";
export { authorityProtocolTuple } from "./types.ts";
export type {
  AttributedCoordinatorFactory,
  AuthorityCommittedReceipt,
  AuthorityFenceWitness,
  AuthorityIndeterminateReceipt,
  AuthorityOperationEnvelope,
  AuthorityOperationReceipt,
  AuthorityOperationRecord,
  AuthorityOperationRegistry,
  AuthorityOperationState,
  AuthorityProtocolTuple,
  AuthorityRejectedReceipt,
  AuthorityRetryableReceipt,
  AuthoritySubmissionService,
  CanonicalPublication,
  CanonicalPublicationInspector,
  DelegationTokenClaims,
  DelegationTokenVerification,
  DelegationTokenVerifier,
  ReplicaChangeLog,
  ReplicaChangeRecord
} from "./types.ts";
export type {
  CanonicalPublicationObservation,
  ShadowDifference,
  ShadowDifferenceCode,
  ShadowPublicationLog,
  ShadowPublicationRecord,
  ShadowReconciliationReport
} from "./shadow.ts";
