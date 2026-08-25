import type { ActionCoordinationFacet, DomainStatus } from "../../kernel/src/index.ts";

export interface ActionCoordinationRuntimeInput {
  readonly dryRunRequested: boolean;
}

export interface ActionCoordinationPlan {
  readonly execution: "preview" | "execute";
  readonly wipAdmission: ActionCoordinationFacet["wipAdmission"];
  readonly fleetProvisionalReservation: "reserve" | "skip";
  readonly fifo: "enqueue" | "bypass";
}

export interface ActionCoordinationHandlers<Result> {
  readonly admitWip: (nextStatus: DomainStatus) => void;
  readonly preview: () => Result | Promise<Result>;
  readonly execute: () => Result | Promise<Result>;
}

export function coordinateAction(
  facet: ActionCoordinationFacet,
  runtime: ActionCoordinationRuntimeInput,
): ActionCoordinationPlan {
  const execution = facet.dryRun === "supported" && runtime.dryRunRequested ? "preview" : "execute";
  return Object.freeze({
    execution,
    wipAdmission: facet.wipAdmission,
    fleetProvisionalReservation:
      facet.fleetProvisionalReservation === "required" && execution === "execute" ? "reserve" : "skip",
    fifo: facet.fifo === "required" ? "enqueue" : "bypass",
  });
}

export async function executeActionCoordination<Result>(
  plan: ActionCoordinationPlan,
  handlers: ActionCoordinationHandlers<Result>,
): Promise<Result> {
  if (plan.wipAdmission !== null) handlers.admitWip(plan.wipAdmission.nextStatus);
  return plan.execution === "preview" ? handlers.preview() : handlers.execute();
}
