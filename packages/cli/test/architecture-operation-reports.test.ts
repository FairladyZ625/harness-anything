// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { validateArchitectureCheckReport } from "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-check-report.mjs";
import {
  validateArchitectureInitReport,
  validateArchitectureSnapshotReport
} from "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-operation-reports.mjs";

test("architecture init reports keep conflict and invalid evidence exclusive", () => {
  const conflict = {
    schema: "architecture-init-report/v1",
    status: "conflict",
    created: [],
    unchanged: [],
    conflicts: [{
      path: "harness/context/architecture/model/model.c4",
      reason: "content-differs",
      existingAliases: [],
      remediation: "Review the existing model."
    }],
    issues: [],
    nextActions: ["Resolve the conflict."]
  };
  assert.equal(validateArchitectureInitReport(conflict).ok, true);
  assert.equal(validateArchitectureInitReport({ ...conflict, status: "unchanged" }).ok, false);

  const invalid = {
    ...structuredClone(conflict),
    status: "invalid",
    issues: [architectureIssue()]
  };
  assert.equal(validateArchitectureInitReport(invalid).ok, false, "invalid init cannot retain conflict evidence");
  invalid.conflicts = [];
  assert.equal(validateArchitectureInitReport(invalid).ok, true);
});

test("architecture operation reports and init conflicts reject unknown keys", () => {
  const init = {
    schema: "architecture-init-report/v1",
    status: "conflict",
    created: [],
    unchanged: [],
    conflicts: [{
      path: "harness/context/architecture/model/model.c4",
      reason: "content-differs",
      existingAliases: [],
      remediation: "Review the existing model."
    }],
    issues: [],
    nextActions: ["Resolve the conflict."]
  };
  assert.equal(validateArchitectureInitReport({ ...init, unexpected: true }).ok, false);
  assert.equal(validateArchitectureInitReport({
    ...init,
    conflicts: [{ ...init.conflicts[0], unexpected: true }]
  }).ok, false);

  const snapshot = snapshotReportFixtures().fresh;
  const check = checkReportFixtures().fresh;
  assert.equal(validateArchitectureSnapshotReport({ ...snapshot, unexpected: true }).ok, false);
  assert.equal(validateArchitectureCheckReport({ ...check, unexpected: true }).ok, false);
});

test("architecture snapshot operation report states keep evidence exclusive", () => {
  const reports = snapshotReportFixtures();
  for (const report of Object.values(reports)) {
    assert.equal(validateArchitectureSnapshotReport(report).ok, true, `${report.status} fixture should be valid`);
  }

  assertSnapshotContradictionsRejected(reports["not-configured"], [
    (candidate) => { candidate.manifest.digest = architectureDigest("9"); },
    (candidate) => { candidate.snapshot = structuredClone(reports.fresh.snapshot); },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);
  assertSnapshotContradictionsRejected(reports.invalid, [
    (candidate) => { candidate.snapshot = structuredClone(reports.fresh.snapshot); },
    (candidate) => { candidate.issues = []; },
    (candidate) => { candidate.missingTools = [architectureMissingTool()]; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);
  assertSnapshotContradictionsRejected(reports["tool-missing"], [
    (candidate) => { candidate.manifest = structuredClone(reports["not-configured"].manifest); },
    (candidate) => { candidate.missingTools = []; },
    (candidate) => { candidate.issues = [architectureIssue()]; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);
  assertSnapshotContradictionsRejected(reports.fresh, [
    (candidate) => { candidate.manifest = structuredClone(reports["not-configured"].manifest); },
    (candidate) => { candidate.snapshot = null; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);
  assertSnapshotContradictionsRejected(reports.drifted, [
    (candidate) => { candidate.manifest = structuredClone(reports["not-configured"].manifest); },
    (candidate) => { candidate.snapshot = null; },
    (candidate) => { candidate.findings = []; }
  ]);
});

test("architecture check report states reject contradictory evidence", () => {
  const reports = checkReportFixtures();
  for (const report of Object.values(reports)) {
    assert.equal(validateArchitectureCheckReport(report).ok, true, `${report.status} fixture should be valid`);
  }

  assertContradictionsRejected(reports["not-configured"], [
    (candidate) => { candidate.manifest = structuredClone(reports.fresh.manifest); },
    (candidate) => { candidate.snapshot = structuredClone(reports.fresh.snapshot); },
    (candidate) => { candidate.current = structuredClone(reports.fresh.current); },
    (candidate) => { candidate.comparison.sourceDigest = "match"; },
    (candidate) => { candidate.reasons = ["unexpected-reason"]; },
    (candidate) => { candidate.issues = [architectureIssue()]; },
    (candidate) => { candidate.missingTools = [architectureMissingTool()]; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);

  assertContradictionsRejected(reports.invalid, [
    (candidate) => { candidate.current = structuredClone(reports.fresh.current); },
    (candidate) => { candidate.comparison.semantic = "match"; },
    (candidate) => { candidate.reasons = ["unexpected-reason"]; },
    (candidate) => { candidate.issues = []; },
    (candidate) => { candidate.missingTools = [architectureMissingTool()]; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);
  const invalidAfterValidatedSnapshot = {
    ...structuredClone(reports.invalid),
    snapshot: structuredClone(reports.fresh.snapshot)
  };
  assert.equal(
    validateArchitectureCheckReport(invalidAfterValidatedSnapshot).ok,
    true,
    "an adapter failure must not erase facts from an already validated snapshot descriptor"
  );

  assertContradictionsRejected(reports["tool-missing"], [
    (candidate) => { candidate.snapshot = structuredClone(reports.invalid.snapshot); },
    (candidate) => { candidate.current = structuredClone(reports.fresh.current); },
    (candidate) => { candidate.comparison.modelDigest = "match"; },
    (candidate) => { candidate.reasons = ["unexpected-reason"]; },
    (candidate) => { candidate.issues = [architectureIssue()]; },
    (candidate) => { candidate.missingTools = []; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);

  assertContradictionsRejected(reports.fresh, [
    (candidate) => { candidate.snapshot = structuredClone(reports["not-configured"].snapshot); },
    (candidate) => { candidate.current = null; },
    (candidate) => { candidate.comparison.sourceDigest = "mismatch"; },
    (candidate) => { candidate.comparison.modelDigest = "not-checked"; },
    (candidate) => { candidate.comparison.semantic = "mismatch"; },
    (candidate) => { candidate.comparison.toolVersions[0].comparison = "mismatch"; },
    (candidate) => { candidate.reasons = ["unexpected-reason"]; },
    (candidate) => { candidate.issues = [architectureIssue()]; },
    (candidate) => { candidate.missingTools = [architectureMissingTool()]; },
    (candidate) => { candidate.findings = [architectureDriftFinding()]; }
  ]);

  assertContradictionsRejected(reports.drifted, [
    (candidate) => { candidate.snapshot = structuredClone(reports.invalid.snapshot); },
    (candidate) => { candidate.current = null; },
    (candidate) => { candidate.reasons = []; },
    (candidate) => { candidate.issues = [architectureIssue()]; },
    (candidate) => { candidate.missingTools = [architectureMissingTool()]; }
  ]);
});

test("architecture check reports reject stale descriptors, incomplete tool coverage, and invented drift reasons", () => {
  const reports = checkReportFixtures();
  const absentSnapshotDrift = {
    ...structuredClone(reports.drifted),
    snapshot: {
      path: reports.fresh.snapshot.path,
      present: false,
      valid: false,
      digest: null,
      provenance: null
    },
    comparison: {
      commit: "not-checked",
      sourceDigest: "not-checked",
      modelDigest: "not-checked",
      semantic: "mismatch",
      toolVersions: []
    },
    reasons: ["snapshot-missing"]
  };
  assert.equal(validateArchitectureCheckReport(absentSnapshotDrift).ok, true);

  for (const candidate of [
    mutateReport(reports.fresh, (report) => { report.manifest = structuredClone(reports["not-configured"].manifest); }),
    mutateReport(reports["not-configured"], (report) => { report.manifest.digest = architectureDigest("9"); }),
    mutateReport(reports["not-configured"], (report) => { report.snapshot.path = reports.fresh.snapshot.path; }),
    mutateReport(reports["tool-missing"], (report) => {
      report.snapshot.digest = architectureDigest("9");
      report.snapshot.provenance = structuredClone(reports.fresh.current);
    }),
    mutateReport(reports.fresh, (report) => { report.comparison.toolVersions = []; }),
    mutateReport(reports.drifted, (report) => { report.reasons = ["invented-drift-reason"]; }),
    mutateReport(absentSnapshotDrift, (report) => { report.reasons = ["source-digest-mismatch"]; })
  ]) {
    assert.equal(validateArchitectureCheckReport(candidate).ok, false, "review reproduction must fail closed");
  }
});

test("architecture check commit comparisons are derived exactly from provenance", () => {
  for (const original of [checkReportFixtures().fresh, checkReportFixtures().drifted]) {
    const verifiedMatch = structuredClone(original);
    verifiedMatch.snapshot.provenance.commit = { sha: "a".repeat(40), verification: "verified" };
    verifiedMatch.current.commit = { sha: "a".repeat(40), verification: "verified" };
    verifiedMatch.comparison.commit = "match";
    assert.equal(validateArchitectureCheckReport(verifiedMatch).ok, true);
    assert.equal(validateArchitectureCheckReport(mutateReport(verifiedMatch, (report) => {
      report.comparison.commit = "mismatch";
    })).ok, false, "equal verified commits cannot be reported as a mismatch");

    const verifiedMismatch = structuredClone(verifiedMatch);
    verifiedMismatch.snapshot.provenance = structuredClone(verifiedMatch.snapshot.provenance);
    verifiedMismatch.current = structuredClone(verifiedMatch.current);
    verifiedMismatch.current.commit.sha = "b".repeat(40);
    verifiedMismatch.comparison.commit = "mismatch";
    assert.equal(validateArchitectureCheckReport(verifiedMismatch).ok, true);
    assert.equal(validateArchitectureCheckReport(mutateReport(verifiedMismatch, (report) => {
      report.comparison.commit = "match";
    })).ok, false, "different verified commits cannot be reported as a match");

    const unverified = structuredClone(original);
    unverified.comparison.commit = "not-checked";
    assert.equal(validateArchitectureCheckReport(unverified).ok, true);
    assert.equal(validateArchitectureCheckReport(mutateReport(unverified, (report) => {
      report.comparison.commit = "mismatch";
    })).ok, false, "an unverified commit cannot produce a match or mismatch claim");
  }
});

test("architecture check digest comparisons are derived exactly from provenance", () => {
  const reports = checkReportFixtures();
  assert.equal(validateArchitectureCheckReport(mutateReport(reports.fresh, (report) => {
    report.current.sourceDigest = architectureDigest("9");
  })).ok, false, "fresh cannot claim matching source digests that differ in provenance");

  assert.equal(validateArchitectureCheckReport(mutateReport(reports.drifted, (report) => {
    report.current.sourceDigest = report.snapshot.provenance.sourceDigest;
  })).ok, false, "drifted cannot claim a source mismatch when provenance matches");

  const accurateModelMismatch = mutateReport(reports.drifted, (report) => {
    report.current.modelDigest = architectureDigest("8");
    report.comparison.modelDigest = "mismatch";
    report.reasons.push("model-digest-mismatch");
  });
  assert.equal(validateArchitectureCheckReport(accurateModelMismatch).ok, true);
  assert.equal(validateArchitectureCheckReport(mutateReport(accurateModelMismatch, (report) => {
    report.current.modelDigest = report.snapshot.provenance.modelDigest;
  })).ok, false, "drifted cannot claim a model mismatch when provenance matches");
});

test("architecture report collection items use frozen consumer shapes", () => {
  const checkReports = checkReportFixtures();
  const snapshotReports = snapshotReportFixtures();
  const findingWithUnknownField = { ...architectureDriftFinding(), unexpected: true };
  const findingWithoutEvidenceAnchor = {
    ...architectureDriftFinding(),
    relationshipId: null,
    sourceNodeId: null,
    targetNodeId: null,
    evidence: []
  };
  const malformedEvidence = {
    ...architectureDriftFinding(),
    evidence: [{ sourcePath: null, targetPath: null, line: null }]
  };

  for (const finding of [findingWithUnknownField, findingWithoutEvidenceAnchor, malformedEvidence]) {
    assert.equal(validateArchitectureCheckReport(mutateReport(checkReports.drifted, (report) => {
      report.findings = [finding];
    })).ok, false);
    assert.equal(validateArchitectureSnapshotReport(mutateReport(snapshotReports.drifted, (report) => {
      report.findings = [finding];
    })).ok, false);
  }

  const duplicateFindings = [architectureDriftFinding(), architectureDriftFinding()];
  assert.equal(validateArchitectureCheckReport(mutateReport(checkReports.drifted, (report) => {
    report.findings = duplicateFindings;
  })).ok, false, "check reports require globally unique finding IDs");
  assert.equal(validateArchitectureSnapshotReport(mutateReport(snapshotReports.drifted, (report) => {
    report.findings = duplicateFindings;
  })).ok, false, "snapshot reports require globally unique finding IDs");

  const duplicateMissingTools = [architectureMissingTool(), architectureMissingTool()];
  assert.equal(validateArchitectureCheckReport(mutateReport(checkReports["tool-missing"], (report) => {
    report.missingTools = duplicateMissingTools;
  })).ok, false, "check reports require unique missing-tool identities");
  assert.equal(validateArchitectureSnapshotReport(mutateReport(snapshotReports["tool-missing"], (report) => {
    report.missingTools = duplicateMissingTools;
  })).ok, false, "snapshot reports require unique missing-tool identities");

  for (const candidate of [
    mutateReport(checkReports.invalid, (report) => { report.issues = [{ ...architectureIssue(), extra: true }]; }),
    mutateReport(checkReports["tool-missing"], (report) => { report.missingTools = [{ ...architectureMissingTool(), version: "1.0.0" }]; }),
    mutateReport(checkReports.fresh, (report) => { report.warnings = [{ code: "structured-warning" }]; }),
    mutateReport(checkReports.fresh, (report) => { report.nextActions = [""]; })
  ]) {
    assert.equal(validateArchitectureCheckReport(candidate).ok, false);
  }
});

function checkReportFixtures(): Record<string, Record<string, any>> {
  const provenance = architectureProvenance();
  const manifest = {
    path: "harness/context/architecture/architecture-manifest.json",
    present: true,
    valid: true,
    digest: architectureDigest("1")
  };
  const snapshot = {
    path: "harness/tasks/task_REPORT/artifacts/architecture/architecture-snapshot.json",
    present: true,
    valid: true,
    digest: architectureDigest("4"),
    provenance: structuredClone(provenance)
  };
  const compared = {
    commit: "not-checked",
    sourceDigest: "match",
    modelDigest: "match",
    semantic: "match",
    toolVersions: [{
      role: "provider",
      declarationId: "likec4",
      adapter: "likec4/model-v1",
      snapshotTool: "likec4",
      currentTool: "likec4",
      snapshotVersion: "1.0.0",
      currentVersion: "1.0.0",
      comparison: "match"
    }]
  };
  const unchecked = {
    commit: "not-checked",
    sourceDigest: "not-checked",
    modelDigest: "not-checked",
    semantic: "not-checked",
    toolVersions: []
  };
  const common = {
    schema: "architecture-check-report/v1",
    manifest,
    snapshot,
    current: structuredClone(provenance),
    comparison: compared,
    reasons: [],
    issues: [],
    missingTools: [],
    findings: [],
    warnings: ["warning remains allowed"],
    nextActions: ["Next actions remain allowed."]
  };
  return {
    "not-configured": {
      ...structuredClone(common),
      status: "not-configured",
      manifest: { ...manifest, present: false, valid: false, digest: null },
      snapshot: { path: null, present: false, valid: false, digest: null, provenance: null },
      current: null,
      comparison: structuredClone(unchecked)
    },
    invalid: {
      ...structuredClone(common),
      status: "invalid",
      snapshot: { ...snapshot, valid: false, digest: null, provenance: null },
      current: null,
      comparison: structuredClone(unchecked),
      issues: [architectureIssue()]
    },
    "tool-missing": {
      ...structuredClone(common),
      status: "tool-missing",
      snapshot: { path: snapshot.path, present: false, valid: false, digest: null, provenance: null },
      current: null,
      comparison: structuredClone(unchecked),
      missingTools: [architectureMissingTool()]
    },
    fresh: {
      ...structuredClone(common),
      status: "fresh"
    },
    drifted: {
      ...structuredClone(common),
      status: "drifted",
      current: { ...structuredClone(provenance), sourceDigest: architectureDigest("9") },
      comparison: { ...structuredClone(compared), sourceDigest: "mismatch", semantic: "mismatch" },
      reasons: ["source-digest-mismatch", "semantic-findings"],
      findings: [architectureDriftFinding()]
    }
  };
}

function snapshotReportFixtures(): Record<string, Record<string, any>> {
  const checkReports = checkReportFixtures();
  const common = {
    schema: "architecture-snapshot-report/v1",
    manifest: structuredClone(checkReports.fresh.manifest),
    snapshot: {
      path: checkReports.fresh.snapshot.path,
      digest: architectureDigest("4"),
      provenance: structuredClone(checkReports.fresh.current)
    },
    missingTools: [],
    issues: [],
    findings: [],
    warnings: ["Architecture adapter warning."],
    nextActions: ["Review the architecture report."]
  };
  return {
    "not-configured": {
      ...structuredClone(common),
      status: "not-configured",
      manifest: structuredClone(checkReports["not-configured"].manifest),
      snapshot: null
    },
    invalid: {
      ...structuredClone(common),
      status: "invalid",
      snapshot: null,
      issues: [architectureIssue()]
    },
    "tool-missing": {
      ...structuredClone(common),
      status: "tool-missing",
      snapshot: null,
      missingTools: [architectureMissingTool()]
    },
    fresh: {
      ...structuredClone(common),
      status: "fresh"
    },
    drifted: {
      ...structuredClone(common),
      status: "drifted",
      findings: [architectureDriftFinding()]
    }
  };
}

function architectureProvenance(): Record<string, any> {
  return {
    commit: { sha: null, verification: "unverified" },
    sourceDigest: architectureDigest("2"),
    modelDigest: architectureDigest("3"),
    tools: [{
      role: "provider",
      declarationId: "likec4",
      adapter: "likec4/model-v1",
      tool: "likec4",
      version: "1.0.0"
    }]
  };
}

function architectureIssue(): Record<string, unknown> {
  return {
    code: "architecture_snapshot_invalid",
    path: "snapshot",
    message: "The architecture snapshot is invalid."
  };
}

function architectureMissingTool(): Record<string, unknown> {
  return {
    role: "provider",
    declarationId: "likec4",
    adapter: "likec4/model-v1",
    tool: "likec4",
    version: null,
    reason: "provider-not-installed",
    hint: "Install LikeC4 explicitly."
  };
}

function architectureDriftFinding(): Record<string, unknown> {
  return {
    schema: "architecture-drift-finding/v1",
    id: "finding.import-drift",
    kind: "relationship-drift",
    severity: "warning",
    extractorId: "js-ts-imports",
    relationshipId: "rel.runtime-dependency",
    sourceNodeId: "web.app",
    targetNodeId: "api.service",
    toolRef: "extractor:js-ts-imports",
    evidence: [{ sourcePath: "src/web.ts", targetPath: "src/api.ts", line: 42 }],
    message: "The observed import is not represented by the authored relationship."
  };
}

function architectureDigest(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function assertContradictionsRejected(
  report: Record<string, any>,
  mutations: ReadonlyArray<(candidate: Record<string, any>) => void>
): void {
  for (const mutate of mutations) {
    const candidate = structuredClone(report);
    mutate(candidate);
    assert.equal(validateArchitectureCheckReport(candidate).ok, false, `${report.status} accepted contradictory evidence`);
  }
}

function assertSnapshotContradictionsRejected(
  report: Record<string, any>,
  mutations: ReadonlyArray<(candidate: Record<string, any>) => void>
): void {
  for (const mutate of mutations) {
    const candidate = mutateReport(report, mutate);
    assert.equal(validateArchitectureSnapshotReport(candidate).ok, false, `${report.status} accepted contradictory evidence`);
  }
}

function mutateReport(
  report: Record<string, any>,
  mutate: (candidate: Record<string, any>) => void
): Record<string, any> {
  const candidate = structuredClone(report);
  mutate(candidate);
  return candidate;
}
