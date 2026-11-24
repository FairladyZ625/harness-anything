import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import type {
  EntityKindContract,
  EntityStoreKindContract,
} from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import {
  deriveEntityProjection,
  interpretEntityValue,
  interpretEntityProjection,
  type InterpretedEntityValue,
  type InterpretedEntityProjection,
} from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import {
  dropRetiredSettingsWalFlush,
  normalizeHistoricalSettingsRoles,
} from "@harness-anything/kernel/internal/domain/settings-history.ts";
import { projectScheduleHistory } from "@harness-anything/kernel/internal/domain/schedule.ts";
import { EntitySchemaContractError } from "@harness-anything/kernel/internal/domain/entity-json-schema.ts";

export interface InterpretedReplayDeclaration {
  readonly contract: EntityKindContract;
  readonly entity: InterpretedEntityValue;
}

export function interpretEmbeddedReplayProjections(
  contract: EntityKindContract,
  event: {
    readonly schema: string;
    readonly type: string;
    readonly opId: string;
    readonly workspaceRevision: number;
    readonly payload: unknown;
  },
  onIncompatible?: (entityId: string, value: unknown) => void,
): readonly InterpretedEntityProjection[] {
  if (contract.canonicalProjection === null) return [];
  if (!isRecord(event.payload)) throw new Error(`${event.schema}/${event.type} payload must be an object`);
  const payload = event.payload;
  if (
    contract.kind === "execution" &&
    event.schema === "task-event/v1" &&
    event.type === "task_completed" &&
    (isRecord(payload.siblingResolution) || isRecord(payload.externalResolution)) &&
    payload.execution === undefined
  )
    return [];

  return (contract.stateStores ?? []).flatMap((store) => {
    const projection = store.projection;
    if (
      store.medium.kind !== "canonical-event" ||
      store.medium.schema !== event.schema ||
      projection === undefined ||
      !projection.types.includes(event.type)
    )
      return [];
    const raw = payload[projection.payloadField],
      value =
        contract.kind === "settings"
          ? dropRetiredSettingsWalFlush(normalizeHistoricalSettingsRoles(raw))
          : contract.kind === "schedule"
            ? projectScheduleHistory(raw)
            : raw,
      identity = isRecord(value) ? value[contract.id.field] : null;
    if (typeof identity !== "string")
      return [interpretEntityProjection(contract, value, event.workspaceRevision, `event:${event.opId}`)!];
    const entity = interpretReplayDeclaration(contract, value, identity);
    if (entity === null) {
      onIncompatible?.(identity, value);
      return [];
    }
    const projectionValue = deriveEntityProjection(contract, entity, event.workspaceRevision, `event:${event.opId}`);
    return projectionValue === null ? [] : [projectionValue];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Historical schema rejection degrades one row; corrupt identity still rejects the replay. */
export function interpretReplayDeclaration(
  resolveContract: () => EntityStoreKindContract,
  value: unknown,
  expectedId: string,
): InterpretedReplayDeclaration | null;
export function interpretReplayDeclaration(
  contract: EntityKindContract,
  value: unknown,
  expectedId: string,
): InterpretedEntityValue | null;
export function interpretReplayDeclaration(
  contractOrResolver: EntityKindContract | (() => EntityStoreKindContract),
  value: unknown,
  expectedId: string,
): InterpretedEntityValue | InterpretedReplayDeclaration | null {
  if (typeof contractOrResolver === "function") {
    let contract: EntityKindContract;
    try {
      contract = contractOrResolver();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error.code !== "entity_kind_not_found" && error.code !== "entity_kind_has_dedicated_authoring")
      )
        throw error;
      consumeKnownError(error);
      return null;
    }
    const entity = interpretReplayDeclaration(contract, value, expectedId);
    return entity === null ? null : { contract, entity };
  }

  const contract = contractOrResolver;
  if (typeof value !== "object" || value === null || Reflect.get(value, contract.id.field) !== expectedId)
    throw new Error("entity declaration identity mismatch");
  let entity: InterpretedEntityValue;
  try {
    entity = interpretEntityValue(contract, value);
  } catch (error) {
    if (!(error instanceof EntitySchemaContractError)) throw error;
    consumeKnownError(error);
    return null;
  }
  const errors = contract.entityStore?.validate?.(entity.value) ?? [];
  if (errors.length) throw new Error(errors.join("; "));
  return entity;
}
