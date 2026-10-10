/** Browser-safe relation state vocabulary shared by domain validation and GUI contracts. */
export const relationStates = ["active", "retired"] as const;
export type RelationState = (typeof relationStates)[number];
