import {
  canonicalValue,
  compareArchitectureText,
  sortedValues
} from "./architecture-runtime.mjs";
import {
  architectureFindingsHaveUniqueIds,
  architectureMissingToolsHaveUniqueIdentities,
  architectureToolComparisonsMatchProvenance,
  isArchitectureRecord as isRecord,
  nonEmptyArchitectureString,
  validArchitectureCheckSnapshotDescriptor,
  validArchitectureDriftFinding,
  validArchitectureIssue,
  validArchitectureManifestDescriptor,
  validArchitectureMissingTool,
  validArchitectureNextAction,
  validArchitectureProvenance,
  validArchitectureToolComparison,
  validArchitectureWarning
} from "./architecture-report-contracts.mjs";

const checkReportKeys = [
  "schema",
  "status",
  "manifest",
  "snapshot",
  "current",
  "comparison",
  "reasons",
  "issues",
  "missingTools",
  "findings",
  "warnings",
  "nextActions"
];

export function evaluateArchitectureCheckState(input) {
  const configurationIssues = Array.isArray(input.configurationIssues) ? input.configurationIssues : [];
  const missingTools = Array.isArray(input.missingTools) ? input.missingTools : [];
  if (input.configured !== true) {
    return baseState("not-configured", {
      sourceDigest: "not-checked",
      modelDigest: "not-checked",
      toolVersions: []
    });
  }
  if (configurationIssues.length > 0) {
    return {
      ...baseState("invalid", {
        sourceDigest: "not-checked",
        modelDigest: "not-checked",
        toolVersions: []
      }),
      issues: configurationIssues
    };
  }
  if (missingTools.length > 0) {
    return {
      ...baseState("tool-missing", {
        sourceDigest: "not-checked",
        modelDigest: "not-checked",
        toolVersions: []
      }),
      missingTools
    };
  }
  if (!isRecord(input.snapshot) || !isRecord(input.current)) {
    return {
      ...baseState("drifted", {
        sourceDigest: "not-checked",
        modelDigest: "not-checked",
        toolVersions: []
      }),
      reasons: ["snapshot-missing"]
    };
  }

  const snapshotProvenance = isRecord(input.snapshot.provenance) ? input.snapshot.provenance : {};
  const currentProvenance = isRecord(input.current.provenance) ? input.current.provenance : {};
  const comparison = {
    sourceDigest: compareValue(snapshotProvenance.sourceDigest, currentProvenance.sourceDigest),
    modelDigest: compareValue(snapshotProvenance.modelDigest, currentProvenance.modelDigest),
    toolVersions: compareTools(snapshotProvenance.tools, currentProvenance.tools)
  };
  const findings = Array.isArray(input.current.findings) ? input.current.findings : [];
  const drifted = comparison.sourceDigest !== "match" ||
    comparison.modelDigest !== "match" ||
    comparison.toolVersions.some((entry) => entry.comparison !== "match") ||
    findings.length > 0;
  return {
    ...baseState(drifted ? "drifted" : "fresh", comparison),
    findings,
    reasons: [
      ...(comparison.sourceDigest === "mismatch" ? ["source-digest-mismatch"] : []),
      ...(comparison.modelDigest === "mismatch" ? ["model-digest-mismatch"] : []),
      ...(comparison.toolVersions.some((entry) => entry.comparison !== "match") ? ["tool-version-mismatch"] : []),
      ...(findings.length > 0 ? ["semantic-findings"] : [])
    ]
  };
}

export function buildArchitectureCheckReport(input) {
  return {
    schema: "architecture-check-report/v1",
    status: input.status,
    manifest: canonicalValue(input.manifest),
    snapshot: canonicalValue(input.snapshot),
    current: canonicalValue(input.current),
    comparison: canonicalValue(input.comparison),
    reasons: sortedValues(input.reasons),
    issues: sortedValues(input.issues),
    missingTools: sortedValues(input.missingTools),
    findings: sortedValues(input.findings),
    warnings: sortedValues(input.warnings),
    nextActions: sortedValues(input.nextActions)
  };
}

export function validateArchitectureCheckReport(value) {
  if (!hasExactKeys(value, checkReportKeys) || value.schema !== "architecture-check-report/v1") {
    return { ok: false, issues: [checkReportIssue("$", "Check reports must use the closed architecture-check-report/v1 shape.")] };
  }
  const issues = [];
  if (!["not-configured", "fresh", "drifted", "invalid", "tool-missing"].includes(value.status)) {
    issues.push(checkReportIssue("status", "Check report status is invalid."));
  }
  if (!validArchitectureManifestDescriptor(value.manifest)) {
    issues.push(checkReportIssue("manifest", "Check report manifest descriptor is invalid."));
  }
  if (!validArchitectureCheckSnapshotDescriptor(value.snapshot)) {
    issues.push(checkReportIssue("snapshot", "Check report snapshot descriptor is invalid."));
  }
  if (value.current !== null && !validArchitectureProvenance(value.current)) {
    issues.push(checkReportIssue("current", "Check report current provenance is invalid."));
  }
  if (!validCheckComparison(value.comparison)) {
    issues.push(checkReportIssue("comparison", "Check report comparison is invalid."));
  }
  for (const key of ["reasons", "issues", "missingTools", "findings", "warnings", "nextActions"]) {
    if (!Array.isArray(value[key])) issues.push(checkReportIssue(key, `${key} must be an array.`));
  }
  if (Array.isArray(value.reasons) && value.reasons.some((reason) => !nonEmptyArchitectureString(reason))) {
    issues.push(checkReportIssue("reasons", "Check report reasons must be non-empty strings."));
  }
  validateCollectionItems(value, issues);
  validateStatusInvariants(value, issues);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

function validateCollectionItems(value, issues) {
  const contracts = [
    ["issues", validArchitectureIssue, "Check report issues require exactly code, path, and message."],
    ["missingTools", validArchitectureMissingTool, "Check report missing tools require the exact frozen tool-missing shape."],
    ["findings", validArchitectureDriftFinding, "Check report findings must satisfy architecture-drift-finding/v1."],
    ["warnings", validArchitectureWarning, "Check report warnings must be non-empty strings."],
    ["nextActions", validArchitectureNextAction, "Check report next actions must be non-empty strings."]
  ];
  for (const [key, validator, message] of contracts) {
    if (Array.isArray(value[key]) && value[key].some((entry) => !validator(entry))) {
      issues.push(checkReportIssue(key, message));
    }
  }
  if (Array.isArray(value.findings) && !architectureFindingsHaveUniqueIds(value.findings)) {
    issues.push(checkReportIssue("findings", "Check report finding IDs must be unique."));
  }
  if (Array.isArray(value.missingTools) && !architectureMissingToolsHaveUniqueIdentities(value.missingTools)) {
    issues.push(checkReportIssue("missingTools", "Check report missing-tool identities must be unique."));
  }
}

function validateStatusInvariants(value, issues) {
  switch (value.status) {
    case "not-configured":
      requireNotConfiguredState(value, issues);
      break;
    case "invalid":
      requireInvalidState(value, issues);
      break;
    case "tool-missing":
      requireToolMissingState(value, issues);
      break;
    case "fresh":
      requireFreshState(value, issues);
      break;
    case "drifted":
      requireDriftedState(value, issues);
      break;
  }
}

function requireNotConfiguredState(value, issues) {
  if (!manifestAbsent(value.manifest)) {
    issues.push(checkReportIssue("manifest", "Not-configured check reports require an absent, invalid manifest descriptor."));
  }
  if (!isRecord(value.snapshot) || value.snapshot.path !== null || value.snapshot.present !== false || value.snapshot.valid !== false) {
    issues.push(checkReportIssue("snapshot", "Not-configured check reports require an absent, invalid snapshot descriptor."));
  }
  requireNullCurrentAndUncheckedComparison(value, "Not-configured", issues);
  requireEmptyArrays(value, ["reasons", "issues", "missingTools", "findings"], "Not-configured", issues);
}

function requireInvalidState(value, issues) {
  if (!invalidStateSnapshotDescriptor(value.snapshot)) {
    issues.push(checkReportIssue("snapshot", "Invalid check reports require an absent, invalid, or previously validated snapshot fact descriptor."));
  }
  requireNullCurrentAndUncheckedComparison(value, "Invalid", issues);
  requireNonEmptyArray(value, "issues", "Invalid check reports must include at least one issue.", issues);
  requireEmptyArrays(value, ["reasons", "missingTools", "findings"], "Invalid", issues);
}

function requireToolMissingState(value, issues) {
  if (!manifestConfigured(value.manifest)) {
    issues.push(checkReportIssue("manifest", "Tool-missing check reports require a present, valid manifest."));
  }
  if (!snapshotIsAbsentOrValid(value.snapshot)) {
    issues.push(checkReportIssue("snapshot", "Tool-missing check reports require an absent or valid snapshot descriptor."));
  }
  requireNullCurrentAndUncheckedComparison(value, "Tool-missing", issues);
  requireNonEmptyArray(value, "missingTools", "Tool-missing check reports must identify at least one tool.", issues);
  requireEmptyArrays(value, ["reasons", "issues", "findings"], "Tool-missing", issues);
}

function requireFreshState(value, issues) {
  if (!manifestConfigured(value.manifest)) {
    issues.push(checkReportIssue("manifest", "Fresh check reports require a present, valid manifest."));
  }
  if (!validArchitectureProvenance(value.current)) {
    issues.push(checkReportIssue("current", "Fresh check reports require current provenance."));
  }
  if (!isRecord(value.snapshot) || value.snapshot.present !== true || value.snapshot.valid !== true) {
    issues.push(checkReportIssue("snapshot", "Fresh check reports require a present, valid snapshot."));
  }
  if (!freshComparison(value)) {
    issues.push(checkReportIssue("comparison", "Fresh check reports require matching source, model, semantic, and tool comparisons; commit provenance does not determine freshness."));
  }
  requireEmptyArrays(value, ["reasons", "issues", "missingTools", "findings"], "Fresh", issues);
}

function requireDriftedState(value, issues) {
  if (!manifestConfigured(value.manifest)) {
    issues.push(checkReportIssue("manifest", "Drifted check reports require a present, valid manifest."));
  }
  if (!validArchitectureProvenance(value.current)) {
    issues.push(checkReportIssue("current", "Drifted check reports require current provenance."));
  }
  if (!snapshotIsAbsentOrValid(value.snapshot)) {
    issues.push(checkReportIssue("snapshot", "Drifted check reports require an absent or valid snapshot descriptor."));
  }
  if (isRecord(value.snapshot) && value.snapshot.present === false) {
    if (!missingSnapshotDrift(value)) {
      issues.push(checkReportIssue("comparison", "Snapshot-missing drift must leave provenance comparisons unchecked and derive semantic state only from current findings."));
    }
    if (!sameReasonSet(value.reasons, ["snapshot-missing"])) {
      issues.push(checkReportIssue("reasons", "Snapshot-missing drift requires exactly the snapshot-missing reason."));
    }
  } else if (isRecord(value.snapshot) && value.snapshot.valid === true) {
    const expectedReasons = derivedDriftReasons(value);
    if (!validComparedDrift(value)) {
      issues.push(checkReportIssue("comparison", "Drifted check reports must compare every digest, semantic finding, and provenance tool exactly."));
    }
    if (expectedReasons.length === 0 || !sameReasonSet(value.reasons, expectedReasons)) {
      issues.push(checkReportIssue("reasons", "Drifted check reasons must be derived exactly from digest, tool, and semantic mismatches."));
    }
  }
  requireEmptyArrays(value, ["issues", "missingTools"], "Drifted", issues);
}

function requireNullCurrentAndUncheckedComparison(value, statusLabel, issues) {
  if (value.current !== null) {
    issues.push(checkReportIssue("current", `${statusLabel} check reports must not include current provenance.`));
  }
  if (!uncheckedComparison(value.comparison)) {
    issues.push(checkReportIssue("comparison", `${statusLabel} check reports require every comparison to be not-checked.`));
  }
}

function requireEmptyArrays(value, keys, statusLabel, issues) {
  for (const key of keys) {
    if (!Array.isArray(value[key]) || value[key].length !== 0) {
      issues.push(checkReportIssue(key, `${statusLabel} check reports require ${key} to be empty.`));
    }
  }
}

function requireNonEmptyArray(value, key, message, issues) {
  if (!Array.isArray(value[key]) || value[key].length === 0) {
    issues.push(checkReportIssue(key, message));
  }
}

function uncheckedComparison(value) {
  return isRecord(value) &&
    value.commit === "not-checked" &&
    value.sourceDigest === "not-checked" &&
    value.modelDigest === "not-checked" &&
    value.semantic === "not-checked" &&
    Array.isArray(value.toolVersions) &&
    value.toolVersions.length === 0;
}

function freshComparison(value) {
  const comparison = value.comparison;
  return isRecord(comparison) &&
    provenanceComparisonsMatch(value) &&
    comparison.sourceDigest === "match" &&
    comparison.modelDigest === "match" &&
    comparison.semantic === "match" &&
    architectureToolComparisonsMatchProvenance(
      comparison.toolVersions,
      value.snapshot?.provenance,
      value.current
    ) &&
    comparison.toolVersions.every((entry) => entry.comparison === "match");
}

function snapshotIsAbsentOrValid(value) {
  return isRecord(value) && (
    (value.present === false && value.valid === false) ||
    (value.present === true && value.valid === true)
  );
}

function invalidStateSnapshotDescriptor(value) {
  return isRecord(value) && (
    (value.present === false && value.valid === false) ||
    (value.present === true && [false, true].includes(value.valid))
  );
}

function validComparedDrift(value) {
  const comparison = value.comparison;
  const findings = Array.isArray(value.findings) ? value.findings : [];
  return isRecord(comparison) &&
    provenanceComparisonsMatch(value) &&
    comparison.semantic === (findings.length > 0 ? "mismatch" : "match") &&
    architectureToolComparisonsMatchProvenance(
      comparison.toolVersions,
      value.snapshot?.provenance,
      value.current
    );
}

function provenanceComparisonsMatch(value) {
  const comparison = value.comparison;
  const snapshotProvenance = value.snapshot?.provenance;
  const currentProvenance = value.current;
  return isRecord(comparison) &&
    comparison.commit === expectedCommitComparison(snapshotProvenance, currentProvenance) &&
    comparison.sourceDigest === expectedDigestComparison(snapshotProvenance, currentProvenance, "sourceDigest") &&
    comparison.modelDigest === expectedDigestComparison(snapshotProvenance, currentProvenance, "modelDigest");
}

function expectedCommitComparison(snapshotProvenance, currentProvenance) {
  const snapshotCommit = snapshotProvenance?.commit;
  const currentCommit = currentProvenance?.commit;
  if (snapshotCommit?.verification !== "verified" || currentCommit?.verification !== "verified") {
    return "not-checked";
  }
  return snapshotCommit.sha === currentCommit.sha ? "match" : "mismatch";
}

function expectedDigestComparison(snapshotProvenance, currentProvenance, key) {
  return snapshotProvenance?.[key] === currentProvenance?.[key] ? "match" : "mismatch";
}

function missingSnapshotDrift(value) {
  const comparison = value.comparison;
  const findings = Array.isArray(value.findings) ? value.findings : [];
  return isRecord(comparison) &&
    comparison.commit === "not-checked" &&
    comparison.sourceDigest === "not-checked" &&
    comparison.modelDigest === "not-checked" &&
    comparison.semantic === (findings.length > 0 ? "mismatch" : "match") &&
    Array.isArray(comparison.toolVersions) &&
    comparison.toolVersions.length === 0;
}

function derivedDriftReasons(value) {
  const comparison = isRecord(value.comparison) ? value.comparison : {};
  return [
    ...(comparison.sourceDigest === "mismatch" ? ["source-digest-mismatch"] : []),
    ...(comparison.modelDigest === "mismatch" ? ["model-digest-mismatch"] : []),
    ...(Array.isArray(comparison.toolVersions) && comparison.toolVersions.some((entry) => entry?.comparison === "mismatch")
      ? ["tool-version-mismatch"]
      : []),
    ...(Array.isArray(value.findings) && value.findings.length > 0 ? ["semantic-findings"] : [])
  ];
}

function sameReasonSet(actual, expected) {
  if (!Array.isArray(actual) || actual.some((entry) => !nonEmptyArchitectureString(entry))) return false;
  const unique = [...new Set(actual)];
  return unique.length === actual.length &&
    unique.slice().sort(compareArchitectureText).join("\0") === expected.slice().sort(compareArchitectureText).join("\0");
}

function manifestAbsent(value) {
  return isRecord(value) && value.present === false && value.valid === false && value.digest === null;
}

function manifestConfigured(value) {
  return isRecord(value) && value.present === true && value.valid === true;
}

function compareValue(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return "not-checked";
  return left === right ? "match" : "mismatch";
}

function compareTools(leftInput, rightInput) {
  const left = Array.isArray(leftInput) ? leftInput : [];
  const right = Array.isArray(rightInput) ? rightInput : [];
  const keys = new Set([...left, ...right].map(toolSortKey));
  return [...keys].sort(compareArchitectureText).map((key) => {
    const before = left.find((entry) => toolSortKey(entry) === key);
    const after = right.find((entry) => toolSortKey(entry) === key);
    return {
      role: after?.role ?? before?.role ?? "unknown",
      declarationId: after?.declarationId ?? before?.declarationId ?? "unknown",
      adapter: after?.adapter ?? before?.adapter ?? "unknown",
      snapshotTool: before?.tool ?? null,
      currentTool: after?.tool ?? null,
      snapshotVersion: before?.version ?? null,
      currentVersion: after?.version ?? null,
      comparison: before && after && before.tool === after.tool && before.version === after.version ? "match" : "mismatch"
    };
  });
}

function toolSortKey(entry) {
  return `${entry?.role ?? ""}\0${entry?.declarationId ?? ""}\0${entry?.adapter ?? ""}`;
}

function baseState(status, comparison) {
  return { status, comparison, issues: [], missingTools: [], findings: [], reasons: [] };
}

function validCheckComparison(value) {
  const comparisonValues = ["match", "mismatch", "not-checked"];
  const keys = ["commit", "sourceDigest", "modelDigest", "toolVersions", "semantic"];
  return hasExactKeys(value, keys) &&
    comparisonValues.includes(value.commit) &&
    comparisonValues.includes(value.sourceDigest) &&
    comparisonValues.includes(value.modelDigest) &&
    comparisonValues.includes(value.semantic) &&
    Array.isArray(value.toolVersions) &&
    value.toolVersions.every(validArchitectureToolComparison);
}

function checkReportIssue(pathValue, message) {
  return { code: "architecture_check_report_invalid", path: pathValue, message };
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
