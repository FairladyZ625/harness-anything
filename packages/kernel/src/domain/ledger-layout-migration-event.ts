import { stableStringify } from "../integrity/stable-hash.ts";
import { eventObjectTarget } from "../layout/ledger-object-layout.ts";
import {
  freezeDeclaredWritePlan,
  hasOnlyFields,
  isFrozenWritePlan,
  isRecord,
  serializeEventEnvelope,
  type ActorIdentity,
  type EventEnvelope,
  type FrozenWritePlan,
  type WriteTarget,
} from "./write-chain.contract.ts";

export type LedgerLayoutMigrationEventV1 = EventEnvelope<
  "ledger-layout-event/v1",
  "ledger_layout_migrated",
  ActorIdentity,
  {
    readonly from: "flat/v1";
    readonly to: "sharded-sha256-2/v1";
    readonly eventCount: number;
    readonly blobCount: number;
    readonly preEventsTreeSha: string;
  }
>;

export function isLedgerLayoutMigrationEvent(event: {
  readonly schema: string;
}): event is LedgerLayoutMigrationEventV1 {
  return event.schema === "ledger-layout-event/v1";
}
export function validateLedgerLayoutMigrationEvent(
  value: unknown,
): readonly string[] {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, [
      "schema",
      "eventId",
      "workspaceRevision",
      "opId",
      "type",
      "actor",
      "source",
      "occurredAt",
      "payload",
    ]) ||
    value.schema !== "ledger-layout-event/v1" ||
    value.type !== "ledger_layout_migrated" ||
    !isRecord(value.payload) ||
    !hasOnlyFields(value.payload, [
      "from",
      "to",
      "eventCount",
      "blobCount",
      "preEventsTreeSha",
    ]) ||
    value.payload.from !== "flat/v1" ||
    value.payload.to !== "sharded-sha256-2/v1" ||
    ![value.payload.eventCount, value.payload.blobCount].every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    ) ||
    !/^[0-9a-f]{40}$/u.test(String(value.payload.preEventsTreeSha))
  )
    return ["ledger layout migration event is invalid"];
  try {
    serializeEventEnvelope(value as unknown as LedgerLayoutMigrationEventV1);
  } catch {
    return ["ledger layout migration event identity is invalid"];
  }
  return [];
}
export function ledgerLayoutMigrationWritePlan(
  event: LedgerLayoutMigrationEventV1,
): FrozenWritePlan<"LedgerLayoutMigrate"> {
  const targets: WriteTarget[] = [
    {
      kind: "event_file",
      path: eventObjectTarget(event.opId),
      operation: "create",
    },
    {
      kind: "event_head",
      path: "harness/events/head.json",
      operation: "replace",
    },
    {
      kind: "projection_invalidation",
      projection: "ledger-layout/v1",
      key: event.payload.to,
    },
  ];
  return freezeDeclaredWritePlan(
    { commandType: "LedgerLayoutMigrate", targets },
    ["LedgerLayoutMigrate"],
  );
}
export function assertLedgerLayoutMigrationWritePlan(
  event: LedgerLayoutMigrationEventV1,
  plan: FrozenWritePlan | undefined,
): void {
  const shape = (value: FrozenWritePlan) =>
    stableStringify({
      commandType: value.commandType,
      targets: value.targets.map(stableStringify).sort(),
    });
  if (
    !plan ||
    !isFrozenWritePlan(plan) ||
    shape(plan) !== shape(ledgerLayoutMigrationWritePlan(event))
  )
    throw new Error(
      "ledger layout migration plan must exactly declare event, head, and layout projection targets",
    );
}
