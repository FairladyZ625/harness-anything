// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";

const contractsPath = "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-adapter-contracts.mjs";
const adaptersPath = "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-adapters.mjs";

test("provider observations expose closed, stable model intent", async () => {
  const { validateArchitectureProviderObservation } = await import(contractsPath);
  const observation = providerObservation();

  assert.equal(validateArchitectureProviderObservation(observation).ok, true);
  assert.equal(validateArchitectureProviderObservation({ ...observation, generatedAt: "unstable" }).ok, false);
  assert.equal(validateArchitectureProviderObservation({
    ...observation,
    nodes: ["component.api", "Component Invalid"]
  }).ok, false);
  assert.equal(validateArchitectureProviderObservation({
    ...observation,
    relationships: [{
      ...observation.relationships[0],
      targetNodeId: "component.missing"
    }]
  }).ok, false);
});

test("code observations reuse the closed snapshot graph shape without comparison findings", async () => {
  const { validateArchitectureCodeObservation } = await import(contractsPath);
  const observation = codeObservation();

  assert.equal(validateArchitectureCodeObservation(observation).ok, true);
  assert.equal(validateArchitectureCodeObservation({
    ...observation,
    findings: [driftFinding()]
  }).ok, false, "extractors cannot smuggle semantic comparison into code observations");
  assert.equal(validateArchitectureCodeObservation({
    ...observation,
    mappings: [{ ...observation.mappings[0], generatedAt: "unstable" }, observation.mappings[1]]
  }).ok, false, "snapshot graph records remain closed");
  assert.equal(validateArchitectureCodeObservation({
    ...observation,
    nodeEdges: [{
      ...observation.nodeEdges[0],
      evidence: [{ ...observation.nodeEdges[0].evidence[0], sourcePath: "src/missing.ts" }]
    }]
  }).ok, false, "evidence must resolve to the extractor mappings");
});

test("comparison results expose only validated deterministic findings and warnings", async () => {
  const { validateArchitectureComparisonResult } = await import(contractsPath);
  const comparison = {
    schema: "architecture-comparison/v1",
    findings: [driftFinding()],
    warnings: ["The model contains a draft relationship outside this extractor."]
  };

  assert.equal(validateArchitectureComparisonResult(comparison).ok, true);
  assert.equal(validateArchitectureComparisonResult({ ...comparison, generatedAt: "unstable" }).ok, false);
  assert.equal(validateArchitectureComparisonResult({
    ...comparison,
    findings: [{ ...driftFinding(), generatedAt: "unstable" }]
  }).ok, false, "the shared architecture-drift-finding/v1 validator remains authoritative");
  assert.equal(validateArchitectureComparisonResult({
    ...comparison,
    findings: [driftFinding(), driftFinding()]
  }).ok, false, "finding identities are unique inside a comparison");
  assert.equal(validateArchitectureComparisonResult({ ...comparison, warnings: [42] }).ok, false);
});

test("the fixed adapter pipeline carries provider intent through extraction and comparison", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  const provider = providerObservation();
  const code = codeObservation();
  const comparison = {
    schema: "architecture-comparison/v1",
    findings: [driftFinding()],
    warnings: ["Compared the declared relation with the normalized code graph."]
  };
  const registry = {
    providers: new Map([["likec4", async () => ({
      status: "ok",
      tool: providerTool(),
      observation: provider
    })]]),
    extractors: new Map([["javascript-typescript/imports-v1", {
      run: async ({ providerObservation }: Record<string, any>) => providerObservation.nodes.includes("component.api")
        ? { status: "ok", observation: code }
        : { status: "invalid", issues: [{ code: "provider_not_forwarded", path: "providerObservation", message: "Provider intent was not forwarded." }] },
      compare: async ({ providerObservation, codeObservation, manifest }: Record<string, any>) =>
        providerObservation.relationships[0].sourceNodeId === codeObservation.nodeEdges[0].sourceNodeId &&
          manifest.extractors[0].id === codeObservation.extractor.id
          ? comparison
          : { schema: "architecture-comparison/v1", findings: [], warnings: [] }
    }]])
  };

  const result = await runArchitectureAdapterPipeline(pipelineOptions(), registry);

  assert.equal(result.ok, true);
  assert.deepEqual(result.tools, [providerTool()]);
  assert.deepEqual(result.observations, [code]);
  assert.deepEqual(result.comparisons, [comparison]);
});

test("snapshot aggregation consumes comparison findings separately from code observations", async () => {
  const { combineArchitectureObservations } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-runtime.mjs"
  );
  const comparison = {
    schema: "architecture-comparison/v1",
    findings: [driftFinding()],
    warnings: ["Compared the declared relation with the normalized code graph."]
  };

  const combined = combineArchitectureObservations([codeObservation()], [providerTool()], [comparison]);

  assert.deepEqual(combined.findings, comparison.findings);
  assert.deepEqual(combined.warnings, comparison.warnings);
  assert.equal(combined.stats.nodeEdges, 1);
  assert.equal(combined.tools.length, 2);
  assert.throws(
    () => combineArchitectureObservations([codeObservation()], [providerTool()], [comparison, comparison]),
    /finding IDs must be globally unique/u,
    "snapshot aggregation fails closed when separate comparisons reuse a finding identity"
  );
});

test("the adapter pipeline rejects finding IDs repeated across comparator results", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  const options = pipelineOptions();
  options.manifest.extractors.push(structuredClone(options.manifest.extractors[0]));
  const result = await runArchitectureAdapterPipeline(options, successRegistry({
    comparison: { schema: "architecture-comparison/v1", findings: [driftFinding()], warnings: [] }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.issues.some(
    (entry: Record<string, unknown>) => entry.code === "architecture_finding_identity_duplicate"
  ), true);
});

test("comparator findings are bound to the current extractor and tool provenance", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  for (const finding of [
    { ...driftFinding(), toolRef: "extractor:other" },
    { ...driftFinding(), relationshipId: "relation.missing" },
    {
      ...driftFinding(),
      sourceNodeId: "component.store",
      targetNodeId: "component.api"
    },
    {
      ...driftFinding(),
      evidence: [{ sourcePath: "src/api.ts", targetPath: "src/fabricated.ts", line: null }]
    },
    {
      ...driftFinding(),
      evidence: [{ sourcePath: "src/api.ts", targetPath: "src/store.ts", line: 999999 }]
    }
  ]) {
    const registry = successRegistry({
      comparison: { schema: "architecture-comparison/v1", findings: [finding], warnings: [] }
    });
    const result = await runArchitectureAdapterPipeline(pipelineOptions(), registry);
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.issues.some((entry: Record<string, unknown>) => entry.code === "architecture_comparison_mismatch"), true);
  }
});

test("unexpected relations can bind to mapped and unmapped code evidence without a model relationship", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  const code = codeObservation();
  code.nodeEdges = [];
  code.unmapped = [{
    extractorId: "js-ts-imports",
    path: "src/external.ts",
    role: "target",
    reason: "no-architecture-node",
    evidence: [{ mechanism: "import", sourcePath: "src/api.ts", targetPath: "src/external.ts", specifier: "./external.js" }]
  }];
  const finding = {
    ...driftFinding(),
    relationshipId: null,
    targetNodeId: null,
    evidence: [{ sourcePath: "src/api.ts", targetPath: "src/external.ts", line: null }]
  };

  const accepted = await runArchitectureAdapterPipeline(pipelineOptions(), successRegistry({
    code,
    comparison: { schema: "architecture-comparison/v1", findings: [finding], warnings: [] }
  }));
  assert.equal(accepted.ok, true, "relationshipId=null preserves unexpected unmapped dependency findings");

  const unbound = await runArchitectureAdapterPipeline(pipelineOptions(), successRegistry({
    code,
    comparison: {
      schema: "architecture-comparison/v1",
      findings: [{ ...finding, sourceNodeId: "component.store" }],
      warnings: []
    }
  }));
  assert.equal(unbound.ok, false, "the mapped evidence endpoint must equal the finding endpoint");
  assert.equal(unbound.status, "invalid");
});

test("the adapter pipeline fails closed on extra fields at every success boundary", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  const unboundCode = structuredClone(codeObservation());
  unboundCode.mappings[0].nodeId = "component.other-api";
  unboundCode.mappings[1].nodeId = "component.other-store";
  unboundCode.nodeEdges[0].sourceNodeId = "component.other-api";
  unboundCode.nodeEdges[0].targetNodeId = "component.other-store";
  const cases = [
    successRegistry({ provider: { ...providerObservation(), generatedAt: "unstable" } }),
    successRegistry({ code: { ...codeObservation(), findings: [] } }),
    successRegistry({ comparison: { schema: "architecture-comparison/v1", findings: [], warnings: [], generatedAt: "unstable" } }),
    successRegistry({ code: unboundCode })
  ];

  for (const registry of cases) {
    const result = await runArchitectureAdapterPipeline(pipelineOptions(), registry);
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
  }
});

test("the production fixed registry preserves deterministic two-tool degradation", async () => {
  const { runDeclaredArchitectureExtractors } = await import(adaptersPath);

  const result = await runDeclaredArchitectureExtractors(pipelineOptions());

  assert.equal(result.ok, false);
  assert.equal(result.status, "tool-missing");
  assert.deepEqual(result.missingTools.map((entry: Record<string, unknown>) => entry.role), ["provider", "extractor"]);
  assert.deepEqual(result.missingTools.map((entry: Record<string, unknown>) => entry.tool), ["likec4", "dependency-cruiser"]);
  assert.deepEqual(result.missingTools.map((entry: Record<string, unknown>) => entry.reason), [
    "fixed-adapter-capability-unavailable",
    "fixed-adapter-capability-unavailable"
  ]);
  assert.equal(result.missingTools.every((entry: Record<string, unknown>) =>
    /not connected in this release/u.test(String(entry.hint)) &&
    !/install/u.test(String(entry.hint))), true, "P2 stubs must not infer that installing a tool enables an unconnected adapter");
});

test("provider tool provenance is bound to the declared provider", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  for (const tool of [
    { ...providerTool(), declarationId: "other-provider" },
    { ...providerTool(), adapter: "other-provider/model-v1" }
  ]) {
    const result = await runArchitectureAdapterPipeline(pipelineOptions(), successRegistry({ providerTool: tool }));
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.issues.some((entry: Record<string, unknown>) => entry.code === "architecture_provider_result_invalid"), true);
  }
});

test("missing-tool results are bound to the declared adapter identity", async () => {
  const { runArchitectureAdapterPipeline } = await import(adaptersPath);
  for (const overrides of [
    { role: "extractor" },
    { declarationId: "other-provider" },
    { adapter: "different-provider/model-v1" }
  ]) {
    const registry = successRegistry();
    registry.providers.set("likec4", async () => ({
      status: "tool-missing",
      tool: missingTool(overrides)
    }));
    const result = await runArchitectureAdapterPipeline(pipelineOptions(), registry);
    assert.equal(result.ok, false);
    assert.equal(result.status, "invalid");
    assert.equal(result.issues.some((entry: Record<string, unknown>) => entry.code === "architecture_adapter_missing_tool_invalid"), true);
  }

  for (const overrides of [
    { declarationId: "other-extractor" },
    { adapter: "javascript-typescript/other-v1" }
  ]) {
    const extractorRegistry = successRegistry();
    extractorRegistry.extractors.set("javascript-typescript/imports-v1", {
      run: async () => ({
        status: "tool-missing",
        tool: missingTool({
          role: "extractor",
          declarationId: "js-ts-imports",
          adapter: "javascript-typescript/imports-v1",
          tool: "dependency-cruiser",
          reason: "adapter-not-installed",
          ...overrides
        })
      }),
      compare: async () => ({ schema: "architecture-comparison/v1", findings: [], warnings: [] })
    });
    const extractorResult = await runArchitectureAdapterPipeline(pipelineOptions(), extractorRegistry);
    assert.equal(extractorResult.status, "invalid");
    assert.equal(extractorResult.issues.some((entry: Record<string, unknown>) => entry.code === "architecture_adapter_missing_tool_invalid"), true);
  }

  const duplicateOptions = pipelineOptions();
  duplicateOptions.manifest.extractors.push(structuredClone(duplicateOptions.manifest.extractors[0]));
  const duplicateRegistry = successRegistry();
  duplicateRegistry.extractors.set("javascript-typescript/imports-v1", {
    run: async () => ({
      status: "tool-missing",
      tool: missingTool({
        role: "extractor",
        declarationId: "js-ts-imports",
        adapter: "javascript-typescript/imports-v1",
        tool: "dependency-cruiser",
        reason: "adapter-not-installed"
      })
    }),
    compare: async () => ({ schema: "architecture-comparison/v1", findings: [], warnings: [] })
  });
  const duplicateResult = await runArchitectureAdapterPipeline(duplicateOptions, duplicateRegistry);
  assert.equal(duplicateResult.status, "invalid", "duplicate missing-tool identities fail closed");
});

function providerObservation() {
  return {
    schema: "architecture-provider-observation/v1",
    providerId: "likec4",
    modelDigest: `sha256:${"1".repeat(64)}`,
    nodes: ["component.api", "component.store"],
    relationships: [{
      id: "relation.api-uses-store",
      sourceNodeId: "component.api",
      targetNodeId: "component.store",
      expectation: "allowed",
      extractorIds: ["js-ts-imports"]
    }]
  };
}

function codeObservation() {
  return {
    schema: "architecture-code-observation/v1",
    extractor: {
      id: "js-ts-imports",
      adapter: "javascript-typescript/imports-v1",
      sourceScopeIds: ["api-source", "store-source"],
      inputDigest: `sha256:${"2".repeat(64)}`,
      toolRef: "extractor:js-ts-imports"
    },
    tool: {
      role: "extractor",
      declarationId: "js-ts-imports",
      adapter: "javascript-typescript/imports-v1",
      tool: "dependency-cruiser",
      version: "16.0.0"
    },
    mappings: [
      { extractorId: "js-ts-imports", path: "src/api.ts", sourceScopeId: "api-source", nodeId: "component.api" },
      { extractorId: "js-ts-imports", path: "src/store.ts", sourceScopeId: "store-source", nodeId: "component.store" }
    ],
    nodeEdges: [{
      extractorId: "js-ts-imports",
      kind: "dependency",
      sourceNodeId: "component.api",
      targetNodeId: "component.store",
      evidence: [{ mechanism: "import", sourcePath: "src/api.ts", targetPath: "src/store.ts", specifier: "./store.js" }]
    }],
    unmapped: [],
    stats: { sourceFiles: 2 }
  };
}

function driftFinding() {
  return {
    schema: "architecture-drift-finding/v1",
    id: "finding.api-store",
    kind: "unexpected-dependency",
    severity: "error",
    extractorId: "js-ts-imports",
    relationshipId: "relation.api-uses-store",
    sourceNodeId: "component.api",
    targetNodeId: "component.store",
    toolRef: "extractor:js-ts-imports",
    evidence: [{ sourcePath: "src/api.ts", targetPath: "src/store.ts", line: null }],
    message: "Example drift finding."
  };
}

function providerTool() {
  return {
    role: "provider",
    declarationId: "likec4",
    adapter: "likec4/model-v1",
    tool: "likec4",
    version: "1.58.0"
  };
}

function missingTool(overrides: Record<string, unknown> = {}) {
  return {
    role: "provider",
    declarationId: "likec4",
    adapter: "likec4/model-v1",
    tool: "likec4",
    version: null,
    reason: "provider-not-installed",
    hint: "Install the declared provider explicitly.",
    ...overrides
  };
}

function pipelineOptions() {
  return {
    manifest: {
      provider: { id: "likec4" },
      extractors: [{
        id: "js-ts-imports",
        adapter: "javascript-typescript/imports-v1",
        sourceScopeIds: ["api-source", "store-source"]
      }]
    },
    configuration: { modelDigest: `sha256:${"1".repeat(64)}` },
    projectRoot: "/repository",
    executionRoot: "/execution",
    inputs: {}
  };
}

function successRegistry(overrides: Record<string, any> = {}) {
  const provider = overrides.provider ?? providerObservation();
  const fixedProviderTool = overrides.providerTool ?? providerTool();
  const code = overrides.code ?? codeObservation();
  const comparison = overrides.comparison ?? { schema: "architecture-comparison/v1", findings: [], warnings: [] };
  return {
    providers: new Map([["likec4", async () => ({ status: "ok", tool: fixedProviderTool, observation: provider })]]),
    extractors: new Map([["javascript-typescript/imports-v1", {
      run: async () => ({ status: "ok", observation: code }),
      compare: async () => comparison
    }]])
  };
}
