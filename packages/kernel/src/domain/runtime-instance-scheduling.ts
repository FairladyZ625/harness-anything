/** Browser-safe scheduling vocabulary and the node-local transient runtime port. */
export const runtimeSelectionStrategies = ["sticky", "lru"] as const;
export type RuntimeSelectionStrategy = (typeof runtimeSelectionStrategies)[number];

export interface RuntimeInstanceDispatchState {
  readonly lastDispatchedAt: ReadonlyMap<string, number>;
  readonly recordDispatch: (instanceId: string) => void;
  readonly activate: (runtimeSessionId: string, instanceId: string) => void;
  readonly deactivate: (runtimeSessionId: string) => void;
  readonly readActiveLoads: () => ReadonlyMap<string, number>;
}

export function validRuntimeInstanceTier(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 9;
}
