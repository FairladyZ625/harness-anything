import { isPortablePhysicalPath } from "./architecture-manifest.mjs";
import {
  architectureFindingsHaveUniqueIds,
  architectureMissingToolsHaveUniqueIdentities,
  isArchitectureRecord,
  nonEmptyArchitectureString,
  validArchitectureDriftFinding,
  validArchitectureIssue,
  validArchitectureManifestDescriptor,
  validArchitectureMissingTool,
  validArchitectureNextAction,
  validArchitectureSnapshotArtifactDescriptor,
  validArchitectureWarning
} from "./architecture-report-contracts.mjs";

const initReportKeys = ["schema", "status", "created", "unchanged", "conflicts", "issues", "nextActions"];
const initConflictKeys = ["path", "reason", "existingAliases", "remediation"];
const snapshotReportKeys = [
  "schema",
  "status",
  "manifest",
  "snapshot",
  "missingTools",
  "issues",
  "findings",
  "warnings",
  "nextActions"
];

export function validateArchitectureInitReport(value) {
  if (!hasExactKeys(value, initReportKeys) || value.schema !== "architecture-init-report/v1") {
    return invalid("$", "Init reports must use the closed architecture-init-report/v1 shape.");
  }
  const issues = [];
  if (!["initialized", "unchanged", "conflict", "invalid"].includes(value.status)) issues.push(issue("status", "Init report status is invalid."));
  for (const key of ["created", "unchanged", "conflicts", "issues", "nextActions"]) {
    if (!Array.isArray(value[key])) issues.push(issue(key, `${key} must be an array.`));
  }
  for (const [key, records] of [["created", value.created], ["unchanged", value.unchanged]]) {
    if (Array.isArray(records) && records.some((entry) => !isPortablePhysicalPath(entry))) issues.push(issue(key, `${key} paths must be portable repository-relative paths.`));
  }
  if (Array.isArray(value.conflicts) && value.conflicts.some((entry) => !validInitConflict(entry))) issues.push(issue("conflicts", "Init conflicts require portable paths, reasons, aliases, and remediation."));
  if (Array.isArray(value.issues) && value.issues.some((entry) => !validArchitectureIssue(entry))) issues.push(issue("issues", "Init issues require exactly code, path, and message."));
  if (!validStringItems(value.nextActions, validArchitectureNextAction)) issues.push(issue("nextActions", "Init next actions must be non-empty strings."));
  if (value.status === "initialized" && (value.created?.length === 0 || value.conflicts?.length !== 0 || value.issues?.length !== 0)) issues.push(issue("status", "Initialized reports require created paths and no conflicts or issues."));
  if (value.status === "unchanged" && (value.created?.length !== 0 || value.conflicts?.length !== 0 || value.issues?.length !== 0)) issues.push(issue("status", "Unchanged reports cannot create paths or contain conflicts or issues."));
  if (value.status === "conflict" && (value.created?.length !== 0 || value.conflicts?.length === 0 || value.issues?.length !== 0)) issues.push(issue("status", "Conflict reports require conflicts, no created paths, and no validation issues."));
  if (value.status === "invalid" && (value.created?.length !== 0 || value.conflicts?.length !== 0 || value.issues?.length === 0)) issues.push(issue("status", "Invalid init reports require issues and no created paths or conflicts."));
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

export function validateArchitectureSnapshotReport(value) {
  if (!hasExactKeys(value, snapshotReportKeys) || value.schema !== "architecture-snapshot-report/v1") {
    return invalid("$", "Snapshot reports must use the closed architecture-snapshot-report/v1 shape.");
  }
  const issues = [];
  if (!["not-configured", "fresh", "drifted", "invalid", "tool-missing"].includes(value.status)) issues.push(issue("status", "Snapshot report status is invalid."));
  if (!validArchitectureManifestDescriptor(value.manifest)) issues.push(issue("manifest", "Snapshot report manifest descriptor is invalid."));
  if (value.snapshot !== null && !validArchitectureSnapshotArtifactDescriptor(value.snapshot)) issues.push(issue("snapshot", "Snapshot report snapshot descriptor is invalid."));
  for (const key of ["missingTools", "issues", "findings", "warnings", "nextActions"]) {
    if (!Array.isArray(value[key])) issues.push(issue(key, `${key} must be an array.`));
  }
  if (Array.isArray(value.missingTools) && value.missingTools.some((entry) => !validArchitectureMissingTool(entry))) issues.push(issue("missingTools", "Missing tools require the exact frozen tool-missing shape."));
  if (Array.isArray(value.missingTools) && !architectureMissingToolsHaveUniqueIdentities(value.missingTools)) issues.push(issue("missingTools", "Missing-tool identities must be unique."));
  if (Array.isArray(value.issues) && value.issues.some((entry) => !validArchitectureIssue(entry))) issues.push(issue("issues", "Snapshot issues require exactly code, path, and message."));
  if (Array.isArray(value.findings) && value.findings.some((entry) => !validArchitectureDriftFinding(entry))) issues.push(issue("findings", "Snapshot findings must satisfy architecture-drift-finding/v1."));
  if (Array.isArray(value.findings) && !architectureFindingsHaveUniqueIds(value.findings)) issues.push(issue("findings", "Snapshot finding IDs must be unique."));
  if (!validStringItems(value.warnings, validArchitectureWarning)) issues.push(issue("warnings", "Snapshot warnings must be non-empty strings."));
  if (!validStringItems(value.nextActions, validArchitectureNextAction)) issues.push(issue("nextActions", "Snapshot next actions must be non-empty strings."));
  validateSnapshotStatusEvidence(value, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function validInitConflict(value) {
  return hasExactKeys(value, initConflictKeys) && isPortablePhysicalPath(value.path) && nonEmptyArchitectureString(value.reason) &&
    Array.isArray(value.existingAliases) && value.existingAliases.every(isPortablePhysicalPath) && nonEmptyArchitectureString(value.remediation);
}

function validateSnapshotStatusEvidence(value, issues) {
  if (value.status === "not-configured" && (!manifestAbsent(value.manifest) || value.snapshot !== null || !emptyEvidence(value))) {
    issues.push(issue("status", "Not-configured reports require an absent manifest and no snapshot, issues, missing tools, or findings."));
  }
  if (value.status === "invalid" && (value.snapshot !== null || value.issues?.length === 0 || value.missingTools?.length !== 0 || value.findings?.length !== 0)) {
    issues.push(issue("status", "Invalid snapshot reports require only issue evidence and no snapshot."));
  }
  if (value.status === "tool-missing" && (!manifestConfigured(value.manifest) || value.snapshot !== null || value.missingTools?.length === 0 || value.issues?.length !== 0 || value.findings?.length !== 0)) {
    issues.push(issue("status", "Tool-missing reports require a configured manifest and only missing-tool evidence."));
  }
  if (value.status === "fresh" && (!manifestConfigured(value.manifest) || !validArchitectureSnapshotArtifactDescriptor(value.snapshot) || value.findings?.length !== 0 || value.issues?.length !== 0 || value.missingTools?.length !== 0)) {
    issues.push(issue("status", "Fresh snapshot reports require a configured manifest, a snapshot, and no failure or drift evidence."));
  }
  if (value.status === "drifted" && (!manifestConfigured(value.manifest) || !validArchitectureSnapshotArtifactDescriptor(value.snapshot) || value.findings?.length === 0 || value.issues?.length !== 0 || value.missingTools?.length !== 0)) {
    issues.push(issue("status", "Drifted snapshot reports require a configured manifest, a snapshot, and only drift findings."));
  }
}

function emptyEvidence(value) {
  return value.issues?.length === 0 && value.missingTools?.length === 0 && value.findings?.length === 0;
}

function manifestAbsent(value) {
  return isArchitectureRecord(value) && value.present === false && value.valid === false && value.digest === null;
}

function manifestConfigured(value) {
  return isArchitectureRecord(value) && value.present === true && value.valid === true;
}

function validStringItems(value, validator) {
  return Array.isArray(value) && value.every(validator);
}

function issue(path, message) {
  return { code: "architecture_operation_report_invalid", path, message };
}

function invalid(path, message) {
  return { ok: false, issues: [issue(path, message)] };
}

function hasExactKeys(value, keys) {
  if (!isArchitectureRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
