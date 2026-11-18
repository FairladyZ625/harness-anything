import { hasOnlyFields, hasRequiredFields, isNonEmptyString, isRecord } from "./contract-validation.ts";

export type WriteSource =
  | "local"
  | "remote_direct"
  | "migration-import/v1"
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "watch_session"; readonly sessionId: string; readonly path: string; readonly fingerprint: string };

export const CENTER_NODE_ID = "center";

/** Accepts historical source shapes read from persisted envelopes. */
export function writeSourceNodeId(source: unknown): string | null {
  if (source === "local") return CENTER_NODE_ID;
  return isRecord(source) && (source.kind === "node" || source.kind === "assignment") && isNonEmptyString(source.nodeId)
    ? source.nodeId
    : null;
}

export function writeSourceRuntimeSessionId(source: unknown): string | null {
  return typeof source === "string" && source.startsWith("runtime-session/")
    ? source.slice("runtime-session/".length) || null
    : null;
}

export function hasContractFields(
  value: Readonly<Record<string, unknown>>,
  fields: readonly string[],
  allowUnknownFields: boolean,
): boolean {
  return allowUnknownFields ? hasRequiredFields(value, fields) : hasOnlyFields(value, fields);
}

export function safeWorkspacePath(value: unknown): value is string {
  return (
    isNonEmptyString(value) &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

export function validateWriteSource(value: unknown, allowUnknownFields = false): readonly string[] {
  if (value === "local" || value === "remote_direct" || value === "migration-import/v1") return [];
  if (
    isRecord(value) &&
    hasContractFields(value, ["kind", "nodeId"], allowUnknownFields) &&
    value.kind === "node" &&
    isNonEmptyString(value.nodeId)
  )
    return [];
  // Retired assignments identify immutable history only; current writes reject them.
  if (
    allowUnknownFields &&
    isRecord(value) &&
    hasRequiredFields(value, ["kind", "assignmentId", "nodeId"]) &&
    value.kind === "assignment" &&
    isNonEmptyString(value.assignmentId) &&
    isNonEmptyString(value.nodeId)
  )
    return [];
  if (
    allowUnknownFields &&
    isRecord(value) &&
    hasContractFields(value, ["kind", "sessionId", "path", "fingerprint"], true) &&
    value.kind === "watch_session" &&
    isNonEmptyString(value.sessionId) &&
    safeWorkspacePath(value.path) &&
    /^[0-9a-f]{64}$/u.test(String(value.fingerprint))
  )
    return [];
  return ["source must be local, remote_direct, migration-import/v1, or an assignment identity"];
}
