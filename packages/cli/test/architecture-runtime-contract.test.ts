// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";

test("architecture check state contract freezes five deterministic states", async () => {
  const {
    architectureSourceDigest,
    architectureSnapshotDigest,
    architectureSnapshotJson,
    buildArchitectureSnapshot,
    combineArchitectureObservations,
    validateArchitectureSnapshot
  } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-runtime.mjs"
  );
  const {
    buildArchitectureCheckReport,
    evaluateArchitectureCheckState,
    validateArchitectureCheckReport
  } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-check-report.mjs"
  );
  const { registeredArchitectureAdapterIds } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-adapters.mjs"
  );
  const { isArchitectureStableId, isPortablePhysicalPath } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-manifest.mjs"
  );
  const provenance = {
    sourceDigest: "sha256:source",
    modelDigest: "sha256:model",
    tools: [
      { role: "provider", declarationId: "likec4", adapter: "likec4/model-v1", tool: "likec4", version: "1.58.0" },
      { role: "extractor", declarationId: "js-ts-imports", adapter: "javascript-typescript/imports-v1", tool: "dependency-cruiser", version: "1.0.0" }
    ]
  };

  assert.equal(evaluateArchitectureCheckState({ configured: false }).status, "not-configured");
  assert.equal(evaluateArchitectureCheckState({
    configured: true,
    configurationIssues: [{ code: "placeholder", path: "model.c4", message: "placeholder remains" }]
  }).status, "invalid");
  assert.equal(evaluateArchitectureCheckState({
    configured: true,
    missingTools: [{ adapter: "javascript-typescript/imports-v1", reason: "not-installed" }]
  }).status, "tool-missing");
  assert.equal(evaluateArchitectureCheckState({
    configured: true,
    snapshot: { provenance },
    current: { provenance: { ...provenance, sourceDigest: "sha256:changed" }, findings: [] }
  }).status, "drifted");
  assert.equal(evaluateArchitectureCheckState({
    configured: true,
    snapshot: { provenance },
    current: { provenance, findings: [] }
  }).status, "fresh");

  assert.deepEqual(registeredArchitectureAdapterIds(), [
    "extractor:javascript-typescript/imports-v1",
    "provider:likec4"
  ]);
  const snapshotInput = {
    manifest: {
      path: "harness/context/architecture/architecture-manifest.json",
      digest: `sha256:${"1".repeat(64)}`
    },
    provenance: {
      commit: { sha: "2".repeat(40), verification: "verified" },
      sourceDigest: `sha256:${"3".repeat(64)}`,
      modelDigest: `sha256:${"4".repeat(64)}`,
      tools: provenance.tools
    },
    extractors: [{
      id: "js-ts-imports",
      adapter: "javascript-typescript/imports-v1",
      sourceScopeIds: ["unicode-scope", "z-scope", "a-scope"],
      inputDigest: `sha256:${"5".repeat(64)}`,
      toolRef: "extractor:js-ts-imports"
    }],
    mappings: [
      { extractorId: "js-ts-imports", path: "z.ts", sourceScopeId: "z-scope", nodeId: "component.z" },
      { extractorId: "js-ts-imports", path: "a.ts", sourceScopeId: "a-scope", nodeId: "component.a" },
      { extractorId: "js-ts-imports", path: "ä.ts", sourceScopeId: "unicode-scope", nodeId: "component.a-umlaut" }
    ],
    nodeEdges: [{
      extractorId: "js-ts-imports",
      kind: "dependency",
      sourceNodeId: "component.a",
      targetNodeId: "component.z",
      evidence: [
        { mechanism: "import", sourcePath: "a.ts", targetPath: "z.ts", specifier: "@app/z" },
        { mechanism: "import", sourcePath: "a.ts", targetPath: "z.ts", specifier: "./z.js" }
      ]
    }],
    unmapped: [{
      extractorId: "js-ts-imports",
      path: "missing.ts",
      role: "target",
      reason: "no-architecture-node",
      evidence: [{ mechanism: "import", sourcePath: "a.ts", targetPath: "missing.ts", specifier: "./missing.js" }]
    }],
    stats: { sourceFiles: 4, mappedFiles: 3, nodeEdges: 1, evidenceEdges: 2, unmappedPaths: 1 }
  };
  snapshotInput.provenance.sourceDigest = architectureSourceDigest(snapshotInput.extractors);
  const firstSnapshot = buildArchitectureSnapshot(snapshotInput);
  const reorderedSnapshot = buildArchitectureSnapshot({
    ...snapshotInput,
    mappings: [...snapshotInput.mappings].reverse(),
    nodeEdges: snapshotInput.nodeEdges.map((edge) => ({ ...edge, evidence: [...edge.evidence].reverse() }))
  });
  assert.equal(architectureSnapshotJson(firstSnapshot), architectureSnapshotJson(reorderedSnapshot));
  assert.deepEqual(firstSnapshot.mappings.map((mapping: Record<string, unknown>) => mapping.path), ["a.ts", "z.ts", "ä.ts"]);
  assert.equal(firstSnapshot.provenance.commit.sha, "2".repeat(40));
  assert.equal(Object.hasOwn(firstSnapshot, "generatedAt"), false, "reproducible snapshots omit wall-clock timestamps");
  assert.match(architectureSnapshotDigest(firstSnapshot), /^sha256:[0-9a-f]{64}$/u);
  assert.equal(validateArchitectureSnapshot(firstSnapshot).ok, true);
  const unboundSourceDigest = structuredClone(firstSnapshot);
  unboundSourceDigest.provenance.sourceDigest = `sha256:${"f".repeat(64)}`;
  assert.equal(
    validateArchitectureSnapshot(unboundSourceDigest).issues.some(
      (issue: Record<string, unknown>) => issue.code === "architecture_snapshot_source_digest_mismatch"
    ),
    true,
    "snapshot source provenance is the canonical aggregate of its extractor input digests"
  );
  const emptySourceScopes = structuredClone(firstSnapshot);
  emptySourceScopes.extractors[0].sourceScopeIds = [];
  emptySourceScopes.mappings = [];
  emptySourceScopes.nodeEdges = [];
  emptySourceScopes.unmapped = [];
  emptySourceScopes.stats = { sourceFiles: 0, mappedFiles: 0, nodeEdges: 0, evidenceEdges: 0, unmappedPaths: 0 };
  assert.equal(validateArchitectureSnapshot(emptySourceScopes).ok, false, "extractors must declare at least one source scope");
  const timestampedSnapshot = structuredClone(firstSnapshot);
  timestampedSnapshot.generatedAt = "2026-07-13T00:00:00.000Z";
  assert.notEqual(architectureSnapshotDigest(timestampedSnapshot), architectureSnapshotDigest(firstSnapshot));
  const timestampedValidation = validateArchitectureSnapshot(timestampedSnapshot);
  assert.equal(timestampedValidation.ok, false, "digest-changing extra fields must be rejected");
  assert.equal(timestampedValidation.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_snapshot_extra_field"), true);
  for (const mutate of [
    (candidate: Record<string, any>) => { candidate.manifest.extra = true; },
    (candidate: Record<string, any>) => { candidate.provenance.extra = true; },
    (candidate: Record<string, any>) => { candidate.provenance.commit.extra = true; },
    (candidate: Record<string, any>) => { candidate.provenance.tools[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.extractors[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.mappings[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].evidence[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.unmapped[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.unmapped[0].evidence[0].extra = true; },
    (candidate: Record<string, any>) => { candidate.stats.extra = true; }
  ]) {
    const candidate = structuredClone(firstSnapshot);
    mutate(candidate);
    const validation = validateArchitectureSnapshot(candidate);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_snapshot_extra_field"), true);
  }
  assert.equal(isArchitectureStableId("component.a"), true);
  assert.equal(isArchitectureStableId("Component A"), false);
  assert.equal(isPortablePhysicalPath("packages/app.ts"), true);
  assert.equal(isPortablePhysicalPath("packages/NUL.ts"), false);
  const escapedSnapshot = structuredClone(firstSnapshot);
  escapedSnapshot.mappings[0].path = "/tmp/escaped.ts";
  assert.equal(validateArchitectureSnapshot(escapedSnapshot).ok, false);
  const evidenceAliasSnapshot = structuredClone(firstSnapshot);
  evidenceAliasSnapshot.nodeEdges[0].evidence[0].sourcePath = "A.ts";
  assert.equal(
    validateArchitectureSnapshot(evidenceAliasSnapshot).issues.some((issue: Record<string, unknown>) => issue.code === "architecture_snapshot_path_collision"),
    true,
    "edge evidence participates in portable physical path collision detection"
  );
  const unmappedAliasSnapshot = structuredClone(firstSnapshot);
  unmappedAliasSnapshot.unmapped[0].evidence[0].targetPath = "Missing.ts";
  assert.equal(
    validateArchitectureSnapshot(unmappedAliasSnapshot).issues.some((issue: Record<string, unknown>) => issue.code === "architecture_snapshot_path_collision"),
    true,
    "unmapped evidence participates in portable physical path collision detection"
  );

  for (const mutate of [
    (candidate: Record<string, any>) => { candidate.provenance.tools = []; },
    (candidate: Record<string, any>) => { candidate.extractors[0].toolRef = "extractor:missing"; },
    (candidate: Record<string, any>) => { candidate.mappings[0].sourceScopeId = "missing-scope"; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].sourceNodeId = "component.missing"; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].evidence[0].sourcePath = "missing.ts"; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].evidence[0].sourcePath = "z.ts"; candidate.nodeEdges[0].evidence[0].targetPath = "a.ts"; },
    (candidate: Record<string, any>) => { candidate.unmapped[0].evidence[0].targetPath = "other-missing.ts"; },
    (candidate: Record<string, any>) => { candidate.stats.mappedFiles -= 1; },
    (candidate: Record<string, any>) => { candidate.unmapped.push(structuredClone(candidate.unmapped[0])); },
    (candidate: Record<string, any>) => { candidate.manifest.path = "harness/NUL.json"; },
    (candidate: Record<string, any>) => { candidate.provenance.tools[1].declarationId = "Extractor Invalid"; },
    (candidate: Record<string, any>) => { candidate.extractors[0].id = "Extractor Invalid"; },
    (candidate: Record<string, any>) => { candidate.extractors[0].sourceScopeIds[0] = "Scope Invalid"; },
    (candidate: Record<string, any>) => { candidate.mappings[0].path = "packages/NUL.ts"; },
    (candidate: Record<string, any>) => { candidate.mappings[0].nodeId = "Component Invalid"; },
    (candidate: Record<string, any>) => { candidate.nodeEdges[0].targetNodeId = "Component Invalid"; },
    (candidate: Record<string, any>) => { candidate.unmapped[0].path = "packages/NUL.ts"; }
  ]) {
    const candidate = structuredClone(firstSnapshot);
    mutate(candidate);
    assert.equal(validateArchitectureSnapshot(candidate).ok, false);
  }

  const changedTool = structuredClone(provenance);
  changedTool.tools[1].tool = "different-engine";
  const changedToolState = evaluateArchitectureCheckState({
    configured: true,
    snapshot: { provenance },
    current: { provenance: changedTool, findings: [] }
  });
  assert.equal(changedToolState.status, "drifted");
  assert.equal(changedToolState.comparison.toolVersions.find((entry: Record<string, unknown>) => entry.declarationId === "js-ts-imports")?.comparison, "mismatch");

  const observation = {
    extractor: snapshotInput.extractors[0],
    tool: provenance.tools[1],
    mappings: [],
    nodeEdges: [],
    unmapped: [],
    stats: { sourceFiles: 0, mappedFiles: 0 }
  };
  const comparison = {
    findings: [architectureFinding("finding.z"), architectureFinding("finding.a")],
    warnings: ["warning.z", "warning.a"]
  };
  const combined = combineArchitectureObservations([observation], [provenance.tools[0]], [comparison]);
  assert.deepEqual(combined.findings.map((finding: Record<string, unknown>) => finding.id), ["finding.a", "finding.z"]);
  assert.deepEqual(combined.warnings, ["warning.a", "warning.z"]);

  const matchingToolVersions = firstSnapshot.provenance.tools.map((tool: Record<string, string>) => ({
    role: tool.role,
    declarationId: tool.declarationId,
    adapter: tool.adapter,
    snapshotTool: tool.tool,
    currentTool: tool.tool,
    snapshotVersion: tool.version,
    currentVersion: tool.version,
    comparison: "match"
  }));

  const report = buildArchitectureCheckReport({
    status: "drifted",
    manifest: { path: snapshotInput.manifest.path, present: true, valid: true, digest: snapshotInput.manifest.digest },
    snapshot: {
      path: "harness/tasks/task_CONTRACT/artifacts/architecture/architecture-snapshot.json",
      present: true,
      valid: true,
      digest: architectureSnapshotDigest(firstSnapshot),
      provenance: firstSnapshot.provenance
    },
    current: { ...firstSnapshot.provenance, sourceDigest: `sha256:${"7".repeat(64)}` },
    comparison: {
      commit: "match",
      sourceDigest: "mismatch",
      modelDigest: "match",
      toolVersions: matchingToolVersions,
      semantic: "match"
    },
    reasons: ["source-digest-mismatch"],
    issues: [],
    missingTools: [],
    findings: [],
    warnings: [],
    nextActions: ["Review the source digest mismatch."]
  });
  assert.deepEqual(report.reasons, ["source-digest-mismatch"]);
  assert.equal(validateArchitectureCheckReport(report).ok, true);
  assert.equal(validateArchitectureCheckReport({ ...report, reasons: "source-digest-mismatch" }).ok, false);

  const freshReport = structuredClone(report);
  freshReport.status = "fresh";
  freshReport.current.sourceDigest = freshReport.snapshot.provenance.sourceDigest;
  freshReport.current.commit = { sha: "6".repeat(40), verification: "verified" };
  freshReport.comparison = {
    commit: "mismatch",
    sourceDigest: "match",
    modelDigest: "match",
    toolVersions: matchingToolVersions,
    semantic: "match"
  };
  freshReport.reasons = [];
  freshReport.findings = [];
  assert.equal(validateArchitectureCheckReport(freshReport).ok, true, "commit provenance does not drive freshness");
  for (const mutate of [
    (candidate: Record<string, any>) => { candidate.comparison.sourceDigest = "mismatch"; },
    (candidate: Record<string, any>) => { candidate.comparison.modelDigest = "not-checked"; },
    (candidate: Record<string, any>) => { candidate.comparison.semantic = "mismatch"; },
    (candidate: Record<string, any>) => { candidate.comparison.toolVersions = [{
      role: "provider",
      declarationId: "likec4",
      adapter: "likec4/model-v1",
      snapshotTool: "likec4",
      currentTool: "likec4",
      snapshotVersion: "1.58.0",
      currentVersion: "1.59.0",
      comparison: "mismatch"
    }]; },
    (candidate: Record<string, any>) => { candidate.reasons = ["contradictory-fresh-reason"]; },
    (candidate: Record<string, any>) => { candidate.findings = [{ id: "finding.contradiction" }]; }
  ]) {
    const candidate = structuredClone(freshReport);
    mutate(candidate);
    assert.equal(validateArchitectureCheckReport(candidate).ok, false, "fresh reports reject contradictory evidence");
  }
});
test("combined snapshot stats count mapped physical paths globally across extractors", async () => {
  const {
    architectureSourceDigest,
    architectureSnapshotJson,
    buildArchitectureSnapshot,
    combineArchitectureObservations,
    validateArchitectureSnapshot
  } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-runtime.mjs"
  );
  const providerTool = {
    role: "provider",
    declarationId: "likec4",
    adapter: "likec4/model-v1",
    tool: "likec4",
    version: "1.58.0"
  };
  const observations = ["alpha-imports", "beta-imports"].map((id, index) => ({
    extractor: {
      id,
      adapter: `javascript-typescript/${id}-v1`,
      sourceScopeIds: ["shared-scope"],
      inputDigest: `sha256:${String(index + 6).repeat(64)}`,
      toolRef: `extractor:${id}`
    },
    tool: {
      role: "extractor",
      declarationId: id,
      adapter: `javascript-typescript/${id}-v1`,
      tool: id,
      version: "1.0.0"
    },
    mappings: [{
      extractorId: id,
      path: "packages/shared.ts",
      sourceScopeId: "shared-scope",
      nodeId: "component.shared"
    }],
    nodeEdges: [],
    unmapped: [],
    findings: [],
    warnings: [],
    stats: { sourceFiles: 1, mappedFiles: 1 }
  }));

  const combined = combineArchitectureObservations(observations, [providerTool]);
  const reversed = combineArchitectureObservations([...observations].reverse(), [providerTool]);
  const aliasedObservations = structuredClone(observations);
  aliasedObservations[1].mappings[0].path = "packages/Shared.ts";
  assert.equal(combined.stats.sourceFiles, 2);
  assert.equal(combined.sourceDigest, architectureSourceDigest(combined.extractors));
  assert.equal(combined.sourceDigest, reversed.sourceDigest, "extractor declaration order cannot change source provenance");
  assert.equal(combined.stats.mappedFiles, 1, "overlapping extractor mappings represent one physical file");
  assert.equal(combineArchitectureObservations(aliasedObservations, [providerTool]).stats.mappedFiles, 1, "portable aliases represent one physical file");

  const snapshotInput = {
    manifest: {
      path: "harness/context/architecture/architecture-manifest.json",
      digest: `sha256:${"1".repeat(64)}`
    },
    provenance: {
      commit: { sha: null, verification: "unverified" },
      sourceDigest: combined.sourceDigest,
      modelDigest: `sha256:${"4".repeat(64)}`,
      tools: combined.tools
    },
    extractors: combined.extractors,
    mappings: combined.mappings,
    nodeEdges: combined.nodeEdges,
    unmapped: combined.unmapped,
    stats: combined.stats
  };
  const snapshot = buildArchitectureSnapshot(snapshotInput);
  const reversedSnapshot = buildArchitectureSnapshot({
    ...snapshotInput,
    provenance: {
      ...snapshotInput.provenance,
      sourceDigest: reversed.sourceDigest,
      tools: reversed.tools
    },
    extractors: reversed.extractors,
    mappings: reversed.mappings,
    nodeEdges: reversed.nodeEdges,
    unmapped: reversed.unmapped,
    stats: reversed.stats
  });
  assert.equal(validateArchitectureSnapshot(snapshot).ok, true);
  assert.equal(architectureSnapshotJson(snapshot), architectureSnapshotJson(reversedSnapshot));
  const aliasedSnapshot = structuredClone(snapshot);
  aliasedSnapshot.mappings[1].path = "packages/Shared.ts";
  const aliasedValidation = validateArchitectureSnapshot(aliasedSnapshot);
  assert.equal(aliasedValidation.ok, false);
  assert.equal(
    aliasedValidation.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_snapshot_path_collision"),
    true,
    "distinct path spellings that collide portably are rejected"
  );
});

function architectureFinding(id: string) {
  return {
    schema: "architecture-drift-finding/v1",
    id,
    kind: "dependency-drift",
    severity: "warning",
    extractorId: "js-ts-imports",
    relationshipId: "relation.a-z",
    sourceNodeId: "component.a",
    targetNodeId: "component.z",
    toolRef: "extractor:js-ts-imports",
    evidence: [{ sourcePath: "a.ts", targetPath: "z.ts", line: 1 }],
    message: `Architecture drift ${id}.`
  };
}
