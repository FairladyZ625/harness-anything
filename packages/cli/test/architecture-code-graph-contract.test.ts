// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";

const contractPath = "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-code-graph.mjs";

test("language-neutral code graphs have a closed, portable contract", async () => {
  const { validateArchitectureCodeGraph } = await import(contractPath);
  const graph = codeGraph();

  assert.equal(validateArchitectureCodeGraph(graph).ok, true);
  for (const invalid of [
    { ...graph, generatedAt: "unstable" },
    { ...graph, files: [{ ...graph.files[0], path: "/tmp/api.ts" }, graph.files[1]] },
    { ...graph, files: [...graph.files].reverse() },
    { ...graph, dependencies: [graph.dependencies[0], structuredClone(graph.dependencies[0])] },
    { ...graph, tool: { ...graph.tool, tool: "another-extractor" } }
  ]) {
    assert.equal(validateArchitectureCodeGraph(invalid).ok, false);
  }
});

test("graph construction and digest are stable across input order", async () => {
  const {
    architectureCodeGraphDigest,
    architectureCodeGraphJson,
    buildArchitectureCodeGraph
  } = await import(contractPath);
  const input = codeGraph();
  const reordered = {
    ...input,
    files: [...input.files].reverse(),
    packages: [...input.packages].reverse(),
    dependencies: [...input.dependencies].reverse()
  };

  const first = buildArchitectureCodeGraph(input);
  const second = buildArchitectureCodeGraph(reordered);

  assert.equal(architectureCodeGraphJson(first), architectureCodeGraphJson(second));
  assert.equal(architectureCodeGraphDigest(input), architectureCodeGraphDigest(reordered));
  assert.match(architectureCodeGraphDigest(first), /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(first.files.map((entry: Record<string, unknown>) => entry.path), ["packages/api.ts", "packages/store.ts"]);
});

test("file, package, dependency, and stats references fail closed", async () => {
  const { validateArchitectureCodeGraph } = await import(contractPath);
  const graph = codeGraph();
  const mutations = [
    (candidate: Record<string, any>) => { candidate.files[0].sourceScopeId = "scope.missing"; },
    (candidate: Record<string, any>) => { candidate.files[0].packageId = "package.missing"; },
    (candidate: Record<string, any>) => { candidate.dependencies[0].targetPath = "packages/missing.ts"; },
    (candidate: Record<string, any>) => { candidate.packages[0].manifestPath = "packages/NUL"; },
    (candidate: Record<string, any>) => { candidate.packages.push({ id: "package.other", manifestPath: "PACKAGES/package.json" }); candidate.stats.packageCount = 2; },
    (candidate: Record<string, any>) => { candidate.stats.dependencyEdges = 2; },
    (candidate: Record<string, any>) => { candidate.dependencies[0].extra = true; }
  ];

  for (const mutate of mutations) {
    const candidate = structuredClone(graph);
    mutate(candidate);
    assert.equal(validateArchitectureCodeGraph(candidate).ok, false);
  }
});

test("the fixed JS/TS seam freezes argv isolation and result states", async () => {
  const { javascriptTypeScriptExtractorBoundary } = await import(contractPath);

  assert.deepEqual(javascriptTypeScriptExtractorBoundary(), {
    adapter: "javascript-typescript/imports-v1",
    tool: "dependency-cruiser",
    invocation: {
      mode: "argv",
      cwd: "repository-root",
      executable: "depcruise",
      outputType: "json",
      shell: false
    },
    result: {
      successSchema: "architecture-code-graph/v1",
      missingStatus: "tool-missing",
      invalidStatus: "invalid"
    }
  });
  assert.equal(Object.isFrozen(javascriptTypeScriptExtractorBoundary()), true);
});

function codeGraph() {
  return {
    schema: "architecture-code-graph/v1",
    extractor: {
      id: "js-ts-imports",
      adapter: "javascript-typescript/imports-v1",
      sourceScopeIds: ["repository-js-ts"],
      inputDigest: `sha256:${"1".repeat(64)}`,
      toolRef: "extractor:js-ts-imports"
    },
    tool: {
      role: "extractor",
      declarationId: "js-ts-imports",
      adapter: "javascript-typescript/imports-v1",
      tool: "dependency-cruiser",
      version: "18.1.0"
    },
    files: [
      { path: "packages/api.ts", sourceScopeId: "repository-js-ts", packageId: "package.api" },
      { path: "packages/store.ts", sourceScopeId: "repository-js-ts", packageId: null }
    ],
    packages: [
      { id: "package.api", manifestPath: "packages/package.json" }
    ],
    dependencies: [
      {
        sourcePath: "packages/api.ts",
        targetPath: "packages/store.ts",
        mechanism: "import",
        specifier: "./store.js"
      }
    ],
    stats: { sourceFiles: 2, packageCount: 1, dependencyEdges: 1 }
  };
}
