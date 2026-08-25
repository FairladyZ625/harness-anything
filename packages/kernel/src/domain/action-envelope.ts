import { stablePayloadHash } from "../integrity/stable-hash.ts";
import type { ActorIdentity } from "./actor-identity.ts";
import { validateActorIdentity } from "./actor-identity.ts";
import { isNonEmptyString } from "./contract-validation.ts";
import { parseEntityRef, type EntityRef } from "./entity-ref.ts";
import { CONTRACT_VERSION_1_0, isContractVersionCompatible, type ContractVersion } from "./contract-version.ts";
import type { DomainStatus } from "./lifecycle-status.ts";

export const currentActionEnvelopeVersion = CONTRACT_VERSION_1_0;

export interface ActionCoordinationFacet {
  readonly dryRun: "supported" | "disabled";
  readonly wipAdmission: { readonly nextStatus: DomainStatus } | null;
  readonly fleetProvisionalReservation: "required" | "disabled";
  readonly fifo: "required" | "disabled";
}

export const ACTION_COORDINATION_DISABLED: ActionCoordinationFacet = Object.freeze({
  dryRun: "disabled",
  wipAdmission: null,
  fleetProvisionalReservation: "disabled",
  fifo: "disabled",
});

export interface ActionEnvelope<Kind extends string = string> {
  readonly version: ContractVersion;
  readonly actionId: string;
  readonly kind: Kind;
  readonly target: EntityRef;
  readonly actor: ActorIdentity;
  readonly authorizationRef: string;
  readonly idempotencyKey: string;
}

const actionEnvelopeFields = [
  "version",
  "actionId",
  "kind",
  "target",
  "actor",
  "authorizationRef",
  "idempotencyKey",
] as const;

export function validateActionEnvelope(value: unknown): readonly string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["Action envelope must be an object"];
  const action = value as Readonly<Record<string, unknown>>,
    errors = Object.keys(action)
      .filter((field) => !actionEnvelopeFields.includes(field as (typeof actionEnvelopeFields)[number]))
      .map((field) => `unexpected Action envelope field: ${field}`);
  if (!isContractVersionCompatible(action.version, currentActionEnvelopeVersion))
    errors.push("version is not compatible with this Action envelope");
  for (const field of ["actionId", "kind", "authorizationRef", "idempotencyKey"] as const)
    if (!isNonEmptyString(action[field])) errors.push(`${field} is required`);
  if (!isNonEmptyString(action.target) || parseEntityRef(action.target) === null)
    errors.push("target must be an EntityRef");
  errors.push(...validateActorIdentity(action.actor));
  return errors;
}

/** Stable deduplication identity for retries; actionId identifies an attempt and is deliberately excluded. */
export function actionReplayKey(action: ActionEnvelope): `sha256:${string}` {
  const errors = validateActionEnvelope(action);
  if (errors.length) throw new Error(`invalid Action envelope: ${errors.join("; ")}`);
  return `sha256:${stablePayloadHash({
    version: action.version,
    kind: action.kind,
    target: action.target,
    actor: action.actor,
    authorizationRef: action.authorizationRef,
    idempotencyKey: action.idempotencyKey,
  })}`;
}
