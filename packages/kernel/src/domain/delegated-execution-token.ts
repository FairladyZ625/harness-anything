import type { ActorIdentity } from "./actor-identity.ts";
import { runtimeSessionIdFromActor } from "./task-bound-runtime-authority.ts";
import { timestamp } from "./timestamp.ts";
import { hasOnlyFields, isRecord } from "./write-chain.contract.ts";

export const DELEGATED_EXECUTION_TOKEN_SCHEMA = "delegated-execution-token/v1" as const;

export interface DelegatedExecutionToken {
  readonly schema: typeof DELEGATED_EXECUTION_TOKEN_SCHEMA;
  readonly tokenId: string;
  readonly issuer: { readonly personId: string };
  readonly delegate: { readonly runtimeSessionId: string };
  readonly allowedActions: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export type DelegatedExecutionTokenReasonCode =
  | "delegated_token_contract_invalid"
  | "delegated_token_actor_mismatch"
  | "delegated_token_action_forbidden"
  | "delegated_token_not_yet_valid"
  | "delegated_token_expired"
  | "delegated_token_revoked";

export type DelegatedExecutionTokenVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: DelegatedExecutionTokenReasonCode };

export class DelegatedExecutionTokenContractError extends Error {
  readonly code = "invalid_delegated_execution_token";

  constructor(message: string) {
    super(message);
    this.name = "DelegatedExecutionTokenContractError";
  }
}

export function parseDelegatedExecutionToken(value: unknown): DelegatedExecutionToken {
  const errors = validateDelegatedExecutionToken(value);
  if (errors.length) throw new DelegatedExecutionTokenContractError(errors.join("; "));
  const token = value as DelegatedExecutionToken;
  return {
    schema: DELEGATED_EXECUTION_TOKEN_SCHEMA,
    tokenId: token.tokenId.trim(),
    issuer: { personId: token.issuer.personId.trim() },
    delegate: { runtimeSessionId: token.delegate.runtimeSessionId.trim() },
    allowedActions: Object.freeze(token.allowedActions.map((action) => action.trim()).sort()),
    issuedAt: token.issuedAt,
    expiresAt: token.expiresAt,
    revokedAt: token.revokedAt,
  };
}

export function validateDelegatedExecutionToken(value: unknown): readonly string[] {
  if (!isRecord(value)) return ["DelegatedExecutionToken must be an object"];
  const required = ["schema", "tokenId", "issuer", "delegate", "allowedActions", "issuedAt", "expiresAt", "revokedAt"],
    errors: string[] = [],
    unsupported = Object.keys(value).filter((field) => !required.includes(field));
  if (unsupported.length) errors.push(`DelegatedExecutionToken has unsupported fields: ${unsupported.join(", ")}`);
  if (!required.every((field) => Object.hasOwn(value, field)))
    errors.push(`DelegatedExecutionToken requires ${required.join(", ")}`);
  if (value.schema !== DELEGATED_EXECUTION_TOKEN_SCHEMA)
    errors.push(`DelegatedExecutionToken schema must be ${DELEGATED_EXECUTION_TOKEN_SCHEMA}`);
  if (typeof value.tokenId !== "string" || !/^det_[A-Za-z0-9][A-Za-z0-9._:-]{0,126}$/u.test(value.tokenId))
    errors.push("DelegatedExecutionToken tokenId must start with det_ and contain only stable identifier characters");
  if (!isRecord(value.issuer) || !hasOnlyFields(value.issuer, ["personId"]) || !personId(value.issuer.personId))
    errors.push("DelegatedExecutionToken issuer must name one principal personId");
  if (
    !isRecord(value.delegate) ||
    !hasOnlyFields(value.delegate, ["runtimeSessionId"]) ||
    !identifier(value.delegate.runtimeSessionId)
  )
    errors.push("DelegatedExecutionToken delegate must name one RuntimeSession");
  if (
    !Array.isArray(value.allowedActions) ||
    value.allowedActions.length === 0 ||
    value.allowedActions.some((action) => !actionName(action))
  )
    errors.push("DelegatedExecutionToken requires at least one allowed Action");
  else if (new Set(value.allowedActions).size !== value.allowedActions.length)
    errors.push("DelegatedExecutionToken allowed Actions must be unique");
  if (!timestamp(value.issuedAt)) errors.push("DelegatedExecutionToken issuedAt must be an ISO-8601 UTC timestamp");
  if (!timestamp(value.expiresAt)) errors.push("DelegatedExecutionToken expiresAt must be an ISO-8601 UTC timestamp");
  if (
    timestamp(value.issuedAt) &&
    timestamp(value.expiresAt) &&
    Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
  )
    errors.push("DelegatedExecutionToken expiresAt must be later than issuedAt");
  if (value.revokedAt !== null && !timestamp(value.revokedAt))
    errors.push("DelegatedExecutionToken revokedAt must be null or an ISO-8601 UTC timestamp");
  if (
    timestamp(value.issuedAt) &&
    timestamp(value.revokedAt) &&
    Date.parse(value.revokedAt) < Date.parse(value.issuedAt)
  )
    errors.push("DelegatedExecutionToken revokedAt cannot be earlier than issuedAt");
  return errors;
}

export function verifyDelegatedExecutionToken(
  value: unknown,
  actor: ActorIdentity,
  actionKind: string,
  evaluatedAt: string,
): DelegatedExecutionTokenVerification {
  let token: DelegatedExecutionToken;
  try {
    token = parseDelegatedExecutionToken(value);
  } catch {
    return { ok: false, reasonCode: "delegated_token_contract_invalid" };
  }
  if (
    token.issuer.personId !== actor.principal.personId ||
    token.delegate.runtimeSessionId !== runtimeSessionIdFromActor(actor)
  )
    return { ok: false, reasonCode: "delegated_token_actor_mismatch" };
  if (!token.allowedActions.includes(actionKind)) return { ok: false, reasonCode: "delegated_token_action_forbidden" };
  if (!timestamp(evaluatedAt)) return { ok: false, reasonCode: "delegated_token_contract_invalid" };
  const at = Date.parse(evaluatedAt);
  if (at < Date.parse(token.issuedAt)) return { ok: false, reasonCode: "delegated_token_not_yet_valid" };
  if (at >= Date.parse(token.expiresAt)) return { ok: false, reasonCode: "delegated_token_expired" };
  if (token.revokedAt !== null && at >= Date.parse(token.revokedAt))
    return { ok: false, reasonCode: "delegated_token_revoked" };
  return { ok: true };
}

function actionName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/u.test(value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function personId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(value);
}
