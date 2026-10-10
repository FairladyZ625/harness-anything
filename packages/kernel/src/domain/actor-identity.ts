import { isNonEmptyString } from "./contract-validation.ts";

export type ActorPrincipal =
  | { readonly personId: string; readonly kind?: never }
  | { readonly kind: "machine"; readonly subject: string; readonly nodeId: string; readonly personId?: never };

export interface ActorIdentity {
  readonly principal: ActorPrincipal;
  readonly executor: { readonly kind: "agent"; readonly id: string } | null;
}

export function validateActorIdentity(value: unknown, allowUnknownFields = false): readonly string[] {
  if (
    !record(value) ||
    !fields(value, ["principal", "executor"], allowUnknownFields) ||
    !validActorPrincipal(value.principal, allowUnknownFields)
  )
    return ["principal must be a person or machine identity"];
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
export function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validActorPrincipal(value: unknown, allowUnknownFields = false): value is ActorPrincipal {
  if (!record(value)) return false;
  return value.kind === "machine"
    ? fields(value, ["kind", "subject", "nodeId"], allowUnknownFields) &&
        !Object.hasOwn(value, "personId") &&
        isNonEmptyString(value.subject) &&
        isNonEmptyString(value.nodeId)
    : !Object.hasOwn(value, "kind") &&
        fields(value, ["personId"], allowUnknownFields) &&
        isNonEmptyString(value.personId);
}

/** A display / lookup key; authorization always carries the typed principal. */
export function principalId(principal: ActorPrincipal): string {
  return principal.kind === "machine" ? `machine:${principal.nodeId}:${principal.subject}` : principal.personId;
}

export function samePrincipal(left: ActorPrincipal, right: ActorPrincipal): boolean {
  return left.kind === "machine"
    ? right.kind === "machine" && left.subject === right.subject && left.nodeId === right.nodeId
    : right.kind !== "machine" && left.personId === right.personId;
}
