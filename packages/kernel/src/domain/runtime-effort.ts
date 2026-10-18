export const runtimeEffortValues = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"] as const);
export type RuntimeEffort = (typeof runtimeEffortValues)[number];
