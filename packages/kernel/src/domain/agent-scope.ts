import { sha256Text, stableStringify } from "../integrity/stable-hash.ts";
import { parseAgentDeclarationV1, type AgentDeclarationV1 } from "./agent-squad-schema.ts";
import { canonicalizeContractValue } from "./task.ts";

export type AgentScope = "local" | "shared";
export const DEFAULT_AGENT_SCOPE: AgentScope = "shared";

/** Missing scope on historical declarations resolves to shared without mutating stored JSON. */
export function resolveAgentScope(scope: AgentScope | undefined): AgentScope {
  return scope ?? DEFAULT_AGENT_SCOPE;
}

export interface LocalAgentTransferIntent {
  readonly direction: "share" | "unshare";
  readonly operationId: string;
  readonly sourceRevision: number;
  readonly targetScope: AgentScope;
  readonly declarationSha256: string;
}

export interface LocalAgentRecordV1 {
  readonly schema: "local-agent-record/v1";
  readonly id: string;
  readonly revision: number;
  readonly declaration: AgentDeclarationV1;
  readonly pendingTransfer?: LocalAgentTransferIntent;
}

export interface LocalAgentWriteOptions {
  readonly expectedVersion?: number;
  readonly pendingTransfer?: LocalAgentTransferIntent | null;
  /** When true, updates transfer metadata without advancing the declaration revision. */
  readonly preserveRevision?: boolean;
}

export interface LocalAgentStorePort {
  readonly list: () => readonly LocalAgentRecordV1[];
  readonly get: (agentId: string) => LocalAgentRecordV1 | null;
  readonly write: (declaration: AgentDeclarationV1, options?: LocalAgentWriteOptions) => number;
  readonly remove: (agentId: string, options?: { readonly expectedVersion?: number }) => boolean;
}

/** Scope-independent content digest of an Agent declaration so transfer retries match across scopes. */
export function agentDeclarationContentDigest(declaration: AgentDeclarationV1): string {
  const { scope: _scope, ...withoutScope } = declaration;
  return `sha256:${sha256Text(stableStringify(canonicalizeContractValue(withoutScope)))}`;
}

/**
 * Determines whether a local declaration and a shared canonical record represent the same
 * in-flight or interrupted scope transfer (including GUI publish with concurrent draft edits
 * recorded on `pendingTransfer.declarationSha256`).
 */
export function localDeclarationMatchesSharedValue(
  local: AgentDeclarationV1,
  sharedValue: unknown,
  pendingTransfer?: LocalAgentTransferIntent,
): boolean {
  if (typeof sharedValue !== "object" || sharedValue === null || Array.isArray(sharedValue)) return false;
  const {
    lifecycleState: _lifecycleState,
    retirement: _retirement,
    ...sharedDeclaration
  } = sharedValue as Record<string, unknown>;
  let parsedShared: AgentDeclarationV1;
  try {
    parsedShared = parseAgentDeclarationV1(sharedDeclaration);
  } catch {
    return false;
  }
  const sharedDigest = agentDeclarationContentDigest(parsedShared);
  if (agentDeclarationContentDigest(local) === sharedDigest) return true;
  return pendingTransfer !== undefined && pendingTransfer.declarationSha256 === sharedDigest;
}

export type UnshareCompensationJudgment = "commit_complete" | "compensate_remove_local" | "retain_local_uncertain";

/**
 * Only an authoritative pre-commit rejection (`op_rejected` with `durable !== true`) proves the
 * shared deletion did not land. Durable pending outcomes, post-commit errors, and transport drops
 * must retain the local copy so the user never loses their only live declaration.
 */
export function judgeUnshareCompensation(
  result: { readonly outcome?: unknown; readonly durable?: unknown } | { readonly error: unknown },
): UnshareCompensationJudgment {
  if ("error" in result) return "retain_local_uncertain";
  if (result.outcome === "applied") return "commit_complete";
  if (result.outcome === "op_rejected" && result.durable !== true) return "compensate_remove_local";
  return "retain_local_uncertain";
}

/** Extracts the requested scope from either top-level `action.scope` or `action.declaration.scope`. */
export function requestedAgentScopeFromAction(action: Readonly<Record<string, unknown>>): AgentScope | undefined {
  if (action.scope === "local" || action.scope === "shared") return action.scope;
  const declaration = action.declaration;
  if (typeof declaration === "object" && declaration !== null && !Array.isArray(declaration)) {
    const scope = (declaration as { readonly scope?: unknown }).scope;
    if (scope === "local" || scope === "shared") return scope;
  }
  return undefined;
}
