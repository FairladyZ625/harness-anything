import { isNonEmptyString } from "./contract-validation.ts";

export interface ActorIdentity {
  readonly principal: { readonly personId: string };
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
}

export function validateActorIdentity(value: unknown, allowUnknownFields = false): readonly string[] {
  if (
    !record(value) ||
    !fields(value, ["principal", "executor"], allowUnknownFields) ||
    !record(value.principal) ||
    !fields(value.principal, ["personId"], allowUnknownFields) ||
    !isNonEmptyString(value.principal.personId)
  )
    return ["principal must be a person identity"];
  if (
    value.executor !== null &&
    (!record(value.executor) ||
      !fields(value.executor, ["kind", "id"], allowUnknownFields) ||
      value.executor.kind !== "agent" ||
      !isNonEmptyString(value.executor.id))
  )
    return ["executor must be an agent identity or null"];
  return [];
}

function fields(value: Readonly<Record<string, unknown>>, required: readonly string[], allowUnknown: boolean): boolean {
  return (
    required.every((field) => Object.hasOwn(value, field)) &&
    (allowUnknown || Object.keys(value).every((field) => required.includes(field)))
  );
}
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
