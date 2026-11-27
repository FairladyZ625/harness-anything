import { isJsonObject } from "./json-rpc-types.ts";
import { validationError } from "./daemon-protocol-validate-entities.ts";
import { residentCeoWakeCauseWords } from "./daemon-protocol-vocabulary.ts";

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isValidResidentCeoProfileValue(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  if (
    value.schema !== "resident-ceo-profile/v1" ||
    typeof value.principalPersonId !== "string" ||
    typeof value.runtimeInstanceId !== "string" ||
    typeof value.model !== "string" ||
    !Number.isSafeInteger(value.heartbeatIntervalSec) ||
    !isNullableString(value.persistentSessionId) ||
    (value.status !== "running" && value.status !== "stopped") ||
    (value.lastWake !== null && !isJsonObject(value.lastWake)) ||
    typeof value.updatedAt !== "string"
  )
    return false;
  // N/N-1 forward & backward compatibility: Phase 2/3 fields are optional when absent (older daemon)
  // and validated loosely by type when present; additive fields from newer daemons are preserved.
  if (value.repoId !== undefined && typeof value.repoId !== "string") return false;
  if (value.executionPolicy !== undefined && typeof value.executionPolicy !== "string") return false;
  if (value.defaultWorkId !== undefined && !isNullableString(value.defaultWorkId)) return false;
  if (value.defaultAgentId !== undefined && !isNullableString(value.defaultAgentId)) return false;
  if (
    value.autoApproveSenders !== undefined &&
    (!Array.isArray(value.autoApproveSenders) || !value.autoApproveSenders.every((entry) => typeof entry === "string"))
  )
    return false;
  if (value.approvalGate !== undefined && !isJsonObject(value.approvalGate)) return false;
  if (value.proposals !== undefined && (!Array.isArray(value.proposals) || !value.proposals.every(isJsonObject)))
    return false;
  if (value.history !== undefined && (!Array.isArray(value.history) || !value.history.every(isValidHistoryEntry)))
    return false;
  return true;
}

function isValidHistoryEntry(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.wakeId === "string" &&
    (residentCeoWakeCauseWords as readonly string[]).includes(String(value.cause)) &&
    typeof value.requestedAt === "string" &&
    isNullableString(value.completedAt) &&
    (value.status === "running" || value.status === "succeeded" || value.status === "failed") &&
    isNullableString(value.runtimeSessionId) &&
    (value.requestText === undefined || isNullableString(value.requestText)) &&
    (value.responseText === undefined || isNullableString(value.responseText)) &&
    (value.detail === undefined || isNullableString(value.detail))
  );
}

/**
 * Validates `repo.residentCeo.*` RPC responses without forcing them through `command-receipt/v2`.
 * Preserves N/N-1 compatibility by accepting absent optional Phase 2/3 fields from older daemons
 * and tolerating additive fields from newer daemons.
 */
export function validateResidentCeoRpcResult(method: string, value: unknown): readonly string[] {
  if (!isJsonObject(value)) return [validationError(method, "$", value, "must be an object")];
  if (value.ok !== true) return [validationError(method, "ok", value.ok, "must be true")];
  if (value.profile !== null && !isValidResidentCeoProfileValue(value.profile))
    return [validationError(method, "profile", value.profile, "must be null or a valid resident-ceo-profile/v1")];
  if (value.summary !== undefined && typeof value.summary !== "string")
    return [validationError(method, "summary", value.summary, "must be a string")];
  if (method === "repo.residentCeo.chat" && value.response !== undefined && !isNullableString(value.response))
    return [validationError(method, "response", value.response, "must be a string or null")];
  if (
    method === "repo.residentCeo.proposals" &&
    (!Array.isArray(value.proposals) || !value.proposals.every(isJsonObject))
  )
    return [validationError(method, "proposals", value.proposals, "must be an array of delegation proposals")];
  if (
    method === "repo.residentCeo.history" &&
    (!Array.isArray(value.history) || !value.history.every(isValidHistoryEntry))
  )
    return [validationError(method, "history", value.history, "must be an array of resident CEO history entries")];
  if (
    (method === "repo.residentCeo.approve" || method === "repo.residentCeo.reject") &&
    value.proposal !== undefined &&
    !isJsonObject(value.proposal)
  )
    return [validationError(method, "proposal", value.proposal, "must be a delegation proposal object")];
  return [];
}
