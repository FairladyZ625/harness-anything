import { isJsonObject } from "./json-rpc-types.ts";

export function validateReckoningRead(value: unknown): readonly string[] {
  return isJsonObject(value) &&
    value.schema === "reckoning-signals/v1" &&
    value.ok === true &&
    typeof value.generatedAt === "string" &&
    Number.isFinite(Date.parse(value.generatedAt)) &&
    typeof value.since === "string" &&
    Number.isFinite(Date.parse(value.since)) &&
    Array.isArray(value.signals) &&
    value.signals.every(
      (signal) =>
        isJsonObject(signal) &&
        ["abnormal-session", "corrected-fact", "short-lived-decision", "rework"].includes(String(signal.kind)) &&
        typeof signal.key === "string" &&
        Number.isSafeInteger(signal.occurrences) &&
        Number(signal.occurrences) > 0 &&
        isJsonObject(signal.evidence),
    )
    ? []
    : ["invalid reckoning signals read"];
}

export function validatePolicyMetadataRead(value: unknown): readonly string[] {
  const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  return isJsonObject(value) &&
    value.schema === "policy-metadata/v1" &&
    value.ok === true &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group) =>
        isJsonObject(group) &&
        typeof group.id === "string" &&
        typeof group.base === "boolean" &&
        typeof group.displayName === "string" &&
        strings(group.scopes) &&
        strings(group.composites) &&
        strings(group.effectiveScopes),
    ) &&
    Array.isArray(value.actions) &&
    value.actions.every(
      (action) =>
        isJsonObject(action) &&
        typeof action.action === "string" &&
        isJsonObject(action.presentation) &&
        typeof action.executionClass === "string" &&
        typeof action.policyTier === "string" &&
        typeof action.residencyScope === "string",
    )
    ? []
    : ["invalid policy metadata read"];
}
