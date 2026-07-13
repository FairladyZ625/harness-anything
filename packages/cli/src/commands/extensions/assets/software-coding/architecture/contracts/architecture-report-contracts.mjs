import { isArchitectureStableId, isPortablePhysicalPath } from "./architecture-manifest.mjs";

const digestPattern = /^sha256:[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40,64}$/u;
const issueKeys = ["code", "path", "message"];
const missingToolKeys = ["role", "declarationId", "adapter", "tool", "version", "reason", "hint"];
const manifestDescriptorKeys = ["path", "present", "valid", "digest"];
const checkSnapshotDescriptorKeys = ["path", "present", "valid", "digest", "provenance"];
const snapshotArtifactDescriptorKeys = ["path", "digest", "provenance"];
const provenanceKeys = ["commit", "sourceDigest", "modelDigest", "tools"];
const commitKeys = ["sha", "verification"];
const toolKeys = ["role", "declarationId", "adapter", "tool", "version"];
const toolComparisonKeys = [
  "role",
  "declarationId",
  "adapter",
  "snapshotTool",
  "currentTool",
  "snapshotVersion",
  "currentVersion",
  "comparison"
];
const findingKeys = [
  "schema",
  "id",
  "kind",
  "severity",
  "extractorId",
  "relationshipId",
  "sourceNodeId",
  "targetNodeId",
  "toolRef",
  "evidence",
  "message"
];
const findingEvidenceKeys = ["sourcePath", "targetPath", "line"];

export function validArchitectureManifestDescriptor(value) {
  if (!hasExactKeys(value, manifestDescriptorKeys) ||
    !isPortablePhysicalPath(value.path) ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    (value.digest !== null && !isArchitectureDigest(value.digest))) return false;
  if (!value.present) return value.valid === false && value.digest === null;
  return !value.valid || isArchitectureDigest(value.digest);
}

export function validArchitectureCheckSnapshotDescriptor(value) {
  if (!hasExactKeys(value, checkSnapshotDescriptorKeys) ||
    (value.path !== null && !isPortablePhysicalPath(value.path)) ||
    typeof value.present !== "boolean" ||
    typeof value.valid !== "boolean" ||
    (value.digest !== null && !isArchitectureDigest(value.digest)) ||
    (value.provenance !== null && !validArchitectureProvenance(value.provenance))) return false;
  if (!value.present) {
    return value.valid === false && value.digest === null && value.provenance === null;
  }
  if (value.path === null) return false;
  return value.valid
    ? isArchitectureDigest(value.digest) && validArchitectureProvenance(value.provenance)
    : value.digest === null && value.provenance === null;
}

export function validArchitectureSnapshotArtifactDescriptor(value) {
  return hasExactKeys(value, snapshotArtifactDescriptorKeys) &&
    isPortablePhysicalPath(value.path) &&
    isArchitectureDigest(value.digest) &&
    validArchitectureProvenance(value.provenance);
}

export function validArchitectureProvenance(value) {
  if (!hasExactKeys(value, provenanceKeys) ||
    !validArchitectureCommit(value.commit) ||
    !isArchitectureDigest(value.sourceDigest) ||
    !isArchitectureDigest(value.modelDigest) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    value.tools.some((tool) => !validArchitectureTool(tool))) return false;
  return architectureToolIdentitiesAreUnique(value.tools);
}

export function validArchitectureIssue(value) {
  return hasExactKeys(value, issueKeys) &&
    nonEmptyArchitectureString(value.code) &&
    nonEmptyArchitectureString(value.path) &&
    nonEmptyArchitectureString(value.message);
}

export function validArchitectureMissingTool(value) {
  return hasExactKeys(value, missingToolKeys) &&
    ["provider", "extractor"].includes(value.role) &&
    isArchitectureStableId(value.declarationId) &&
    nonEmptyArchitectureString(value.adapter) &&
    nonEmptyArchitectureString(value.tool) &&
    value.version === null &&
    nonEmptyArchitectureString(value.reason) &&
    nonEmptyArchitectureString(value.hint);
}

export function validArchitectureDriftFinding(value) {
  if (!hasExactKeys(value, findingKeys) ||
    value.schema !== "architecture-drift-finding/v1" ||
    !isArchitectureStableId(value.id) ||
    !isArchitectureStableId(value.kind) ||
    !["info", "warning", "error"].includes(value.severity) ||
    !nullableStableId(value.extractorId) ||
    !nullableStableId(value.relationshipId) ||
    !nullableStableId(value.sourceNodeId) ||
    !nullableStableId(value.targetNodeId) ||
    !nullableNonEmptyString(value.toolRef) ||
    !Array.isArray(value.evidence) ||
    value.evidence.some((entry) => !validFindingEvidence(entry)) ||
    !nonEmptyArchitectureString(value.message)) return false;
  return value.relationshipId !== null ||
    value.sourceNodeId !== null ||
    value.targetNodeId !== null ||
    value.evidence.length > 0;
}

export function validateArchitectureDriftFinding(value) {
  return validArchitectureDriftFinding(value);
}

export function validArchitectureWarning(value) {
  return nonEmptyArchitectureString(value);
}

export function validArchitectureNextAction(value) {
  return nonEmptyArchitectureString(value);
}

export function validArchitectureToolComparison(value) {
  return hasExactKeys(value, toolComparisonKeys) &&
    ["provider", "extractor"].includes(value.role) &&
    isArchitectureStableId(value.declarationId) &&
    nonEmptyArchitectureString(value.adapter) &&
    nullableNonEmptyString(value.snapshotTool) &&
    nullableNonEmptyString(value.currentTool) &&
    nullableNonEmptyString(value.snapshotVersion) &&
    nullableNonEmptyString(value.currentVersion) &&
    ["match", "mismatch"].includes(value.comparison);
}

export function architectureToolComparisonsMatchProvenance(comparisons, snapshotProvenance, currentProvenance) {
  if (!Array.isArray(comparisons) ||
    !validArchitectureProvenance(snapshotProvenance) ||
    !validArchitectureProvenance(currentProvenance) ||
    comparisons.some((entry) => !validArchitectureToolComparison(entry))) return false;
  const expected = expectedArchitectureToolComparisons(snapshotProvenance.tools, currentProvenance.tools);
  if (comparisons.length !== expected.length) return false;
  const actualByIdentity = new Map(comparisons.map((entry) => [architectureToolIdentity(entry), entry]));
  if (actualByIdentity.size !== comparisons.length) return false;
  return expected.every((entry) => sameToolComparison(actualByIdentity.get(architectureToolIdentity(entry)), entry));
}

export function architectureToolIdentity(value) {
  return `${value?.role ?? ""}\0${value?.declarationId ?? ""}\0${value?.adapter ?? ""}`;
}

export function architectureToolIdentitiesAreUnique(values) {
  if (!Array.isArray(values)) return false;
  const identities = values.map(architectureToolIdentity);
  return new Set(identities).size === identities.length;
}

export function architectureFindingsHaveUniqueIds(values) {
  if (!Array.isArray(values)) return false;
  const identities = values.map((entry) => entry?.id);
  return new Set(identities).size === identities.length;
}

export function architectureMissingToolsHaveUniqueIdentities(values) {
  if (!Array.isArray(values)) return false;
  const identities = values.map(architectureToolIdentity);
  return new Set(identities).size === identities.length;
}

export function isArchitectureDigest(value) {
  return typeof value === "string" && digestPattern.test(value);
}

export function nonEmptyArchitectureString(value) {
  return typeof value === "string" && value.length > 0;
}

export function isArchitectureRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validArchitectureCommit(value) {
  return hasExactKeys(value, commitKeys) &&
    ["verified", "unverified"].includes(value.verification) &&
    (value.verification === "verified"
      ? typeof value.sha === "string" && commitPattern.test(value.sha)
      : value.sha === null || typeof value.sha === "string" && commitPattern.test(value.sha));
}

function validArchitectureTool(value) {
  return hasExactKeys(value, toolKeys) &&
    ["provider", "extractor"].includes(value.role) &&
    isArchitectureStableId(value.declarationId) &&
    nonEmptyArchitectureString(value.adapter) &&
    nonEmptyArchitectureString(value.tool) &&
    nonEmptyArchitectureString(value.version);
}

function validFindingEvidence(value) {
  return hasExactKeys(value, findingEvidenceKeys) &&
    nullablePortablePath(value.sourcePath) &&
    nullablePortablePath(value.targetPath) &&
    (value.sourcePath !== null || value.targetPath !== null) &&
    (value.line === null || Number.isInteger(value.line) && value.line > 0);
}

function expectedArchitectureToolComparisons(snapshotTools, currentTools) {
  const snapshotByIdentity = new Map(snapshotTools.map((tool) => [architectureToolIdentity(tool), tool]));
  const currentByIdentity = new Map(currentTools.map((tool) => [architectureToolIdentity(tool), tool]));
  return [...new Set([...snapshotByIdentity.keys(), ...currentByIdentity.keys()])].sort().map((identity) => {
    const snapshot = snapshotByIdentity.get(identity);
    const current = currentByIdentity.get(identity);
    return {
      role: current?.role ?? snapshot?.role,
      declarationId: current?.declarationId ?? snapshot?.declarationId,
      adapter: current?.adapter ?? snapshot?.adapter,
      snapshotTool: snapshot?.tool ?? null,
      currentTool: current?.tool ?? null,
      snapshotVersion: snapshot?.version ?? null,
      currentVersion: current?.version ?? null,
      comparison: snapshot && current && snapshot.tool === current.tool && snapshot.version === current.version
        ? "match"
        : "mismatch"
    };
  });
}

function sameToolComparison(actual, expected) {
  return actual !== undefined && toolComparisonKeys.every((key) => actual[key] === expected[key]);
}

function nullableStableId(value) {
  return value === null || isArchitectureStableId(value);
}

function nullableNonEmptyString(value) {
  return value === null || nonEmptyArchitectureString(value);
}

function nullablePortablePath(value) {
  return value === null || isPortablePhysicalPath(value);
}

function hasExactKeys(value, keys) {
  if (!isArchitectureRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
