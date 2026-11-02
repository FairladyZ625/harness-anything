import { consumeKnownError } from "@harness-anything/kernel";
import type { EntityKindContract } from "@harness-anything/kernel/internal/domain/entity-kind-registry.ts";
import {
  interpretEntityValue,
  type InterpretedEntityValue,
} from "@harness-anything/kernel/internal/domain/entity-kind-projection.ts";
import { EntitySchemaContractError } from "@harness-anything/kernel/internal/domain/entity-json-schema.ts";

/** Historical schema rejection degrades one row; corrupt identity still rejects the replay. */
export function interpretReplayDeclaration(
  contract: EntityKindContract,
  value: unknown,
  expectedId: string,
): InterpretedEntityValue | null {
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
