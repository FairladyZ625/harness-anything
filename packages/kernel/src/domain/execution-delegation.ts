import { parseDelegatedExecutionToken, type DelegatedExecutionToken } from "./delegated-execution-token.ts";
import type { EntityActionCompileInput } from "./entity-action-execution.ts";
import type { WriteSource } from "./write-chain.contract.ts";
import { stableStringify } from "../integrity/stable-hash.ts";

export interface ExecutionDelegationRecord {
  readonly repoId: string;
  readonly issuedByOperationId: string;
  readonly source: WriteSource;
  readonly token: DelegatedExecutionToken;
}
export interface ExecutionDelegationDraft {
  readonly record: ExecutionDelegationRecord;
  readonly changed: boolean;
}
export function compileExecutionDelegation(
  id: "delegate" | "revoke-delegation",
  input: EntityActionCompileInput,
): ExecutionDelegationDraft {
  const state = input.currentEntity as {
    readonly repoId: string;
    readonly records: readonly ExecutionDelegationRecord[];
  };
  const tokenId = String(input.action.tokenId ?? ""),
    held = state.records.find((record) => record.token.tokenId === tokenId);
  if (id === "delegate") {
    if (held) throw invalid("Delegation token already exists; use a new token id.");
    const token = parseDelegatedExecutionToken({
      schema: "delegated-execution-token/v1",
      tokenId,
      issuer: { personId: input.actor.principal.personId },
      delegate: { runtimeSessionId: input.action.runtimeSessionId },
      allowedActions: input.action.action,
      issuedAt: input.occurredAt,
      expiresAt: input.action.expiresAt,
      revokedAt: null,
    });
    return {
      record: { repoId: state.repoId, issuedByOperationId: input.opId, source: input.source, token },
      changed: true,
    };
  }
  if (
    !held ||
    held.token.issuer.personId !== input.actor.principal.personId ||
    stableStringify(held.source) !== stableStringify(input.source)
  )
    throw invalid("Revoke requires the issuing principal and source of an existing delegation.");
  if (held.token.revokedAt !== null) return { record: held, changed: false };
  return {
    record: { ...held, token: parseDelegatedExecutionToken({ ...held.token, revokedAt: input.occurredAt }) },
    changed: true,
  };
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: "invalid_delegated_execution_token" });
}
