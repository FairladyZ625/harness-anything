// @slice-activation TW-02 compound receipt contract consumed by transparent-workspace broker and CLI exits.
export { classifyCompoundExit, compoundExitCodes, compoundExitDefinitions } from "./exit-contract.ts";
export type {
  CompoundExitCode,
  CompoundExitDefinition,
  CompoundExitInput,
  CompoundExitSymbol
} from "./exit-contract.ts";
export { createCompoundReceiptService } from "./service.ts";
export type { CompoundReceiptServiceOptions } from "./service.ts";
export { isCompoundOperationReceipt } from "./validation.ts";
export { CompoundReceiptTransitionError, compoundReceiptPhases, compoundReceiptSchema } from "./types.ts";
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
