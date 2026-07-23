// @slice-activation TW-02 compound receipt contract consumed by transparent-workspace broker and CLI exits.
export { classifyCompoundExit, compoundExitCodes, compoundExitDefinitions } from "./exit-contract.ts";
export {
  projectCompoundReceiptEnvelope,
  projectCompoundReceiptHonestOutcome,
  projectCompoundWireFrameHonestOutcome
} from "./honest-outcome-projection.ts";
export type {
  CompoundHonestOutcomeFailureRegistry,
  CompoundHonestOutcomeProjectionOptions,
  ProjectedHonestReceiptOutcome
} from "./honest-outcome-projection.ts";
export type {
  CompoundExitCode,
  CompoundExitDefinition,
  CompoundExitInput,
  CompoundExitSymbol
} from "./exit-contract.ts";
export { createCompoundReceiptService } from "./service.ts";
export type { CompoundReceiptServiceOptions } from "./service.ts";
export { isCompoundOperationReceipt } from "./validation.ts";
export { isCompoundOperationReceiptV2 } from "./validation-v2.ts";
export { CompoundReceiptTransitionError, compoundReceiptPhases, compoundReceiptSchema } from "./types.ts";
export {
  assertHistoricalExcludedSetWitnessV1,
  createHistoricalExcludedSetWitnessV1,
  historicalAffectedSetDigestDomain,
  historicalExcludedSetWitnessDigestDomain,
  historicalExcludedSetWitnessKind,
  historicalWatcherFenceDigestDomain
} from "./witness-v1.ts";
export type {
  HistoricalExcludedSetWitnessInputV1,
  HistoricalExcludedSetWitnessV1,
  HistoricalWatcherFenceEntryV1,
  HistoricalWitnessFingerprintV1
} from "./witness-v1.ts";
export {
  compoundPreparedReceiptDigestDomain,
  compoundResultTokenDigestDomain,
  preparedReceiptDigestV2,
  resultTokenDigestV2,
  resultTokenMatchesV2
} from "./v2-integrity.ts";
export { createCompoundReceiptServiceV2 } from "./v2-service.ts";
export type { CompoundReceiptServiceV2Options } from "./v2-service.ts";
export {
  CompoundReceiptProtocolError,
  compoundReceiptV2Schema,
  compoundTerminalJournalSchema
} from "./v2-types.ts";
export type {
  AppliedExactAtCutV2,
  CompoundOperationReceiptV2,
  CompoundReceiptServiceV2,
  CompoundReceiptStoreV2,
  CompoundTerminalJournalDraft,
  CompoundTerminalJournalEntry,
  DeliveryAcknowledgementInputV2,
  ImmutableReceiptAcknowledgementV2,
  OpenedCompoundWaiterV2,
  OriginPinV2,
  OriginResolutionV2,
  ReceiptCapabilityV2,
  ReceiptIdentityV2,
  WaiterScope
} from "./v2-types.ts";
export {
  compoundReceiptWireTypeV1,
  createCompoundReceiptWireBrokerV1,
  decodeCompoundReceiptWireFrameV1,
  encodeCompoundReceiptWireFrameV1,
  receiptIdentityFromWireV1
} from "./wire-v1.ts";
export type {
  AckCommittedFrameV1,
  CompoundReceiptWireBrokerV1,
  CompoundReceiptWireFrameV1,
  DeliveryAckFrameV1,
  GetWaiterFrameV1,
  OpenWaiterFrameV1,
  ResultPreparedFrameV1,
  WaiterOpenedFrameV1,
  WaiterStateFrameV1
} from "./wire-v1.ts";
export type {
  AppliedExactAtCut,
  ApplyBlockedOrigin,
  CompoundOperationReceipt,
  CompoundReceiptPhase,
  CompoundReceiptService,
  CompoundReceiptStore,
  CurrentLeaseState,
  ImmutableReceiptAcknowledgement,
  LocalConflictOrigin,
  NonquiescentOrigin,
  OriginResolution,
  ReceiptDeliveryState,
  ReceiptIdentity,
  SupersededOrigin,
  ViewUnavailableOrigin
} from "./types.ts";
