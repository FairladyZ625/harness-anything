import { hasOnlyFields, hasRequiredFields, isNonEmptyString, isRecord } from "./contract-validation.ts";

export type WriteSource =
  | "local"
  | "remote_direct"
  | "migration-import/v1"
  | { readonly kind: "node"; readonly nodeId: string }
  | { readonly kind: "watch_session"; readonly sessionId: string; readonly path: string; readonly fingerprint: string };

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
