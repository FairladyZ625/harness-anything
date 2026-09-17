/** Browser-safe public contracts. Runtime, persistence and hashing stay behind index.ts. */
export { mappedWitnessAdapterIds, validateFrozenCompletionContract } from "./domain/completion-contract.ts";
export { validCompletionEvidenceOverride } from "./domain/completion-evidence-override.ts";
export { closeoutOverrideKeys, isValidCloseoutOverrides } from "./domain/settings-closeout.ts";
export type { CloseoutOverridesV1 } from "./domain/settings-closeout.ts";
