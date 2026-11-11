/** Receipt outcome vocabulary shared by writer contracts and browser consumers. */
export const writeReceiptOutcomes = Object.freeze([
  "applied",
  "pending",
  "no_changes",
  "indeterminate",
  "op_rejected",
] as const);
export type WriteReceiptOutcome = (typeof writeReceiptOutcomes)[number];
