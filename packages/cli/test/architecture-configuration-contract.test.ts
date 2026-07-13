// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("architecture configuration rejects portable root aliases before canonical lookup", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ha-architecture-root-alias-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const authoredRoot = path.join(projectRoot, "harness");
  mkdirSync(path.join(authoredRoot, "context", "Architecture"), { recursive: true });

  const result = inspectArchitectureConfiguration({ projectRoot, authoredRoot });
  assert.equal(result.configured, true);
  assert.deepEqual(result.manifest, {
    path: "harness/context/architecture/architecture-manifest.json",
    present: false,
    valid: false,
    digest: null
  });
  assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_root_path_collision"), true);
});

test("architecture configuration rejects portable manifest aliases before canonical lookup", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );
  const fixture = createArchitectureFixture({});
  t.after(() => rmSync(fixture.projectRoot, { recursive: true, force: true }));
  renameSync(
    path.join(fixture.architectureRoot, "architecture-manifest.json"),
    path.join(fixture.architectureRoot, "Architecture-Manifest.json")
  );

  for (const hostValidatedBoundary of [false, true]) {
    const result = inspectArchitectureConfiguration({ ...fixture, hostValidatedBoundary });
    assert.equal(result.configured, true);
    assert.deepEqual(result.manifest, {
      path: "harness/context/architecture/architecture-manifest.json",
      present: false,
      valid: false,
      digest: null
    });
    assert.equal(result.issues.some(
      (issue: Record<string, unknown>) => issue.code === "architecture_manifest_path_collision"
    ), true);
  }
});

test("architecture configuration rejects unsafe repository path components but permits normal absence", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ha-architecture-root-components-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));

  const missingAuthoredRoot = path.join(projectRoot, "missing", "harness");
  mkdirSync(missingAuthoredRoot, { recursive: true });
  assert.deepEqual(inspectArchitectureConfiguration({ projectRoot, authoredRoot: missingAuthoredRoot }).issues, []);
  assert.equal(inspectArchitectureConfiguration({ projectRoot, authoredRoot: missingAuthoredRoot }).configured, false);

  const linkedTarget = path.join(projectRoot, "linked-authored-target");
  const linkedAuthoredRoot = path.join(projectRoot, "linked-harness");
  mkdirSync(path.join(linkedTarget, "context", "architecture"), { recursive: true });
  createDirectoryLink(linkedTarget, linkedAuthoredRoot);
  const linkedResult = inspectArchitectureConfiguration({ projectRoot, authoredRoot: linkedAuthoredRoot });
  assert.equal(linkedResult.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_root_symlink"), true);

  const danglingTarget = path.join(projectRoot, "dangling-authored-target");
  const danglingAuthoredRoot = path.join(projectRoot, "dangling-harness");
  mkdirSync(danglingTarget);
  createDirectoryLink(danglingTarget, danglingAuthoredRoot);
  rmSync(danglingTarget, { recursive: true });
  const danglingResult = inspectArchitectureConfiguration({ projectRoot, authoredRoot: danglingAuthoredRoot });
  assert.equal(danglingResult.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_root_symlink"), true);

  const blockedAuthoredRoot = path.join(projectRoot, "blocked-harness");
  writeFileSync(blockedAuthoredRoot, "not a directory", "utf8");
  const blockedResult = inspectArchitectureConfiguration({ projectRoot, authoredRoot: blockedAuthoredRoot });
  assert.equal(blockedResult.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_root_invalid"), true);
});

test("host-validated architecture inspection skips only ancestor validation", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );
  const fixture = createArchitectureFixture({});
  t.after(() => rmSync(fixture.projectRoot, { recursive: true, force: true }));
  const linkedAuthoredRoot = path.join(fixture.projectRoot, "linked-harness");
  createDirectoryLink(fixture.authoredRoot, linkedAuthoredRoot);

  const standalone = inspectArchitectureConfiguration({
    projectRoot: fixture.projectRoot,
    authoredRoot: linkedAuthoredRoot
  });
  assert.equal(standalone.issues.some((entry: Record<string, unknown>) => entry.code === "architecture_root_symlink"), true);

  const hostValidated = inspectArchitectureConfiguration({
    projectRoot: fixture.projectRoot,
    authoredRoot: linkedAuthoredRoot,
    hostValidatedBoundary: true
  });
  assert.equal(hostValidated.configured, true);
  assert.deepEqual(hostValidated.issues, []);

  const proxyAuthoredRoot = path.join(fixture.projectRoot, "proxy-harness");
  mkdirSync(path.join(proxyAuthoredRoot, "context"), { recursive: true });
  createDirectoryLink(fixture.architectureRoot, path.join(proxyAuthoredRoot, "context", "architecture"));
  const linkedArchitectureRoot = inspectArchitectureConfiguration({
    projectRoot: fixture.projectRoot,
    authoredRoot: proxyAuthoredRoot,
    hostValidatedBoundary: true
  });
  assert.equal(linkedArchitectureRoot.issues.some(
    (entry: Record<string, unknown>) => entry.code === "architecture_root_symlink"
  ), true, "host validation never skips checks at or below architectureRoot");
});

test("architecture configuration requires exact manifest path spelling", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );
  const fixtures = [
    createArchitectureFixture({ physicalModelRoot: "Model" }),
    createArchitectureFixture({ physicalViewsRoot: "Views" }),
    createArchitectureFixture({ physicalProviderConfig: "LikeC4.config.json" }),
    createArchitectureFixture({ providerConfig: "café.json", physicalProviderConfig: "cafe\u0301.json" })
  ];
  t.after(() => fixtures.forEach((fixture) => rmSync(fixture.projectRoot, { recursive: true, force: true })));
  for (const fixture of fixtures) {
    const result = inspectArchitectureConfiguration(fixture);
    assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_model_path_collision"), true);
  }
  const providerAliasResult = inspectArchitectureConfiguration(fixtures[2]);
  assert.equal(
    providerAliasResult.modelFiles.some((entry: Record<string, unknown>) => String(entry.path).endsWith("/LikeC4.config.json")),
    true,
    "an aliased provider config remains represented in the invalid configuration digest inputs"
  );
});

test("architecture configuration rejects symlinks in every declared path component", async (t) => {
  const { inspectArchitectureConfiguration } = await import(
    "../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-configuration.mjs"
  );

  await t.test("modelRoot intermediate symlink", () => {
    const fixture = createArchitectureFixture({ manifestModelRoot: "model-link/model", physicalModelRoot: "real-parent/model" });
    t.after(() => rmSync(fixture.projectRoot, { recursive: true, force: true }));
    createDirectoryLink(path.join(fixture.architectureRoot, "real-parent"), path.join(fixture.architectureRoot, "model-link"));
    const result = inspectArchitectureConfiguration(fixture);
    assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_model_root_symlink"), true);
  });

  await t.test("provider intermediate symlink", () => {
    const fixture = createArchitectureFixture({ providerConfig: "config-link/likec4.config.json", physicalProviderConfig: "real-config/likec4.config.json" });
    t.after(() => rmSync(fixture.projectRoot, { recursive: true, force: true }));
    createDirectoryLink(path.join(fixture.modelRoot, "real-config"), path.join(fixture.modelRoot, "config-link"));
    const result = inspectArchitectureConfiguration(fixture);
    assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_model_symlink"), true);
  });

  await t.test("dangling view leaf symlink", () => {
    const fixture = createArchitectureFixture({});
    t.after(() => rmSync(fixture.projectRoot, { recursive: true, force: true }));
    const viewPath = path.join(fixture.modelRoot, "views", "runtime.c4");
    const target = path.join(fixture.projectRoot, "removed-view-target");
    rmSync(viewPath);
    mkdirSync(target);
    createDirectoryLink(target, viewPath);
    rmSync(target, { recursive: true });
    const result = inspectArchitectureConfiguration(fixture);
    assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === "architecture_model_symlink"), true);
  });
});

function createArchitectureFixture(options: {
  readonly manifestModelRoot?: string;
  readonly physicalModelRoot?: string;
  readonly providerConfig?: string;
  readonly physicalProviderConfig?: string;
  readonly physicalViewsRoot?: string;
}) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "ha-architecture-components-"));
  const authoredRoot = path.join(projectRoot, "harness");
  const architectureRoot = path.join(authoredRoot, "context", "architecture");
  const manifestModelRoot = options.manifestModelRoot ?? "model";
  const modelRoot = path.join(architectureRoot, options.physicalModelRoot ?? manifestModelRoot);
  const providerConfig = options.providerConfig ?? "likec4.config.json";
  const physicalProviderConfig = options.physicalProviderConfig ?? providerConfig;
  const manifest = architectureManifest(manifestModelRoot, providerConfig);
  mkdirSync(architectureRoot, { recursive: true });
  writeFileSync(path.join(architectureRoot, "architecture-manifest.json"), JSON.stringify(manifest), "utf8");
  writeFixtureFile(path.join(modelRoot, physicalProviderConfig), "{}\n");
  for (const view of manifest.views) {
    const viewPath = options.physicalViewsRoot
      ? path.join(modelRoot, options.physicalViewsRoot, path.basename(view.path))
      : path.join(modelRoot, view.path);
    writeFixtureFile(viewPath, "model {}\n");
  }
  return { projectRoot, authoredRoot, architectureRoot, modelRoot };
}

function architectureManifest(modelRoot: string, providerConfig: string) {
  return {
    schema: "architecture-manifest/v1",
    enabled: true,
    modelContract: "architecture-model/v1",
    provider: { id: "likec4", config: providerConfig },
    modelRoot,
    views: [
      { id: "landscape", providerView: "landscape", path: "views/landscape.c4" },
      { id: "write-path", providerView: "writePath", path: "views/write-path.c4" },
      { id: "runtime", providerView: "runtime", path: "views/runtime.c4" }
    ],
    sourceScopes: [{ id: "repository-js-ts", nodeId: "system.repository", include: ["**/*.ts"], exclude: [] }],
    extractors: [{ id: "js-ts-imports", adapter: "javascript-typescript/imports-v1", sourceScopeIds: ["repository-js-ts"] }]
  };
}

function writeFixtureFile(filePath: string, body: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function createDirectoryLink(target: string, linkPath: string) {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}
