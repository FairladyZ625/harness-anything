import {
  hasContractFields,
  isRecord,
  validateEventEnvelopeIdentity,
  type ActorIdentity,
  type EventEnvelope,
} from "./write-chain.contract.ts";

/** Audit only: capabilities are read exclusively from the center repository's private records. */
export type ExecutionDelegationEventV1 = EventEnvelope<
  "execution-delegation-event/v1",
  "execution_delegation_changed",
  ActorIdentity,
  { readonly tokenId: string; readonly operation: "issue" | "revoke" }
>;

export function validateExecutionDelegationEvent(value: unknown): readonly string[] {
  return validateFields(value, true);
}

export function validateCurrentExecutionDelegationEvent(value: unknown): readonly string[] {
  return validateFields(value, false);
}

function validateFields(value: unknown, allowUnknownFields: boolean): readonly string[] {
  if (
    !isRecord(value) ||
    !hasContractFields(
      value,
      ["schema", "type", "eventId", "opId", "workspaceRevision", "actor", "source", "occurredAt", "payload"],
      allowUnknownFields,
    ) ||
    value.schema !== "execution-delegation-event/v1" ||
    value.type !== "execution_delegation_changed" ||
    !isRecord(value.payload) ||
    !hasContractFields(value.payload, ["tokenId", "operation"], allowUnknownFields) ||
    typeof value.payload.tokenId !== "string" ||
    !/^det_[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(value.payload.tokenId) ||
    (value.payload.operation !== "issue" && value.payload.operation !== "revoke")
  )
    return ["Invalid execution delegation audit event"];
  return validateEventEnvelopeIdentity(value, allowUnknownFields);
}
