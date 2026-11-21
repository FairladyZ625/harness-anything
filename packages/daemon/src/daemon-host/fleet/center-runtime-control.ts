import type { JsonObject } from "../protocol/json-rpc-types.ts";
import { randomUUID } from "node:crypto";
import type { SquadRunObservation } from "@harness-anything/kernel";
import { steerReceiptOpId } from "../dispatch-steer-state.ts";
import { runtimeErrorCode, runtimeErrorMessage } from "../../runtime-engine/runtime-spawn-errors.ts";
import type { DaemonAuthenticationContext } from "../transport/auth-context.ts";
import { squadObservationEventOpId } from "../squad-observation.ts";
import { FleetFault, type FleetCenterOptions } from "./center-types.ts";

export async function dispatchCenterRuntimeControl(
  options: FleetCenterOptions,
  repoId: string,
  kind: "runtime-cancel" | "runtime-steer",
  payload: object,
  requestId: string,
  auth: DaemonAuthenticationContext,
): Promise<JsonObject> {
  const controlPayload = payload as Record<string, unknown>;
  const controlInput = {
    ...controlPayload,
    ...(controlPayload.idempotencyKey === undefined ? { idempotencyKey: requestId } : {}),
  } as JsonObject;
  const handler = kind === "runtime-cancel" ? options.host.cancelRuntime : options.host.steerRuntime;
  if (!handler) throw new FleetFault("unsupported_command", `Center host does not expose ${kind}.`);
  try {
    return await handler(repoId, controlInput, auth);
  } catch (error) {
    const code = runtimeErrorCode(error);
    if (code) throw new FleetFault(code, runtimeErrorMessage(error));
    throw error;
  }
}

export function runtimeControlReceiptOpId(
  repoId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  if (
    (eventType !== "runtime_session_liveness_changed" && eventType !== "runtime_session_provider_bound") ||
    typeof payload.runtimeSessionId !== "string" ||
    typeof payload.controlReceipt !== "object" ||
    payload.controlReceipt === null ||
    Array.isArray(payload.controlReceipt)
  )
    return null;
  const requestOpId = (payload.controlReceipt as { readonly requestOpId?: unknown }).requestOpId;
  return typeof requestOpId === "string" ? steerReceiptOpId(repoId, payload.runtimeSessionId, requestOpId) : null;
}

export function runtimeEventStorageOpId(
  repoId: string,
  eventType: string,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (eventType === "runtime_squad_run_observed")
    return squadObservationEventOpId(payload as unknown as Pick<SquadRunObservation, "squadRunId" | "runRevision">);
  return runtimeControlReceiptOpId(repoId, eventType, payload) ?? randomUUID();
}
