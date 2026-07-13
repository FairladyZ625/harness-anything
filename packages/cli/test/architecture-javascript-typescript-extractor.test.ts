// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const extractorPath = "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-javascript-typescript-extractor.mjs";
const graphPath = "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-code-graph.mjs";
const rawFixture = JSON.parse(readFileSync(new URL("./fixtures/architecture-dependency-cruiser-output.json", import.meta.url), "utf8"));

test("dependency-cruiser output normalizes to a byte-stable scoped graph", async () => {
  const { decodeDependencyCruiserCodeGraph } = await import(extractorPath);
  const { architectureCodeGraphDigest, architectureCodeGraphJson } = await import(graphPath);
  await withFixtureRoot((executionRoot) => {
    const first = decodeDependencyCruiserCodeGraph({ raw: rawFixture, executionRoot, extractor: extractor(), scopes: scopes() });
    const reordered = decodeDependencyCruiserCodeGraph({
      raw: { ...rawFixture, modules: [...rawFixture.modules].reverse() },
      executionRoot,
      extractor: extractor(),
      scopes: scopes()
    });
    assert.equal(first.status, "ok");
    assert.equal(reordered.status, "ok");
    assert.equal(architectureCodeGraphJson(first.graph), architectureCodeGraphJson(reordered.graph));
    assert.equal(architectureCodeGraphDigest(first.graph), architectureCodeGraphDigest(reordered.graph));
    assert.deepEqual(first.graph.files.map((entry: Record<string, unknown>) => entry.path), [
      "packages/api/src/index.ts",
      "packages/store/src/index.ts"
    ]);
    assert.deepEqual(first.graph.dependencies, [{
      sourcePath: "packages/api/src/index.ts",
      targetPath: "packages/store/src/index.ts",
      mechanism: "import",
      specifier: "@fixture/store"
    }]);
    assert.equal(first.graph.packages.length, 2);
    assert.deepEqual(first.graph.stats, { sourceFiles: 2, packageCount: 2, dependencyEdges: 1 });
    assert.equal(JSON.stringify(first.graph).includes(executionRoot), false);
  });
});

test("fixed invocation disables repository config and never uses a shell", async () => {
  const { dependencyCruiserInvocation, runJavaScriptTypeScriptCodeGraph } = await import(extractorPath);
  const { runDeclaredArchitectureCodeGraph } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-adapters.mjs"
  );
  const invocation = dependencyCruiserInvocation(scopes());
  assert.deepEqual(invocation, {
    executable: "depcruise",
    argv: [
      "--no-config", "--output-type", "json", "--progress", "none", "--exclude",
      "(^|/)(node_modules|dist|test|tests|__tests__)(/|$)|\\.(test|spec)\\.[cm]?[jt]sx?$",
      "--",
      "packages"
    ],
    shell: false
  });
  await withFixtureRoot(async (executionRoot) => {
    let captured: Record<string, unknown> | null = null;
    const result = await runJavaScriptTypeScriptCodeGraph({
      manifest: manifest(),
      extractor: extractor(),
      executionRoot,
      execute: async (options: Record<string, unknown>) => {
        if ((options.argv as string[]).includes("--version")) return { status: "ok", stdout: "17.4.3\n" };
        captured = options;
        return { status: "ok", stdout: JSON.stringify(rawFixture) };
      }
    });
    assert.equal(result.status, "ok");
    assert.equal(captured?.executable, "depcruise");
    assert.equal(captured?.cwd, executionRoot);
    assert.equal(captured?.shell, false);
    assert.equal((captured?.argv as string[]).includes("--no-config"), true);
    const registered = await runDeclaredArchitectureCodeGraph({
      manifest: manifest(),
      extractor: extractor(),
      executionRoot,
      execute: async (options: Record<string, unknown>) => (options.argv as string[]).includes("--version")
        ? { status: "ok", stdout: "17.4.3\n" }
        : { status: "ok", stdout: JSON.stringify(rawFixture) }
    });
    assert.equal(registered.status, "ok", "the fixed registry exposes the raw code graph seam for P3c mapping");
  });
});

test("missing, failed, malformed, version-mismatched, and unknown output fail closed", async () => {
  const { runJavaScriptTypeScriptCodeGraph } = await import(extractorPath);
  await withFixtureRoot(async (executionRoot) => {
    const options = { manifest: manifest(), extractor: extractor(), executionRoot };
    const missing = await runJavaScriptTypeScriptCodeGraph({ ...options, execute: async () => ({ status: "tool-missing" }) });
    assert.equal(missing.status, "tool-missing");
    assert.equal(missing.tool.version, null);
    const failed = await runJavaScriptTypeScriptCodeGraph({ ...options, execute: async () => ({ status: "failed", reason: "exit-2" }) });
    assert.equal(failed.status, "invalid");
    const malformed = await runJavaScriptTypeScriptCodeGraph({
      ...options,
      execute: async (call: Record<string, unknown>) => (call.argv as string[]).includes("--version")
        ? { status: "ok", stdout: "17.4.3\n" }
        : { status: "ok", stdout: "{" }
    });
    assert.equal(malformed.status, "invalid");
    const version = await runJavaScriptTypeScriptCodeGraph({ ...options, execute: async () => ({ status: "ok", stdout: "18.1.0\n" }) });
    assert.equal(version.status, "invalid");
    const unknownTopLevel = { ...rawFixture, generatedAt: "unstable" };
    const unknown = await runJavaScriptTypeScriptCodeGraph({
      ...options,
      execute: async (call: Record<string, unknown>) => (call.argv as string[]).includes("--version")
        ? { status: "ok", stdout: "17.4.3\n" }
        : { status: "ok", stdout: JSON.stringify(unknownTopLevel) }
    });
    assert.equal(unknown.status, "invalid");
  });
});

test("overlapping source scopes and undeclared roots never produce a partial graph", async () => {
  const { decodeDependencyCruiserCodeGraph } = await import(extractorPath);
  await withFixtureRoot((executionRoot) => {
    const result = decodeDependencyCruiserCodeGraph({
      raw: rawFixture,
      executionRoot,
      extractor: { ...extractor(), sourceScopeIds: ["packages", "packages-api"] },
      scopes: [
        ...scopes(),
        { id: "packages-api", include: ["packages/api/**/*.ts"], exclude: [] }
      ]
    });
    assert.equal(result.status, "invalid");
    assert.equal(result.graph, undefined);
    assert.equal(result.issues[0].code, "architecture_extractor_scope_ambiguous");
  });
});

function extractor() {
  return { id: "js-ts-imports", adapter: "javascript-typescript/imports-v1", sourceScopeIds: ["packages"] };
}

function scopes() {
  return [{ id: "packages", include: ["packages/**/*.ts"], exclude: ["packages/generated/**"] }];
}

function manifest() {
  return { sourceScopes: scopes() };
}

async function withFixtureRoot<T>(run: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "ha-architecture-extractor-"));
  try {
    for (const packageName of ["api", "store"]) {
      const directory = path.join(root, "packages", packageName);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: `@fixture/${packageName}` }));
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
