import {
  canonicalizeWriteValue,
  hasOnlyFields,
  isRecord,
  serializeEventEnvelope,
  serializeEventHead,
  WriteChainContractError,
  type ActorIdentity,
  type EventEnvelope,
  type EventHead
} from "./write-chain.contract.ts";

export interface PendingPublication<E extends EventEnvelope<string, string, ActorIdentity, unknown> = EventEnvelope<string, string, ActorIdentity, unknown>> {
  readonly schema: "event-publication-pending/v1";
  readonly event: E;
  readonly head: EventHead;
  readonly previousHead: EventHead | null;
  readonly previousCommitSha: string;
}

export const EVENT_PUBLICATION_PENDING_SCHEMA = Object.freeze({
  id: "event-publication-pending/v1",
  required: Object.freeze(["schema", "event", "head", "previousHead", "previousCommitSha"])
});

export function validatePendingPublication(value: unknown): readonly string[] {
  if (!isRecord(value) || !hasOnlyFields(value, EVENT_PUBLICATION_PENDING_SCHEMA.required)) return ["pending publication fields are invalid"];
  const errors: string[] = [];
  if (value.schema !== EVENT_PUBLICATION_PENDING_SCHEMA.id || !/^[0-9a-f]{40}$/u.test(String(value.previousCommitSha))) errors.push("pending publication schema or commit is invalid");
  try { serializeEventEnvelope(value.event as EventEnvelope<string, string, ActorIdentity, unknown>); } catch (error) { consumeKnownError(error); errors.push("pending event is invalid"); }
  try { serializeEventHead(value.head as EventHead); } catch (error) { consumeKnownError(error); errors.push("pending head is invalid"); }
  if (value.previousHead !== null) try { serializeEventHead(value.previousHead as EventHead); } catch (error) { consumeKnownError(error); errors.push("previous head is invalid"); }
  if (isRecord(value.event) && isRecord(value.head) && (value.event.opId !== value.head.opId || value.event.workspaceRevision !== value.head.revision)) errors.push("pending event and head binding is invalid");
  return errors;
}

export function serializePendingPublication<E extends EventEnvelope<string, string, ActorIdentity, unknown>>(value: PendingPublication<E>): string {
  const errors = validatePendingPublication(value);
  if (errors.length > 0) throw new WriteChainContractError("invalid_contract", errors.join("; "));
  return `${JSON.stringify(canonicalizeWriteValue(value))}\n`;
}

export default Object.freeze({
  id: "event-publication",
  phases: Object.freeze(["P4"]),
  commands: Object.freeze([]),
  gates: Object.freeze([]),
  guards: Object.freeze([]),
  schemas: Object.freeze([Object.freeze({
    id: EVENT_PUBLICATION_PENDING_SCHEMA.id,
    schema: "packages/kernel/src/domain/event-publication.contract.ts#EVENT_PUBLICATION_PENDING_SCHEMA",
    parser: "packages/kernel/src/domain/event-publication.contract.ts#validatePendingPublication",
    writer: "packages/kernel/src/domain/event-publication.contract.ts#serializePendingPublication",
    error: "packages/kernel/src/domain/write-chain.contract.ts#WriteChainContractError",
    negativeFixtures: Object.freeze(["packages/kernel/fixtures/contracts/event-publication-pending-invalid.json"])
  })])
});
function consumeKnownError(error: unknown): void { void error; }
