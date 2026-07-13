// harness-test-tier: contract
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  findPortablePathCollisions,
  normalizeRelativeDocumentPath
} from "../../kernel/src/index.ts";
import { ensureTestHarnessIdentity } from "./helpers/git-fixtures.ts";
import { unwrapCommandReceipt } from "./helpers/receipt.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const architectureRotRoot = path.resolve("packages/cli/src/commands/extensions/assets/software-coding/presets/architecture-rot-audit");
const detectorPolicy = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/detectors/detector-policy.mjs");
const seedDetectors = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/detectors/seed-detectors.mjs");
const snapshotHelpers = await import("../src/commands/extensions/assets/software-coding/presets/architecture-rot-audit/scripts/snapshot.mjs");

const cliPackage = JSON.parse(readFileSync("packages/cli/package.json", "utf8")) as {
  readonly name: string;
  readonly private?: boolean;
  readonly version: string;
  readonly description?: string;
  readonly repository?: { readonly directory?: string };
  readonly scripts?: Record<string, string>;
  readonly bin?: Record<string, string>;
  readonly exports?: Record<string, string>;
  readonly files?: readonly string[];
  readonly dependencies?: Record<string, string>;
  readonly publishConfig?: { readonly access?: string };
  readonly engines?: { readonly node?: string };
};

test("CLI package exposes the CLI-only npm dry-run artifact surface", () => {
  assert.equal(cliPackage.name, "@harness-anything/cli");
  assert.equal(cliPackage.private, undefined);
  assert.equal(cliPackage.version, "0.1.0");
  assert.equal(cliPackage.description?.length > 0, true);
  assert.equal(cliPackage.publishConfig?.access, "public");
  assert.equal(cliPackage.repository?.directory, "packages/cli");
  assert.equal(cliPackage.engines?.node, ">=24");
  assert.equal(cliPackage.scripts?.build, "tsc -p tsconfig.build.json && node scripts/copy-assets.mjs");
  assert.equal(cliPackage.bin?.["harness-anything"], "dist/cli/src/index.js");
  assert.equal(cliPackage.bin?.ha, "dist/cli/src/index.js");
  assert.equal(cliPackage.exports?.["."], "./dist/cli/src/index.js");
  assert.equal(cliPackage.files?.includes("dist"), true);
  assert.equal(cliPackage.dependencies?.["@effect/platform"], "0.96.2");
  assert.equal(cliPackage.dependencies?.effect, "3.21.4");
  const cliEntry = path.resolve("packages/cli/src/index.ts");
  assert.equal(readFileSync(cliEntry, "utf8").startsWith("#!/usr/bin/env node"), true);
  if (process.platform !== "win32") {
    assert.equal((statSync(cliEntry).mode & 0o111) !== 0, true);
  }
});

test("bundled software coding assets have consistent template and process-preset surfaces", () => {
  const assetRoot = "packages/cli/src/commands/extensions/assets/software-coding";
  const catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")) as {
    readonly schema: string;
    readonly documents: ReadonlyArray<{
      readonly id: string;
      readonly materializeAs: string;
      readonly locales: ReadonlyArray<{ readonly locale: string; readonly body?: unknown; readonly bodyPath?: unknown }>;
    }>;
  };
  const vertical = JSON.parse(readFileSync(path.join(assetRoot, "vertical.json"), "utf8")) as {
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
    readonly packageScaffolds: ReadonlyArray<{
      readonly entityKind: string;
      readonly templateSelections: ReadonlyArray<TemplateSelection>;
    }>;
    readonly repositoryScaffold: {
      readonly seededDocs: ReadonlyArray<TemplateSelection & { readonly body?: unknown; readonly path?: unknown }>;
    };
    readonly projectionSchemas: ReadonlyArray<{ readonly schemaRef: string }>;
    readonly scripts: ReadonlyArray<{
      readonly id: string;
      readonly metadata: { readonly purpose: string };
    }>;
  };
  const index = JSON.parse(readFileSync(path.join(assetRoot, "presets/index.json"), "utf8")) as {
    readonly presets: ReadonlyArray<string>;
  };
  const catalogIds = new Set(catalog.documents.map((document) => document.id));
  const selectedMaterializedPaths = new Set<string>();
  const bundledPresetIds = [
    "standard-task",
    "reference-task",
    "long-running-task",
    "module",
    "subtask-expansion",
    "github-issue-repair",
    "legacy-migration",
    "create-milestone",
    "milestone-closeout",
    "decision-conformance",
    "worker-dispatch",
    "code-impact-analysis",
    "architecture-rot-audit"
  ].sort();

  assert.equal(catalog.schema, "template-catalog/v2");
  for (const document of catalog.documents) {
    for (const locale of document.locales) {
      assert.equal(locale.body, undefined, `${document.id} ${locale.locale} must not inline template body`);
      assert.equal(typeof locale.bodyPath, "string", `${document.id} ${locale.locale} must reference bodyPath`);
      assert.equal(statSync(path.join(assetRoot, String(locale.bodyPath))).isFile(), true, `${document.id} ${locale.locale} bodyPath must exist`);
    }
  }

  assert.equal(vertical.templateSelections.length, 0, "vertical top-level templateSelections stay deduplicated");
  const taskScaffoldSelections = vertical.packageScaffolds.find((scaffold) => scaffold.entityKind === "task")?.templateSelections ?? [];

  for (const selection of taskScaffoldSelections) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selectedMaterializedPaths.has(selection.materializeAs), false, `duplicate materialized path ${selection.materializeAs}`);
    selectedMaterializedPaths.add(selection.materializeAs);
  }

  for (const selection of vertical.repositoryScaffold.seededDocs) {
    assertKnownTemplateRef(catalogIds, selection.templateRef);
    assert.equal(selection.body, undefined, `${selection.templateRef} must not inline seeded doc body`);
    assert.equal(selection.path, undefined, `${selection.templateRef} must use materializeAs instead of path`);
  }
  const architectureTemplates = new Map([
    ["repository/architecture-readme", "harness/context/architecture/README.md"],
    ["repository/architecture-manifest", "harness/context/architecture/architecture-manifest.json"],
    ["repository/architecture-likec4-config", "harness/context/architecture/model/likec4.config.json"],
    ["repository/architecture-likec4-specification", "harness/context/architecture/model/specification.c4"],
    ["repository/architecture-likec4-model", "harness/context/architecture/model/model.c4"],
    ["repository/architecture-likec4-view-landscape", "harness/context/architecture/model/views/landscape.c4"],
    ["repository/architecture-likec4-view-write-path", "harness/context/architecture/model/views/write-path.c4"],
    ["repository/architecture-likec4-view-runtime", "harness/context/architecture/model/views/runtime.c4"]
  ]);
  for (const [id, materializeAs] of architectureTemplates) {
    const document = catalog.documents.find((candidate) => candidate.id === id);
    assert.notEqual(document, undefined, `${id} must be registered in the coding vertical catalog`);
    assert.equal(document?.materializeAs, materializeAs);
  }
  const selectedRefs = new Set(vertical.repositoryScaffold.seededDocs.map((selection) => selection.templateRef));
  assert.equal(selectedRefs.has("template://repository/architecture-readme@1"), true, "init seeds only the architecture guide");
  for (const id of [...architectureTemplates.keys()].filter((candidate) => candidate !== "repository/architecture-readme")) {
    assert.equal(selectedRefs.has(`template://${id}@1`), false, `${id} must stay explicitly opt-in`);
  }
  assert.equal(vertical.projectionSchemas.some((projection) => projection.schemaRef.includes("architecture-manifest")), false);
  assert.equal(vertical.scripts.some((script) => script.id === "vertical:software-coding:adr-seed" && script.metadata.purpose === "scaffold"), true);
  assert.deepEqual([...index.presets].sort(), bundledPresetIds, "bundled preset ids must match the approved public distribution list");

  for (const presetId of index.presets) {
    const manifest = JSON.parse(readFileSync(path.join(assetRoot, "presets", presetId, "preset.json"), "utf8")) as PresetAsset;
    for (const profile of manifest.profiles) {
      const profilePaths = new Set<string>();
      for (const selection of profile.templateSelections) {
        assertKnownTemplateRef(catalogIds, selection.templateRef);
        assert.equal(profilePaths.has(selection.materializeAs), false, `duplicate ${presetId} materialized path ${selection.materializeAs}`);
        profilePaths.add(selection.materializeAs);
      }
    }
    if (manifest.kind === "process-action") {
      assert.notEqual(Object.keys(manifest.entrypoints ?? {}).length, 0);
      for (const entrypoint of Object.values(manifest.entrypoints ?? {})) {
        const scriptEntrypoint = entrypoint as { readonly command?: string; readonly reads?: ReadonlyArray<string>; readonly writes?: ReadonlyArray<string> };
        assert.equal(scriptEntrypoint.reads?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive reads`);
        assert.equal(scriptEntrypoint.writes?.includes("{{paths.rootDir}}/**") ?? false, false, `${presetId} declares repo-wide recursive writes`);
        if (typeof scriptEntrypoint.command === "string") {
          assertPresetScriptImportsStayInsidePackage(path.join(assetRoot, "presets", presetId), scriptEntrypoint.command);
        }
      }
    }
  }
});

test("architecture contracts are single-authority, portable, and route the scaffold", async () => {
  const assetRoot = path.resolve("packages/cli/src/commands/extensions/assets/software-coding");
  const contractPath = path.join(assetRoot, "architecture/contracts/architecture-manifest.mjs");
  const generatorPath = path.resolve("tools/generate-architecture-manifest-schema.mjs");
  const contract = await import("../src/commands/extensions/assets/software-coding/architecture/contracts/architecture-manifest.mjs");
  const manifest = JSON.parse(readFileSync(path.join(assetRoot, "templates/repository.architecture.manifest/en-US.md"), "utf8")) as Record<string, any>;
  const likeC4Model = readFileSync(path.join(assetRoot, "templates/repository.architecture.likec4.model/en-US.md"), "utf8");
  const catalog = JSON.parse(readFileSync(path.join(assetRoot, "template-catalog.json"), "utf8")) as {
    readonly documents: ReadonlyArray<{
      readonly id: string;
      readonly materializeAs: string;
      readonly locales: ReadonlyArray<{ readonly locale: string; readonly bodyPath: string }>;
    }>;
  };
  const generatedSchema = contract.architectureManifestJsonSchema();
  const modelContract = contract.architectureModelContract();

  assert.match(execFileSync(process.execPath, [generatorPath, "--check"], { encoding: "utf8" }), /fresh/u);
  assert.equal(manifest.modelContract, modelContract.id);
  assert.equal(generatedSchema.properties.modelContract.const, modelContract.id);
  assert.deepEqual(modelContract.views.requiredIds, ["landscape", "write-path", "runtime"]);
  assert.deepEqual(modelContract.elements.requiredMetadataKeys, [
    "archId",
    "status",
    "owner",
    "responsibilities",
    "nonResponsibilities"
  ]);
  assert.deepEqual(modelContract.metadataFields.expectation.enum, ["allowed", "required", "forbidden"]);
  assert.deepEqual(modelContract.metadataFields.status, { type: "string", enum: ["draft", "verified"] });
  assert.deepEqual(modelContract.metadataFields.placeholder, { type: "boolean" });
  assert.deepEqual(modelContract.metadataFields.owner, { type: "string", minLength: 1 });
  for (const metadataKey of ["responsibilities", "nonResponsibilities", "extractorIds", "adrRefs", "decisionRefs"]) {
    assert.equal(modelContract.metadataFields[metadataKey].type, "array");
    assert.equal(modelContract.metadataFields[metadataKey].minItems, 1);
    assert.equal(modelContract.metadataFields[metadataKey].uniqueItems, true);
  }
  assert.equal(modelContract.metadataFields.extractorIds.references, "architecture-manifest/v1#extractors[].id");
  assert.deepEqual(modelContract.evidence.verifiedRule, {
    when: { metadataKey: "status", equals: "verified" },
    requireAny: [
      { metadataKey: "adrRefs", minItems: 1 },
      { metadataKey: "decisionRefs", minItems: 1 }
    ]
  });
  assert.equal(
    modelContract.metadataFields.status.enum.includes(modelContract.evidence.verifiedRule.when.equals),
    true,
    "verified evidence rule must reference an allowed lifecycle status"
  );
  assert.deepEqual(contract.validateArchitectureManifest(manifest), { ok: true, value: manifest, issues: [] });
  const permissionProbe = execFileSync(process.execPath, [
    "--permission",
    `--allow-fs-read=${path.dirname(contractPath)}`,
    "--input-type=module",
    "--eval",
    `import { architectureManifestJsonSchema, architectureModelContract } from ${JSON.stringify(pathToFileURL(contractPath).href)}; process.stdout.write(architectureManifestJsonSchema().$id + "\\n" + architectureModelContract().id);`
  ], { encoding: "utf8" });
  assert.equal(permissionProbe, `${generatedSchema.$id}\n${modelContract.id}`, "vertical actions can load both contracts without node_modules access");
  for (const metadataKey of new Set([
    ...modelContract.elements.requiredMetadataKeys,
    ...modelContract.relationships.requiredMetadataKeys,
    modelContract.lifecycle.placeholderMetadataKey,
    modelContract.evidence.adrRefsMetadataKey,
    modelContract.evidence.decisionRefsMetadataKey
  ])) {
    assert.match(likeC4Model, new RegExp(`\\b${metadataKey}\\b`, "u"), `LikeC4 scaffold must carry ${metadataKey}`);
  }
  assert.match(likeC4Model, /adrRefs \['harness\/adr\/ADR-0000-replace-me\.md'\]/u);
  assert.equal(new RegExp(modelContract.metadataFields.decisionRefs.items.pattern, "u").test("decision/dec_replace_me"), true);
  assert.match(likeC4Model, /decisionRefs \['decision\/dec_replace_me'\]/u);
  const providerInputs = catalog.documents
    .filter((document) => document.id.startsWith("repository/architecture-likec4-"))
    .map((document) => {
      const bodyPath = document.locales.find((locale) => locale.locale === "en-US")?.bodyPath;
      assert.notEqual(bodyPath, undefined, `${document.id} must have an en-US provider body`);
      return {
        materializeAs: document.materializeAs,
        sha256: createHash("sha256").update(readFileSync(path.join(assetRoot, bodyPath!), "utf8")).digest("hex")
      };
    })
    .sort((left, right) => left.materializeAs.localeCompare(right.materializeAs));
  const providerValidation = JSON.parse(readFileSync(
    path.join(assetRoot, "architecture/contracts/likec4-scaffold.validation.json"),
    "utf8"
  )) as Record<string, any>;
  const providerInputDigest = `sha256:${createHash("sha256").update(JSON.stringify(providerInputs)).digest("hex")}`;
  assert.equal(providerInputs.length, 6);
  assert.equal(providerValidation.schema, "architecture-provider-validation/v1");
  assert.equal(providerValidation.provider, "likec4");
  assert.equal(providerValidation.version, "1.58.0");
  assert.deepEqual(providerValidation.invocation, ["npx", "--yes", "likec4@1.58.0", "validate"]);
  assert.equal(providerValidation.cwd, "manifest.modelRoot");
  assert.deepEqual(providerValidation.inputs, providerInputs);
  assert.equal(providerValidation.inputCount, providerInputs.length);
  assert.equal(providerValidation.inputDigest, providerInputDigest, "LikeC4 validation evidence must cover the exact provider inputs");
  assert.equal(providerValidation.result, "valid");
  const targets = new Map(catalog.documents.map((document) => [document.id, document.materializeAs]));
  const manifestDirectory = path.posix.dirname(targets.get("repository/architecture-manifest")!);
  const modelDirectory = path.posix.join(manifestDirectory, manifest.modelRoot);
  assert.equal(path.posix.join(modelDirectory, manifest.provider.config), targets.get("repository/architecture-likec4-config"));
  for (const view of manifest.views) {
    assert.equal(path.posix.join(modelDirectory, view.path), targets.get(`repository/architecture-likec4-view-${view.id}`));
  }

  const defaultExcludes = new Set(manifest.sourceScopes[0].exclude);
  const expectedDefaultExcludes = [
    ".git/**",
    ".harness/**",
    ".harness-private/**",
    ".worktrees/**",
    "harness/**",
    "**/.git/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/coverage/**",
    "**/test/**",
    "**/tests/**",
    "**/__tests__/**",
    "**/e2e/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.vitest.*"
  ];
  assert.deepEqual([...defaultExcludes].sort(), expectedDefaultExcludes.sort(), "default source scope exclusions are contractual");

  const cases = [
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.enabled = false; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.modelRoot = "../model"; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "model\0x",
      mutate: (candidate: Record<string, any>) => { candidate.modelRoot = "model\0x"; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "model.",
      mutate: (candidate: Record<string, any>) => { candidate.modelRoot = "model."; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "model ",
      mutate: (candidate: Record<string, any>) => { candidate.modelRoot = "model "; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "config:likec4.json",
      mutate: (candidate: Record<string, any>) => { candidate.provider.config = "config:likec4.json"; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "NUL.json",
      mutate: (candidate: Record<string, any>) => { candidate.provider.config = "NUL.json"; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "*.json",
      mutate: (candidate: Record<string, any>) => { candidate.provider.config = "*.json"; }
    },
    {
      code: "architecture_manifest_invalid",
      physicalPath: "views/CON.c4",
      mutate: (candidate: Record<string, any>) => { candidate.views[0].path = "views/CON.c4"; }
    },
    {
      code: "duplicate_architecture_view_id",
      mutate: (candidate: Record<string, any>) => { candidate.views[1].id = candidate.views[0].id; }
    },
    {
      code: "duplicate_architecture_view_path",
      mutate: (candidate: Record<string, any>) => { candidate.views[1].path = candidate.views[0].path; }
    },
    {
      code: "duplicate_architecture_view_path",
      mutate: (candidate: Record<string, any>) => { candidate.views[1].path = "Views/Landscape.c4"; }
    },
    {
      code: "architecture_model_path_collision",
      mutate: (candidate: Record<string, any>) => { candidate.provider.config = "Views/Landscape.c4"; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.sourceScopes[0].nodeId = "Repository Title"; }
    },
    {
      code: "unknown_architecture_source_scope",
      mutate: (candidate: Record<string, any>) => { candidate.extractors[0].sourceScopeIds = ["missing-scope"]; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.sourceScopes[0].include = ["!packages/**"]; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.sourceScopes[0].include = ["packages/\0*.ts"]; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.extractors[0].adapter = "python/imports-v1"; }
    },
    {
      code: "architecture_manifest_invalid",
      mutate: (candidate: Record<string, any>) => { candidate.unexpected = true; }
    }
  ];

  for (const testCase of cases) {
    const candidate = structuredClone(manifest);
    testCase.mutate(candidate);
    if ("physicalPath" in testCase && typeof testCase.physicalPath === "string") {
      assert.throws(() => normalizeRelativeDocumentPath(testCase.physicalPath), Error, testCase.physicalPath);
    }
    const result = contract.validateArchitectureManifest(candidate);
    assert.equal(result.ok, false);
    assert.equal(result.issues.some((issue: Record<string, unknown>) => issue.code === testCase.code), true, testCase.code);
  }
  const wildcardGlob = structuredClone(manifest);
  wildcardGlob.sourceScopes[0].include = ["packages/**/test?.ts"];
  assert.equal(contract.validateArchitectureManifest(wildcardGlob).ok, true, "source selectors keep glob metacharacters");
  assert.deepEqual(findPortablePathCollisions(["views/landscape.c4", "Views/Landscape.c4"]), [{
    canonicalPath: "views/landscape.c4",
    paths: ["Views/Landscape.c4", "views/landscape.c4"]
  }]);
});

test("architecture-rot-audit registry formalizes seven categories and fixed anchors", () => {
  const registry = JSON.parse(readFileSync(path.join(architectureRotRoot, "registry/architecture-rot-registry.json"), "utf8")) as Record<string, any>;
  withTempRoot((rootDir) => {
    assert.equal(runJson(rootDir, ["preset", "check", "architecture-rot-audit"]).ok, true);
  });
  assert.equal(registry.records.length, 17);
  assert.deepEqual([...new Set(registry.records.map((record: Record<string, unknown>) => record.category))].sort(), [
    "atomicity-outsourcing",
    "declaration-first-leak",
    "enforcement-gap",
    "imaginary-seam",
    "layer-misalignment",
    "manual-mirror",
    "shallow-slice"
  ]);
  const fixed = registry.records.filter((record: Record<string, unknown>) => record.status === "fixed");
  assert.equal(fixed.length, 3);
  assert.equal(fixed.every((record: Record<string, unknown>) => /^[0-9a-f]{40}$/u.test(String(record.fixedCommit)) && /^PR#[0-9]+$/u.test(String(record.fixPullRequest))), true);
  assert.equal(registry.records.every((record: Record<string, any>) => record.detection.detector === record.id), true);
});

test("architecture-rot-audit check action writes snapshot and non-blocking triage", () => {
  withTempRoot((rootDir) => {
    ensureTestHarnessIdentity(rootDir);
    writeFixture(rootDir, "packages/cli/src/cli/command-spec/command-spec-fixture.ts", [
      "const specs = [",
      "  { \"kind\": \"one\", \"options\": [{\"flag\":\"--mode\",\"description\":\"First mode.\"}], \"parse\": parseOne, \"run\": runOne },",
      "  { \"kind\": \"two\", \"options\": [{\"flag\":\"--mode\",\"description\":\"Second mode.\"}], \"parse\": parseTwo, \"run\": runTwo }",
      "];",
      "void specs;",
      ""
    ].join("\n"));
    writeFixture(rootDir, "packages/kernel/src/local/task-holder-state.ts", [
      "function withTaskHolderMutationLock() {}",
      "withTaskHolderMutationLock();",
      "withTaskHolderMutationLock();",
      ""
    ].join("\n"));
    writeFixture(rootDir, "packages/cli/src/commands/extensions/script-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");

    const checked = runJson(rootDir, [
      "preset", "action", "architecture-rot-audit", "check", "--task", "task-rot", "--allow-scripts"
    ]);
    const snapshotPath = path.join(rootDir, "harness/tasks/task-rot/artifacts/arch-rot.snapshot.json");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, any>;

    assert.equal(checked.ok, true);
    assert.equal(checked.report.status, "passed");
    assert.deepEqual(snapshot.lensA.passes.sort(), ["ROT-002", "ROT-006", "ROT-008"]);
    assert.deepEqual(snapshot.lensA.recurrences, []);
    assert.equal(snapshot.root.sourceHead, "unverified");
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-rot/artifacts/arch-rot.triage.json")), true);
  });
});

test("architecture rot semantics hard-fail recurrence, warn open green, and triage Lens-B", () => {
  const records = [{ id: "ROT-900", status: "fixed" }, { id: "ROT-901", status: "open" }];
  const fixedPass = detectorPolicy.evaluateDetectionResults([records[0]], [{ id: "ROT-900", outcome: "pass", exitCode: 0, evidence: {} }]);
  const recurrence = detectorPolicy.evaluateDetectionResults([records[0]], [{ id: "ROT-900", outcome: "fail", exitCode: 1, evidence: {} }]);
  const openGreen = detectorPolicy.evaluateDetectionResults([records[1]], [{ id: "ROT-901", outcome: "pass", exitCode: 0, evidence: {} }]);
  const candidates = detectorPolicy.buildLensBCandidates(["packages/cli/src/commands/extensions/new-policy.ts"]);

  assert.equal(fixedPass.ok, true);
  assert.equal(fixedPass.items[0].severity, "none");
  assert.equal(recurrence.ok, false);
  assert.equal(recurrence.items[0].snapshotStatus, "recurred");
  assert.equal(recurrence.items[0].severity, "hard-fail");
  assert.equal(openGreen.ok, true);
  assert.equal(openGreen.items[0].severity, "warning");
  assert.match(openGreen.items[0].interpretation, /commit and PR anchors/u);
  assert.equal(candidates.length > 0, true);
  assert.equal(candidates.every((candidate: Record<string, unknown>) => candidate.blocking === false), true);
});

test("ROT-008 pure detector turns a manufactured second sandbox executor red", () => {
  withTempRoot((rootDir) => {
    writeFixture(rootDir, "packages/cli/src/commands/extensions/script-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");
    const green = seedDetectors.runSeedDetector(rootDir, "ROT-008");
    writeFixture(rootDir, "packages/cli/src/commands/extensions/second-executor.ts", "import { spawnSync } from \"node:child_process\";\nvoid spawnSync;\n");
    const recurrence = seedDetectors.runSeedDetector(rootDir, "ROT-008");
    const evaluated = detectorPolicy.evaluateDetectionResults([{ id: "ROT-008", status: "fixed" }], [recurrence]);

    assert.equal(green.outcome, "pass");
    assert.equal(recurrence.outcome, "fail");
    assert.deepEqual(recurrence.evidence.owners.sort(), ["script-executor.ts", "second-executor.ts"]);
    assert.equal(evaluated.ok, false);
    assert.equal(evaluated.hardFailures[0].id, "ROT-008");
  });
});

test("architecture rot snapshots ignore bad inputs and break timestamp ties by taskId", () => {
  withTempRoot((rootDir) => {
    const tasksRoot = path.join(rootDir, "harness/tasks");
    writeFixture(rootDir, "harness/tasks/task_A/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_A")));
    writeFixture(rootDir, "harness/tasks/task_B/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_B")));
    writeFixture(rootDir, "harness/tasks/task_CURRENT/artifacts/arch-rot.snapshot.json", JSON.stringify(snapshotFixture("task_CURRENT", "2099-01-01T00:00:00.000Z")));
    writeFixture(rootDir, "harness/tasks/task_BAD/artifacts/arch-rot.snapshot.json", "{bad json");

    const selected = snapshotHelpers.selectPriorSnapshot(tasksRoot, "task_CURRENT");

    assert.equal(selected.snapshot.coordinationTaskId, "task_B");
    assert.equal(selected.warnings.length, 1);
    assert.match(selected.warnings[0], /Ignored invalid architecture rot snapshot/u);
  });
});

interface TemplateSelection {
  readonly templateRef: string;
  readonly materializeAs: string;
}

interface PresetAsset {
  readonly title: string;
  readonly kind?: string;
  readonly entrypoints?: Record<string, unknown>;
  readonly profiles: ReadonlyArray<{
    readonly templateSelections: ReadonlyArray<TemplateSelection>;
  }>;
}

function assertKnownTemplateRef(catalogIds: ReadonlySet<string>, templateRef: string): void {
  const match = /^template:\/\/(.+)@\d+$/u.exec(templateRef);
  assert.notEqual(match, null, `malformed template ref ${templateRef}`);
  assert.equal(catalogIds.has(match[1]), true, `unknown template ref ${templateRef}`);
}

function assertPresetScriptImportsStayInsidePackage(presetRoot: string, command: string): void {
  const scriptPath = path.resolve(presetRoot, command);
  const source = readFileSync(scriptPath, "utf8");
  const relativeImports = [...source.matchAll(/^\s*import\s+(?:[^"']+\s+from\s+)?["'](\.{1,2}\/[^"']+)["'];?/gmu)]
    .map((match) => match[1]);
  for (const specifier of relativeImports) {
    const target = path.resolve(path.dirname(scriptPath), specifier);
    const relative = path.relative(path.resolve(presetRoot), target);
    assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false, `${command} imports outside preset package: ${specifier}`);
  }
}

function runJson(rootDir: string, args: ReadonlyArray<string>): Record<string, any> {
  const stdout = execFileSync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HARNESS_ACTOR: "agent:package-surface-test",
      HARNESS_DAEMON_MODE: "direct",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
    }
  });
  return unwrapCommandReceipt(JSON.parse(stdout) as Record<string, any>);
}

function withTempRoot<T>(fn: (rootDir: string) => T): T {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-rot-package-"));
  try {
    return fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function writeFixture(rootDir: string, relativePath: string, body: string): void {
  const filePath = path.join(rootDir, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body, "utf8");
}

function snapshotFixture(taskId: string, generatedAt = "2026-07-10T10:00:00.000Z"): Record<string, unknown> {
  return { schema: "architecture-rot-snapshot/v1", generatedAt, coordinationTaskId: taskId, fileHashes: {} };
}
