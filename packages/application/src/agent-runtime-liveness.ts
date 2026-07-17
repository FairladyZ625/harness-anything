export type RuntimeLeaseState = "active" | "orphan";
export type RuntimeProcessState = "alive" | "exited";

export interface RuntimeLeaseObservation {
  readonly lease: RuntimeLeaseState;
  readonly process: RuntimeProcessState;
}

export function combineRuntimeLeaseObservation(
  lease: RuntimeLeaseState,
  process: RuntimeProcessState
): RuntimeLeaseObservation {
  return { lease, process };
}

export function runtimeLeaseObservationMatrix(): ReadonlyArray<RuntimeLeaseObservation> {
  return (["active", "orphan"] as const).flatMap((lease) =>
    (["alive", "exited"] as const).map((process) => combineRuntimeLeaseObservation(lease, process))
  );
}
