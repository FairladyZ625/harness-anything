// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, sha256Text } from "../../kernel/src/index.ts";
import { acceptBuiltinVerticalScriptPlan, compilePresetSnapshotUpgrade, compileRepoTaskPackage, compileRepositoryScaffold, compileTaskBootstrap, createCanonicalPresetResolver, installPresetPackage, prepareBuiltinVerticalScriptExecution, runPresetAction, uninstallPresetPackage } from "../src/index.ts";
import { createRuntime, decodePresetPackageV3 } from "../src/preset-resolver.ts";

test("canonical resolver decodes one complete bundled package into a content-addressed snapshot", async () => {
  const fixture = makeFixture();
  try {
    const resolver = createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot });
    const result = await resolver.resolve({ presetId: "standard-task", verticalId: "software/coding", profileId: "baseline", locale: "en-US", purpose: "task-create" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.snapshot.schema, "preset-snapshot/v1");
    assert.equal(result.snapshot.identity.layer, "bundled");
    assert.deepEqual(result.snapshot.profile.completionGateIds, ["ci", "code-doc-reconciliation"]);
    assert.deepEqual(result.snapshot.templates.map((entry) => entry.path), ["task_plan.md", "closeout.md", "artifacts/.gitkeep"]);
    assert.match(result.snapshot.digest, /^sha256:[0-9a-f]{64}$/u);
    assert.equal(result.package, null);
  } finally { fixture.cleanup(); }
});

test("resolver distinguishes unavailable verticals from unavailable presets", async () => {
  const fixture = makeFixture();
  try {
    const resolver = createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot });
    const missingVertical = await resolver.resolve({ presetId: "standard-task", verticalId: "software-coding", locale: "en-US", purpose: "inspect" });
    assert.equal(missingVertical.ok, false);
    if (!missingVertical.ok) {
      assert.equal(missingVertical.error.code, "missing_vertical");
      assert.match(missingVertical.error.hint, /Available vertical ids: software\/coding\./u);
    }

    const missingPreset = await resolver.resolve({ presetId: "not-installed", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.equal(missingPreset.ok, false);
    if (!missingPreset.ok) assert.equal(missingPreset.error.code, "preset_not_found");
  } finally { fixture.cleanup(); }
});

test("resolver rejects a production-installed preset outside the canonical vertical", async () => {
  const fixture = makeFixture(), sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source");
  try {
    writePackage(sourceRoot, "ops-other", { vertical: "ops/other" }); installPresetPackage({ source: path.join(sourceRoot, "ops-other"), userRoot: fixture.userRoot });
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "ops-other", verticalId: "ops/other", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "missing_vertical");
      assert.match(result.error.hint, /Available vertical ids: software\/coding\./u);
    }
  } finally { fixture.cleanup(); }
});

test("an invalid user package shadows the bundled package without fallback", async () => {
  const fixture = makeFixture();
  try {
    const digest = "d".repeat(64), objectRoot = path.join(fixture.userRoot, "preset-objects", digest);
    write(path.join(objectRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3" }));
    write(path.join(fixture.userRoot, "active/standard-task.json"), JSON.stringify({ schema: "preset-active-pointer/v1", presetId: "standard-task", verticalId: "software/coding", digest }));
    const resolver = createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }), listed = await resolver.list({ verticalId: "software/coding" }), result = await resolver.resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.deepEqual(listed.map(({ id, layer, validity, errorCode, missingProviderIds }) => ({ id, layer, validity, errorCode, missingProviderIds })), [{ id: "standard-task", layer: "user", validity: "blocked", errorCode: "shadow_invalid", missingProviderIds: [] }]); assert.match(listed[0]?.nextAction ?? "", /repair.*shadow_invalid.*ha preset list/iu);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("a symbolic-link active pointer blocks the bundled package", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const fixture = makeFixture();
  try {
    write(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), JSON.stringify({ schema: "preset-active-pointer/v1" })); mkdirSync(path.join(fixture.userRoot, "active"), { recursive: true }); symlinkSync(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), path.join(fixture.userRoot, "active/standard-task.json"));
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("a symbolic-link pointer blocks the same preset id in every vertical", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "other-task", { vertical: "other/vertical" }); write(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), "{}"); mkdirSync(path.join(fixture.userRoot, "active"), { recursive: true }); symlinkSync(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), path.join(fixture.userRoot, "active/other-task.json"));
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "other-task", verticalId: "other/vertical", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("a symbolic-link active inventory root fails closed", async () => {
  const fixture = makeFixture(), outsideActive = path.join(path.dirname(fixture.userRoot), "outside-active");
  try {
    mkdirSync(outsideActive, { recursive: true }); rmSync(path.join(fixture.userRoot, "active"), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); symlinkSync(outsideActive, path.join(fixture.userRoot, "active"), process.platform === "win32" ? "junction" : "dir");
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "invalid_pointer_root");
    assert.throws(() => installPresetPackage({ source: path.join(fixture.bundledRoot, "standard-task"), userRoot: fixture.userRoot }), (error: unknown) => (error as { code?: string }).code === "invalid_install_root"); assert.equal(existsSync(path.join(outsideActive, "standard-task.json")), false);
  } finally { fixture.cleanup(); }
});

test("an invalid pointer preserves its declared vertical and blocks that bundled shadow", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "other-task", { vertical: "other/vertical" }); const digest = "e".repeat(64);
    write(path.join(fixture.userRoot, "active/other-task.json"), JSON.stringify({ schema: "preset-active-pointer/v1", presetId: "other-task", verticalId: "other/vertical", digest }));
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "other-task", verticalId: "other/vertical", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("package decoder rejects symlinks and missing PRESET or script files", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, () => {
  const fixture = makeFixture();
  try {
    const complete = path.join(fixture.bundledRoot, "standard-task"), missingDocument = path.join(path.dirname(fixture.bundledRoot), "missing-document"), missingScript = path.join(path.dirname(fixture.bundledRoot), "missing-script");
    symlinkSync("preset.json", path.join(complete, "manifest-link.json")); assert.throws(() => decodePresetPackageV3(complete), (error: unknown) => (error as { code?: string }).code === "symlink_forbidden");
    write(path.join(missingDocument, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3" })); assert.throws(() => decodePresetPackageV3(missingDocument), (error: unknown) => (error as { code?: string }).code === "missing_preset_document");
    write(path.join(missingScript, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "scripted", title: "Scripted", vertical: "software/coding", version: "3.0.0", kind: "process-action", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], entrypoints: { run: { type: "script", intent: "Run", inputs: [], requires: [], produces: [], sideEffects: [], command: "scripts/run.mjs" } }, profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" })); write(path.join(missingScript, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: Script\nwhenToUse: Run it.\n---\n# Script\n"); assert.throws(() => decodePresetPackageV3(missingScript), (error: unknown) => (error as { code?: string }).code === "missing_script");
  } finally { fixture.cleanup(); }
});

test("resolver rejects extends cycles before producing a snapshot", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "cycle-a", { extends: "cycle-b" }); writePackage(fixture.bundledRoot, "cycle-b", { extends: "cycle-a" });
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "cycle-a", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "extends_cycle");
  } finally { fixture.cleanup(); }
});

test("an inherited entrypoint remains bound to the package that declared its script", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "script-parent", { kind: "process-action", entrypoints: { run: { type: "script", intent: "Run parent", inputs: [], requires: [], produces: [], sideEffects: [], command: "scripts/run.mjs" } } }); write(path.join(fixture.bundledRoot, "script-parent/scripts/run.mjs"), "export {};\n"); writePackage(fixture.bundledRoot, "script-child", { extends: "script-parent" });
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "script-child", verticalId: "software/coding", locale: "en-US", purpose: "script-run", entrypoint: "run" });
    assert.equal(result.ok, true); if (result.ok) { const parentDigest = decodePresetPackageV3(path.join(fixture.bundledRoot, "script-parent")).packageDigest; assert.match(result.snapshot.entrypoints.run!.commandSha256, /^[0-9a-f]{64}$/u); assert.equal(result.package?.packageDigest, parentDigest); assert.notEqual(result.snapshot.provenance.packageSha256, parentDigest); }
  } finally { fixture.cleanup(); }
});

test("resolver rejects a package outside the kernel version range", async () => {
  const fixture = makeFixture();
  try { writePackage(fixture.bundledRoot, "future", { kernelVersionRange: { min: "2.0.0" } }); const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot, kernelVersion: "1.0.0" }).resolve({ presetId: "future", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "incompatible_kernel"); } finally { fixture.cleanup(); }
});

test("resolver reports every missing required capability with catalog recovery fields", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "needs-provider", { capabilityImports: [{ id: "policy:missing-b/v1", kind: "command", version: "1", required: true }, { id: "policy:missing-a/v1", kind: "command", version: "1", required: true }] });
    const resolver = createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }), result = await resolver.resolve({ presetId: "needs-provider", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }), listed = (await resolver.list({ verticalId: "software/coding" })).find(({ id }) => id === "needs-provider");
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "missing_provider"); assert.deepEqual(listed?.missingProviderIds, ["policy:missing-a/v1", "policy:missing-b/v1"]); assert.match(listed?.nextAction ?? "", /provides policy:missing-a\/v1, policy:missing-b\/v1.*ha preset list/iu);
  } finally { fixture.cleanup(); }
});

test("entrypoint capability matching is exact and template catalog paths cannot escape assets", async () => {
  const fixture = makeFixture();
  try {
    write(path.join(fixture.assetsRoot, "capabilities.json"), JSON.stringify({ schema: "preset-capabilities/v1", providers: [{ id: "cap:run/v1", kind: "checker", version: "1" }] })); writePackage(fixture.bundledRoot, "scripted", { kind: "process-action", entrypoints: { run: { type: "script", intent: "Run", inputs: [], requires: [{ id: "cap:run/v1", kind: "command", version: "1" }], produces: [], sideEffects: [], command: "run.mjs" } } }); write(path.join(fixture.bundledRoot, "scripted/run.mjs"), "export {};\n");
    const mismatched = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "scripted", verticalId: "software/coding", locale: "en-US", purpose: "script-run", entrypoint: "run" }); assert.equal(mismatched.ok, false); if (!mismatched.ok) assert.equal(mismatched.error.code, "missing_provider");
    write(path.join(fixture.assetsRoot, "template-catalog.json"), JSON.stringify(templateCatalog([{ id: "planning/task-plan", version: "1", documentKind: "task-plan", slot: "task.plan", materializeAs: "task_plan.md", frontmatterSchema: "task-package/v2", requiredAnchors: [], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: [], bodyPath: "../escaped.md" }] }]))); write(path.join(path.dirname(fixture.assetsRoot), "escaped.md"), "# Escaped\n");
    const escaped = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }); assert.equal(escaped.ok, false); if (!escaped.ok) assert.equal(escaped.error.code, "missing_template");
  } finally { fixture.cleanup(); }
});

test("whole-package install publishes only the old or new active pointer", async () => {
  const fixture = makeFixture(), sourceOld = path.join(path.dirname(fixture.bundledRoot), "source-old"), sourceNew = path.join(path.dirname(fixture.bundledRoot), "source-new");
  try {
    writePackage(sourceOld, "standard-task", { version: "3.1.0" }); writePackage(sourceNew, "standard-task", { version: "3.2.0" });
    installPresetPackage({ source: path.join(sourceOld, "standard-task"), userRoot: fixture.userRoot });
    const version = async () => { const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }); assert.equal(result.ok, true); return result.ok ? result.snapshot.identity.version : ""; };
    assert.equal(await version(), "3.1.0");
    assert.throws(() => installPresetPackage({ source: path.join(sourceNew, "standard-task"), userRoot: fixture.userRoot, killpoint: (point) => { if (point === "after-object") throw new Error("kill"); } })); assert.equal(await version(), "3.1.0");
    assert.throws(() => installPresetPackage({ source: path.join(sourceNew, "standard-task"), userRoot: fixture.userRoot, killpoint: (point) => { if (point === "after-pointer") throw new Error("kill"); } })); assert.equal(await version(), "3.2.0");
    uninstallPresetPackage({ presetId: "standard-task", userRoot: fixture.userRoot }); assert.equal(await version(), "3.0.0");
  } finally { fixture.cleanup(); }
});

test("all twelve bundled packages resolve through one valid catalog", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-builtins-"));
  try {
    const resolver = createCanonicalPresetResolver({ userRoot: root }), common = { verticalId: "software/coding", profileId: "baseline", locale: "en-US", purpose: "task-create" } as const, listed = await resolver.list({ verticalId: "software/coding" });
    assert.deepEqual(listed.map(({ id, validity, errorCode }) => ({ id, validity, errorCode })), [
      { id: "architecture-rot-audit", validity: "valid", errorCode: undefined },
      { id: "code-impact-analysis", validity: "valid", errorCode: undefined },
      { id: "create-milestone", validity: "valid", errorCode: undefined },
      { id: "decision-conformance", validity: "valid", errorCode: undefined },
      { id: "docs-task", validity: "valid", errorCode: undefined },
      { id: "github-issue-repair", validity: "valid", errorCode: undefined },
      { id: "legacy-migration", validity: "valid", errorCode: undefined },
      { id: "milestone-closeout", validity: "valid", errorCode: undefined },
      { id: "module", validity: "valid", errorCode: undefined },
      { id: "standard-task", validity: "valid", errorCode: undefined },
      { id: "subtask-expansion", validity: "valid", errorCode: undefined },
      { id: "worker-dispatch", validity: "valid", errorCode: undefined }
    ]);
    const standard = await resolver.resolve({ ...common, presetId: "standard-task" }), milestone = await resolver.resolve({ ...common, presetId: "create-milestone" });
    assert.equal(standard.ok, true); assert.equal(milestone.ok, true); if (!standard.ok || !milestone.ok) return;
    assert.deepEqual(standard.snapshot.templates.map(({ slot, path: target, templateRef }) => ({ slot, target, templateRef })), [
      { slot: "task.plan", target: "task_plan.md", templateRef: "template://planning/task-plan@1" }, { slot: "task.closeout", target: "closeout.md", templateRef: "template://planning/closeout@1" }, { slot: "task.artifacts.keep", target: "artifacts/.gitkeep", templateRef: "template://planning/keep-file@1" }
    ]);
    assert.deepEqual(milestone.snapshot.templates.map(({ slot, path: target, templateRef }) => ({ slot, target, templateRef })), [
      { slot: "task.plan", target: "task_plan.md", templateRef: "template://planning/milestone-task-plan@1" }, { slot: "task.closeout", target: "closeout.md", templateRef: "template://planning/closeout@1" }, { slot: "task.artifacts.keep", target: "artifacts/.gitkeep", templateRef: "template://planning/keep-file@1" }
    ]);
    const matrix = [
      ["standard-task", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["docs-task", "task-package-artifact", [], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["code-impact-analysis", "task-package-artifact", [], ["task.plan", "task.closeout", "task.artifacts.keep", "task.code.impact.analysis"]],
      ["worker-dispatch", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep", "task.worker.flow"]],
      ["architecture-rot-audit", "task-package-artifact", [], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["github-issue-repair", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["legacy-migration", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["create-milestone", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["milestone-closeout", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["decision-conformance", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]],
      ["module", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep", "module.plan", "module.brief", "module.session.prompt"]],
      ["subtask-expansion", "task-package-artifact", [], ["task.plan", "task.closeout", "task.artifacts.keep"]]
    ] as const;
    for (const [presetId, outputShape, completionGateIds, slots] of matrix) { const result = await resolver.resolve({ ...common, presetId }); assert.equal(result.ok, true, presetId); if (result.ok) assert.deepEqual({ outputShape: result.snapshot.profile.outputShape, completionGateIds: result.snapshot.profile.completionGateIds, slots: result.snapshot.templates.map(({ slot }) => slot), entrypoints: Object.keys(result.snapshot.entrypoints) }, { outputShape, completionGateIds, slots, entrypoints: [] }); }
    for (const presetId of ["module", "subtask-expansion"]) { const result = await resolver.resolve({ ...common, presetId }); assert.equal(result.ok, true, presetId); }
    assert.equal(existsSync(new URL("../assets/software-coding/presets/reference-task/", import.meta.url)), false); assert.equal(existsSync(new URL("../assets/software-coding/presets/long-running-task/", import.meta.url)), false);
    const noEntrypoint = await resolver.resolve({ presetId: "create-milestone", verticalId: "software/coding", locale: "en-US", purpose: "script-run", entrypoint: "run" }); assert.equal(noEntrypoint.ok, false); if (!noEntrypoint.ok) assert.equal(noEntrypoint.error.code, "entrypoint_not_found");
    const auditEntrypoint = await resolver.resolve({ presetId: "architecture-rot-audit", verticalId: "software/coding", locale: "en-US", purpose: "script-run", entrypoint: "run" }); assert.equal(auditEntrypoint.ok, false); if (!auditEntrypoint.ok) assert.equal(auditEntrypoint.error.code, "entrypoint_not_found");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const sample of [
  { presetId: "standard-task", gates: ["ci", "code-doc-reconciliation"], addedPath: null, taskClass: undefined },
  { presetId: "docs-task", gates: [], addedPath: null },
  { presetId: "code-impact-analysis", gates: [], addedPath: "code-impact-analysis.md" },
  { presetId: "worker-dispatch", gates: ["ci", "code-doc-reconciliation"], addedPath: "worker-flow.md" },
  { presetId: "architecture-rot-audit", gates: [], addedPath: null },
  { presetId: "github-issue-repair", gates: ["ci", "code-doc-reconciliation"], addedPath: null },
  { presetId: "create-milestone", gates: ["ci", "code-doc-reconciliation"], addedPath: null, taskClass: "milestone" },
  { presetId: "milestone-closeout", gates: ["ci", "code-doc-reconciliation"], addedPath: null },
  { presetId: "decision-conformance", gates: ["ci", "code-doc-reconciliation"], addedPath: null }
] as const) test(`${sample.presetId} dry-run claims equal canonical materialization`, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), `ha-preset-${sample.presetId}-`)), userRoot = path.join(rootDir, ".harness/presets");
  try {
    git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Preset Test"); git(rootDir, "config", "user.email", "preset@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const preview = compileTaskBootstrap({ userRoot, verticalId: "software/coding", profileId: "baseline", locale: "en-US", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", taskId: `task-${sample.presetId}`, title: sample.presetId, presetId: sample.presetId, ...(sample.taskClass ? { taskClass: sample.taskClass } : {}), workspaceRevision: 1, eventId: `event-${sample.presetId}`, opId: `op-${sample.presetId}` });
    const dryRunPaths = preview.documents.map(({ path: target }) => target), claimPaths = preview.event.payload.initialDocumentClaims.map(({ path: target }) => target); assert.deepEqual(claimPaths, dryRunPaths); assert.deepEqual(preview.snapshot.profile.completionGateIds, sample.gates); assert.equal(sample.addedPath === null ? preview.documents.length === 6 : preview.documents.some(({ relativePath }) => relativePath === sample.addedPath), true);
    const store = makeTaskEventStore({ repoId: `preset-${sample.presetId}`, rootDir }); store.append({ event: preview.event, plan: preview.plan, blobs: preview.blobs }); for (const document of preview.documents) assert.equal(readFileSync(path.join(rootDir, "harness", document.path), "utf8"), document.body); rmSync(path.join(rootDir, "harness", preview.packagePath), { recursive: true, force: true }); const restored = store.materialize(); assert.deepEqual(restored.changed, [...dryRunPaths].sort((left, right) => left.localeCompare(right))); for (const document of preview.documents) assert.equal(readFileSync(path.join(rootDir, "harness", document.path), "utf8"), document.body);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("module locale, required anchors, and body digests close through the canonical catalog", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-module-catalog-")), assetsRoot = path.join(root, "assets");
  try {
    cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, { recursive: true });
    const runtime = createRuntime({ bundledRoot: path.join(assetsRoot, "presets"), assetsRoot, userRoot: path.join(root, "user") });
    for (const locale of ["en-US", "zh-CN"] as const) { const resolved = runtime.resolveInternal({ presetId: "module", verticalId: "software/coding", profileId: "baseline", locale, purpose: "task-create" }), increments = resolved.snapshot.templates.filter(({ slot }) => slot.startsWith("module.")); assert.equal(increments.length, 3); for (const template of increments) { const document = resolved.documents.find(({ slot }) => slot === template.slot); assert.equal(template.locale, locale); assert.ok(template.requiredAnchors.length >= 2); assert.equal(template.content.sha256, sha256Text(document?.body ?? "")); for (const anchor of template.requiredAnchors) assert.match(document?.body ?? "", new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u")); } }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("project task scaffold replaces and adds prose while base ownership, anchors, and portable paths fail closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-task-scaffold-")), scaffold = path.join(root, "governance/task-scaffold.json"), template = "# Project Plan\n\n## Brief\n\nB\n\n## Goal\n\nG\n\n## Context\n\nC\n\n## Constraints\n\nC\n\n## Checkpoint\n\nC\n\n## CI/Gate Authority Stop Condition\n\nS\n\n## Implementation Plan\n\nP\n\n## Verification\n\nV\n";
  try {
    write(path.join(root, "templates/plan.md"), template); write(path.join(root, "templates/notes.md"), "# Notes\n\n## Project Notes\n\nCustom.\n"); const valid = { schema: "task-scaffold/v1", replaceTemplate: [{ slot: "task.plan", template: "templates/plan.md" }], addDocument: [{ slot: "project.notes", path: "notes.md", template: "templates/notes.md", requiredAnchors: ["## Project Notes"] }] }; write(scaffold, JSON.stringify(valid));
    const resolve = () => createCanonicalPresetResolver({ userRoot: path.join(root, "user"), projectRoot: root, projectScaffold: scaffold }).resolve({ presetId: "code-impact-analysis", verticalId: "software/coding", profileId: "baseline", locale: "en-US", purpose: "task-create" }); const applied = await resolve(); assert.equal(applied.ok, true); if (applied.ok) { assert.equal(applied.snapshot.templates.length, 5); assert.equal(applied.snapshot.templates[0]?.owner, "doc-sync"); assert.equal(applied.snapshot.templates[0]?.templateRef, "project://templates/plan.md"); assert.deepEqual(applied.snapshot.templates.slice(-2).map(({ slot }) => slot), ["project.notes", "task.code.impact.analysis"]); assert.match(String(applied.snapshot.scaffold.overlayDigest), /^sha256:/u); }
    write(scaffold, JSON.stringify({ ...valid, replaceTemplate: [{ ...valid.replaceTemplate[0], owner: "machine" }] })); let rejected = await resolve(); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "invalid_task_scaffold");
    write(path.join(root, "templates/plan.md"), "# Missing anchors\n"); write(scaffold, JSON.stringify(valid)); rejected = await resolve(); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "required_anchor");
    write(path.join(root, "templates/plan.md"), template); write(scaffold, JSON.stringify({ ...valid, addDocument: [{ ...valid.addDocument[0], path: "TASK_PLAN.md" }] })); rejected = await resolve(); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "reserved_path");
    write(scaffold, JSON.stringify({ ...valid, addDocument: [{ ...valid.addDocument[0], path: "notes.json" }] })); rejected = await resolve(); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "invalid_task_scaffold");
    write(scaffold, JSON.stringify({ ...valid, deleteDocument: ["task.plan"] })); rejected = await resolve(); assert.equal(rejected.ok, false); if (!rejected.ok) assert.equal(rejected.error.code, "invalid_task_scaffold");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("task and repository overlays share replace/add validation while keeping separate schemas and slots", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-repository-scaffold-")), authoredRoot = path.join(root, "harness"), scaffold = path.join(authoredRoot, "governance/repository-scaffold.json");
  try {
    write(path.join(authoredRoot, "templates/architecture.md"), "# Architecture\n\n## Purpose\n\nProject architecture entry.\n\n## Opt-in Boundary\n\nNo model is enabled by init.\n");
    write(path.join(authoredRoot, "templates/project.md"), "# Project Context\n\n## Project Notes\n\nCustom.\n");
    const valid = { schema: "repository-scaffold/v1", replaceTemplate: [{ slot: "repository.context.architecture", template: "templates/architecture.md" }], addDocument: [{ slot: "repository.context.project", path: "harness/context/project.md", template: "templates/project.md", requiredAnchors: ["## Project Notes"] }] };
    write(scaffold, JSON.stringify(valid));
    const compile = () => compileRepositoryScaffold({ rootDir: root, verticalId: "software/coding", locale: "en-US", projectScaffold: scaffold });
    const applied = compile(); assert.equal(applied.documents.length, 16); assert.deepEqual(applied.documents.map(({ disposition }) => disposition), Array(16).fill("created")); assert.equal(applied.documents.find(({ slot }) => slot === "repository.context.architecture")?.templateRef, "project://templates/architecture.md"); assert.deepEqual(applied.documents.filter(({ slot }) => slot.startsWith("repository.standard.")).map(({ path: target }) => target), ["harness/governance/standards/README.md", "harness/governance/standards/repository-governance.md", "harness/governance/standards/decision-writing.md"]); assert.match(String(applied.projectOverlayDigest), /^sha256:/u); assert.match(applied.baseScaffoldDigest, /^sha256:/u);
    write(scaffold, JSON.stringify({ ...valid, schema: "task-scaffold/v1" })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "invalid_repository_scaffold");
    write(scaffold, JSON.stringify({ ...valid, replaceTemplate: [{ ...valid.replaceTemplate[0], owner: "machine" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "invalid_repository_scaffold");
    write(scaffold, JSON.stringify({ ...valid, replaceTemplate: [{ slot: "repository.walls.manifest", template: "templates/architecture.md" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "invalid_repository_scaffold");
    write(scaffold, JSON.stringify({ ...valid, addDocument: [{ ...valid.addDocument[0], path: "harness/context/architecture/README.md" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "reserved_path");
    write(scaffold, JSON.stringify({ ...valid, addDocument: [{ ...valid.addDocument[0], path: "harness/standards/README.md" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "reserved_path");
    write(scaffold, JSON.stringify({ ...valid, addDocument: [{ ...valid.addDocument[0], path: "harness/governance/standards/project.md" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "reserved_path");
    write(path.join(root, "outside/architecture.md"), "# Architecture\n\n## Purpose\n\nOutside.\n\n## Opt-in Boundary\n\nNo model.\n"); symlinkSync(path.join(root, "outside"), path.join(authoredRoot, "linked")); write(scaffold, JSON.stringify({ ...valid, replaceTemplate: [{ slot: "repository.context.architecture", template: "linked/architecture.md" }] })); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "invalid_repository_scaffold");
    write(path.join(authoredRoot, "templates/architecture.md"), "# Missing anchors\n"); write(scaffold, JSON.stringify(valid)); assert.throws(compile, (error: unknown) => (error as { code?: string }).code === "required_anchor");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repository init plan consumes the declaration and composes package-local AGENTS layers", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repository-plan-"));
  try {
    const vertical = JSON.parse(readFileSync(new URL("../assets/software-coding/vertical.json", import.meta.url), "utf8")) as { repositoryScaffold: { seededDocs: Array<{ slot: string }>; agentsEntry: { repoSpecificsAnchor: string } } }, expectedSlots = [...vertical.repositoryScaffold.seededDocs.map(({ slot }) => slot), "repository.agent.entry"].sort();
    for (const locale of ["en-US", "zh-CN"]) { const plan = compileRepositoryScaffold({ rootDir, verticalId: "software/coding", locale }), agents = plan.documents.find(({ slot }) => slot === "repository.agent.entry"); assert.deepEqual(plan.documents.map(({ slot }) => slot).sort(), expectedSlots); assert.equal(agents?.path, "AGENTS.md"); assert.match(agents?.body ?? "", /## Context Loading/u); assert.match(agents?.body ?? "", /## Harness CLI \(software\/coding\)/u); assert.match(agents?.body ?? "", /## Repository Specifics/u); assert.equal(agents?.requiredAnchors.includes(vertical.repositoryScaffold.agentsEntry.repoSpecificsAnchor), true); assert.equal(plan.documents.some(({ path: target }) => target.includes("harness/standards/") || target.includes("architecture-manifest.json")), false); }
    assert.throws(() => compileRepositoryScaffold({ rootDir, verticalId: "software-coding", locale: "en-US" }), (error: unknown) => (error as { code?: string; message?: string }).code === "missing_vertical" && /Available vertical ids: software\/coding\./u.test((error as { message?: string }).message ?? ""));
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("generic list, inspect, check, install, and uninstall actions share the canonical inventory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-actions-")), sourceRoot = path.join(rootDir, "source");
  try {
    const listed = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string; title: string; description: string; verticalId: string; layer: string; source: string; validity: string; version?: string; kind?: string; defaultProfile?: string; entrypoints?: string[]; issues: unknown[]; issueCount?: number }>; assert.equal(listed.length, 12); const standardRow = listed.find(({ id }) => id === "standard-task")!; assert.deepEqual({ ...standardRow, source: path.basename(standardRow.source) }, { id: "standard-task", title: "Standard Task", description: "Create the standard planning, facts, and closeout scaffold for general software work.", verticalId: "software/coding", layer: "bundled", source: "standard-task", validity: "valid", version: "3.0.0", kind: "template-content", defaultProfile: "baseline", entrypoints: [], issues: [], issueCount: 0 });
    const inspected = await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "standard-task" } }) as { manifest: { id: string }; snapshot: { digest: string }; entrypoints: string[] }; assert.equal(inspected.manifest.id, "standard-task"); assert.deepEqual(inspected.entrypoints, []); assert.match(inspected.snapshot.digest, /^sha256:/u);
    assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task" } }), { valid: true, digest: inspected.snapshot.digest });
    const stale = `sha256:${"0".repeat(64)}`; assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task", snapshotDigest: stale } }), { valid: false, code: "snapshot_mismatch", actualDigest: stale, expectedDigest: inspected.snapshot.digest, nextAction: "Run ha preset upgrade <task-id>." }); assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task", snapshotDigest: inspected.snapshot.digest } }), { valid: true, digest: inspected.snapshot.digest });
    writePackage(sourceRoot, "user-task", { version: "3.4.0" }); const installed = await runPresetAction({ rootDir, action: { kind: "preset-install", packageSource: path.join(sourceRoot, "user-task") } }) as { presetId: string; mode: string; changed: boolean; issues: unknown[] }; assert.deepEqual({ presetId: installed.presetId, mode: installed.mode, changed: installed.changed, issues: installed.issues }, { presetId: "user-task", mode: "apply", changed: true, issues: [] }); assert.equal((await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "user-task" } }) as { snapshot: { identity: { layer: string } } }).snapshot.identity.layer, "user"); assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-uninstall", presetId: "user-task" } }), { presetId: "user-task", mode: "apply", active: true, removed: true });
    await assert.rejects(runPresetAction({ rootDir, action: { kind: "preset-unknown", presetId: "standard-task" } }), (error: unknown) => (error as { code?: string }).code === "unsupported_command");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("builtin vertical validation is closed while custom verticals stay explicitly unavailable", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-validate-"));
  try {
    const builtin = await runPresetAction({ rootDir, action: { kind: "vertical-validate", verticalSource: "software/coding" } }) as { schema: string; source: string; available: boolean; valid: boolean; vertical?: { id: string }; issues: unknown[] };
    assert.deepEqual(builtin, { schema: "vertical-validate-report/v1", source: "builtin:software/coding", available: true, valid: true, vertical: { id: "software/coding", title: "Software Coding", version: "1.3.0" }, issues: [] });
    const custom = await runPresetAction({ rootDir, action: { kind: "vertical-validate", verticalSource: "./custom-vertical.json" } }) as { available: boolean; valid: boolean; issues: Array<{ code: string }> };
    assert.equal(custom.available, false); assert.equal(custom.valid, false); assert.deepEqual(custom.issues.map(({ code }) => code), ["custom_vertical_unavailable"]);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("software coding declaration closes lifecycle, repository, projection, and discovery assets", () => {
  const vertical = JSON.parse(readFileSync(new URL("../assets/software-coding/vertical.json", import.meta.url), "utf8")) as { entityFieldExtensions?: Array<{ field: string; values: string[] }>; entityKinds: Array<{ id: string; packageKind?: string; schemaRef?: string }>; contractEntityKinds: string[]; packageScaffolds: Array<{ entityKind: string }>; repositoryScaffold: { entityRoots: Array<{ entityKind: string; path: string; create: string }>; dirs: Array<{ path: string; create: string }>; agentsEntry?: { baseRef: string; overlayRef: string; materializeAs: string } }; scripts: Array<{ id: string; command: string }>; projectionSchemas: Array<{ id: string; schemaRef: string }> };
  assert.deepEqual(vertical.entityFieldExtensions?.map(({ field, values }) => ({ field, values })), [{ field: "taskClass", values: ["milestone", "epic"] }]);
  assert.deepEqual(vertical.entityKinds, [{ id: "task", entityType: "lifecycle", packageKind: "task-package/v2", contractEntity: true }, { id: "decision", entityType: "lifecycle", packageKind: "decision-event/v1", contractEntity: true }, { id: "fact", entityType: "schema", schemaRef: "schema://fact-event", contractEntity: true }]);
  assert.deepEqual(vertical.contractEntityKinds, ["task", "decision", "fact"]); assert.deepEqual(vertical.packageScaffolds.map(({ entityKind }) => entityKind), ["task", "decision"]);
  assert.deepEqual(vertical.repositoryScaffold.entityRoots, [{ entityKind: "task", path: "{{paths.tasksRoot}}", create: "init" }, { entityKind: "decision", path: "{{paths.decisionsRoot}}", create: "lazy" }]);
  assert.deepEqual(vertical.repositoryScaffold.dirs, [{ path: "{{paths.standardsRoot}}", create: "init" }, { path: "{{paths.contextRoot}}", create: "init" }, { path: "{{paths.contextRoot}}/architecture", create: "init" }, { path: "{{paths.adrRoot}}", create: "init" }, { path: "{{paths.milestonesRoot}}", create: "init" }, { path: "{{paths.sessionsRoot}}", create: "lazy" }]);
  assert.deepEqual(vertical.repositoryScaffold.agentsEntry, { materializeAs: "{{paths.rootDir}}/AGENTS.md", localePolicy: { prefer: "project", fallback: "en-US" }, baseRef: "template://repository/agent-base@1", overlayRef: "template://repository/agent-overlay@1", repoSpecificsAnchor: "## Repository Specifics" });
  assert.deepEqual(vertical.scripts.map(({ id }) => id), ["vertical:software-coding:architecture-init", "vertical:software-coding:architecture-snapshot", "vertical:software-coding:architecture-check", "vertical:software-coding:repository-audit", "vertical:software-coding:adr-seed", "vertical:software-coding:adr-render", "vertical:software-coding:decision-conformance"]); assert.ok(vertical.scripts.every(({ command }) => command.startsWith("scripts/") && command.endsWith(".mjs")));
  assert.deepEqual(vertical.projectionSchemas, [{ id: "task-frontmatter", schemaRef: "schema://task-frontmatter" }, { id: "decision-frontmatter", schemaRef: "schema://decision-frontmatter" }, { id: "fact-event", schemaRef: "schema://fact-event" }]);
  const catalog = JSON.parse(readFileSync(new URL("../assets/software-coding/template-catalog.json", import.meta.url), "utf8")) as { documents: Array<{ id: string; materializeAs: string }> }, ids = new Set(catalog.documents.map(({ id }) => id));
  for (const id of ["repository/agent-base", "repository/agent-overlay", "repository/adr-template", "repository/architecture-manifest", "repository/architecture-likec4-config", "repository/architecture-likec4-model", "repository/architecture-likec4-specification", "repository/architecture-likec4-view-landscape", "repository/architecture-likec4-view-write-path", "repository/architecture-likec4-view-runtime"]) assert.equal(ids.has(id), true, id);
  assert.equal(catalog.documents.some(({ materializeAs }) => materializeAs.includes("{{paths.authoredRoot}}/standards") || materializeAs.startsWith("harness/standards")), false);
});

test("builtin script preparation binds one declared command and rejects undeclared or out-of-scope plans", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-prepare-")); write(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n");
  try {
    const action = { schema: "vertical-script-action/v1", kind: "script-run", scriptId: "vertical:software-coding:adr-seed", taskId: null, inputs: { locale: "zh-CN" }, dryRun: true } as const, prepared = prepareBuiltinVerticalScriptExecution({ rootDir, action, commitSha: "a".repeat(40) });
    assert.equal(path.basename(prepared.command), "adr-seed.mjs"); assert.equal(prepared.readRoots.some((root) => root.endsWith(path.join("packages", "preset", "assets", "software-coding"))), true); assert.deepEqual(prepared.writePatterns, ["decisions/adrs/**"]); assert.deepEqual(prepared.producePatterns, ["decisions/adrs/README.md", "decisions/adrs/0000-template.md"]);
    const accepted = acceptBuiltinVerticalScriptPlan(prepared, JSON.stringify({ schema: "vertical-script-plan/v1", scriptId: action.scriptId, ok: true, status: "planned", report: {}, warnings: [], changes: [{ path: "decisions/adrs/0000-template.md", body: "# ADR\n", mediaType: "text/markdown", disposition: "create" }] })); assert.equal(accepted.changes.length, 1);
    assert.throws(() => acceptBuiltinVerticalScriptPlan(prepared, JSON.stringify({ ...accepted, changes: [{ ...accepted.changes[0], path: "tasks/escape.md" }] })), (error: unknown) => (error as { code?: string }).code === "script_scope_violation");
    assert.throws(() => prepareBuiltinVerticalScriptExecution({ rootDir, action: { ...action, scriptId: "vertical:software-coding:not-declared" }, commitSha: "a".repeat(40) }), (error: unknown) => (error as { code?: string }).code === "script_not_found");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("all seven declared builtin script assets emit accepted deterministic plans", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-script-assets-")), taskId = "task_01KZXSYDTJ3K1YE88294X33QNW", commitSha = "b".repeat(40); write(path.join(rootDir, "harness/harness.yaml"), "layout:\n  adrRoot: harness/decisions/adrs\n"); write(path.join(rootDir, `harness/tasks/${taskId}/INDEX.md`), `---\nschema: task-package/v2\ntask_id: ${taskId}\n---\n# Script task\n`); write(path.join(rootDir, "harness/decisions/decision-dec_SCRIPT/decision.md"), "---\ndecision_id: dec_SCRIPT\nstate: active\n---\n# Script execution decision\n");
  try {
    const execute = (name: string, task: string | null = null, inputs: Record<string, string> = {}) => { const action = { schema: "vertical-script-action/v1", kind: "script-run", scriptId: `vertical:software-coding:${name}`, taskId: task, inputs, dryRun: true } as const, prepared = prepareBuiltinVerticalScriptExecution({ rootDir, action, commitSha }), frame = execFileSync(process.execPath, ["--permission", ...prepared.readRoots.map((root) => `--allow-fs-read=${root}/*`), prepared.command, prepared.contextArgument], { cwd: rootDir, encoding: "utf8" }); return acceptBuiltinVerticalScriptPlan(prepared, frame); }, materialize = (plan: ReturnType<typeof execute>) => { for (const change of plan.changes) write(path.join(rootDir, "harness", change.path), change.body); };
    const init = execute("architecture-init"); assert.equal(init.changes.length, 7); assert.equal(existsSync(path.join(rootDir, "harness/context/architecture/architecture-manifest.json")), false); materialize(init);
    const snapshot = execute("architecture-snapshot", taskId); assert.deepEqual(snapshot.changes.map(({ path: target }) => target), [`tasks/${taskId}/artifacts/architecture/code-facts.json`]); materialize(snapshot);
    const check = execute("architecture-check", taskId); assert.equal(check.status, "fresh"); assert.deepEqual(check.changes, []);
    const audit = execute("repository-audit"); assert.equal(audit.status, "conformant"); assert.deepEqual(audit.changes, []);
    const seed = execute("adr-seed", null, { locale: "zh-CN" }); assert.equal(seed.changes.length, 2); materialize(seed);
    const adr = execute("adr-render", null, { decisionId: "dec_SCRIPT" }); assert.deepEqual(adr.changes.map(({ path: target }) => target), ["decisions/adrs/dec_SCRIPT.md"]);
    const conformance = execute("decision-conformance"); assert.equal(conformance.status, "conformant"); assert.deepEqual(conformance.changes, []); assert.equal(conformance.report.decisionCount, 1);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("template and script discovery expose builtin content with typed vertical execution", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-vertical-discovery-"));
  try {
    const templates = await runPresetAction({ rootDir, action: { kind: "template-list" } }) as Array<{ templateRef: string; slot: string; materializeAs: string; locales: string[] }>;
    assert.equal(templates.length, 33); assert.deepEqual(templates, [...templates].sort((left, right) => left.templateRef.localeCompare(right.templateRef))); assert.deepEqual(templates.find(({ templateRef }) => templateRef === "template://repository/architecture-manifest@1"), { templateRef: "template://repository/architecture-manifest@1", slot: "repository.architecture.manifest", materializeAs: "{{paths.contextRoot}}/architecture/architecture-manifest.json", locales: ["en-US"] });
    const rendered = await runPresetAction({ rootDir, action: { kind: "template-render", templateRef: "template://repository/architecture-manifest@1", locale: "zh-CN" } }) as { schema: string; source: string; templateRef: string; locale: string; path: string; body: string; digest: string };
    assert.equal(rendered.schema, "template-render/v1"); assert.equal(rendered.source, "builtin:software/coding"); assert.equal(rendered.templateRef, "template://repository/architecture-manifest@1"); assert.equal(rendered.locale, "en-US"); assert.equal(rendered.path, "{{paths.contextRoot}}/architecture/architecture-manifest.json"); assert.match(rendered.body, /"schema": "architecture-manifest\/v1"/u); assert.match(rendered.digest, /^sha256:[0-9a-f]{64}$/u);
    const scripts = await runPresetAction({ rootDir, action: { kind: "script-list" } }) as Array<{ id: string; purpose: string; execution: string }>;
    assert.equal(scripts.length, 7); assert.deepEqual(scripts.map(({ id }) => id), [...scripts.map(({ id }) => id)].sort()); assert.ok(scripts.every(({ execution }) => execution === "available"));
    const inspected = await runPresetAction({ rootDir, action: { kind: "script-inspect", scriptId: "vertical:software-coding:architecture-check" } }) as { schema: string; declaration: { command: string; writes: string[] }; execution: { available: boolean; code: string } };
    assert.equal(inspected.schema, "vertical-script-inspection/v1"); assert.equal(inspected.declaration.command, "scripts/architecture-check.mjs"); assert.deepEqual(inspected.declaration.writes, []); assert.deepEqual(inspected.execution, { available: true, code: "script_run_available", nextAction: "Run ha script run vertical:software-coding:architecture-check [--dry-run]." });
    await assert.rejects(runPresetAction({ rootDir, action: { kind: "script-run", scriptId: "vertical:software-coding:architecture-check" } }), (error: unknown) => (error as { code?: string }).code === "unsupported_command");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("user shadow lifecycle dry-runs mutation, blocks invalid content, and reveals bundled on uninstall", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-shadow-lifecycle-")), sourceRoot = path.join(rootDir, "source", "standard-task"), userRoot = path.join(rootDir, ".harness/presets");
  try {
    writePackage(path.dirname(sourceRoot), "standard-task", { version: "3.1.0" });
    const validated = await runPresetAction({ rootDir, action: { kind: "preset-validate", packageSource: sourceRoot } }) as { schema: string; valid: boolean; source: string; preset?: { id: string; digest: string }; issues: unknown[] };
    assert.equal(validated.schema, "preset-validate-report/v1"); assert.equal(validated.valid, true); assert.equal(validated.source, sourceRoot); assert.equal(validated.preset?.id, "standard-task"); assert.match(validated.preset?.digest ?? "", /^[0-9a-f]{64}$/u); assert.deepEqual(validated.issues, []);
    const dryInstall = await runPresetAction({ rootDir, action: { kind: "preset-install", packageSource: sourceRoot, dryRun: true } }) as { mode: string; changed: boolean; presetId: string };
    assert.deepEqual({ mode: dryInstall.mode, changed: dryInstall.changed, presetId: dryInstall.presetId }, { mode: "dry-run", changed: true, presetId: "standard-task" }); assert.equal(existsSync(userRoot), false);
    await runPresetAction({ rootDir, action: { kind: "preset-install", packageSource: sourceRoot } });
    const shadow = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string; layer: string; source: string; issues: unknown[] }>;
    assert.deepEqual(shadow.find(({ id }) => id === "standard-task") && { layer: shadow.find(({ id }) => id === "standard-task")!.layer, source: shadow.find(({ id }) => id === "standard-task")!.source, issues: shadow.find(({ id }) => id === "standard-task")!.issues }, { layer: "user", source: path.join(userRoot, "preset-objects", validated.preset!.digest), issues: [] });
    write(path.join(userRoot, "preset-objects", validated.preset!.digest, "preset.json"), "{}");
    const blocked = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string; validity: string; errorCode?: string; issues: Array<{ code: string }> }>;
    assert.deepEqual(blocked.find(({ id }) => id === "standard-task") && { validity: blocked.find(({ id }) => id === "standard-task")!.validity, errorCode: blocked.find(({ id }) => id === "standard-task")!.errorCode, issues: blocked.find(({ id }) => id === "standard-task")!.issues.map(({ code }) => code) }, { validity: "blocked", errorCode: "shadow_invalid", issues: ["shadow_invalid"] });
    const audited = await runPresetAction({ rootDir, action: { kind: "preset-audit" } }) as { blocked: number; issues: Array<{ presetId: string; code: string; source: string; message: string }> }; assert.equal(audited.blocked, 1); assert.match(audited.issues.find(({ presetId }) => presetId === "standard-task")?.message ?? "", /preset\.json is missing required field "schema".*bundled standard-task remains blocked/u);
    await assert.rejects(runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "standard-task" } }), (error: unknown) => (error as { code?: string }).code === "shadow_invalid");
    assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-uninstall", presetId: "standard-task", dryRun: true } }), { presetId: "standard-task", mode: "dry-run", active: true, removed: false }); assert.equal(existsSync(path.join(userRoot, "active/standard-task.json")), true);
    assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-uninstall", presetId: "standard-task" } }), { presetId: "standard-task", mode: "apply", active: true, removed: true }); assert.equal(existsSync(path.join(userRoot, "preset-objects", validated.preset!.digest)), true);
    const revealed = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string; layer: string }>; assert.equal(revealed.find(({ id }) => id === "standard-task")?.layer, "bundled");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("profile precedence is explicit action, then settings, then manifest default", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-profile-")), sourceRoot = path.join(rootDir, "source"), profiles = [{ id: "baseline", title: "Baseline", completionGates: ["ci"], templateSelections: [] }, { id: "relaxed", title: "Relaxed", completionGates: [], templateSelections: [] }];
  try {
    writePackage(sourceRoot, "profile-task", { profiles, defaultProfile: "relaxed" }); installPresetPackage({ source: path.join(sourceRoot, "profile-task"), userRoot: path.join(rootDir, ".harness/presets") });
    const compile = (profileId?: string) => compileRepoTaskPackage({ rootDir, taskId: "task-profile", action: { kind: "task-create", title: "Profile", presetId: "profile-task", ...(profileId ? { profileId } : {}) } }).snapshot.profile.id;
    assert.equal(compile(), "relaxed"); write(path.join(rootDir, "harness/harness.yaml"), "settings:\n  defaultProfile: baseline\n"); assert.equal(compile(), "baseline"); assert.equal(compile("relaxed"), "relaxed");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("snapshot upgrade atomically replaces the complete snapshot and typed task contract without touching task prose", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-upgrade-")), sourceRoot = path.join(rootDir, "source"), userRoot = path.join(rootDir, ".harness/presets"), taskId = "task-upgrade";
  let projection: ReturnType<typeof makeTaskProjection> | undefined;
  try {
    git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Preset Test"); git(rootDir, "config", "user.email", "preset@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); writePackage(sourceRoot, "upgrade-task", { version: "3.1.0" }); installPresetPackage({ source: path.join(sourceRoot, "upgrade-task"), userRoot });
    const bootstrap = compileTaskBootstrap({ userRoot, verticalId: "software/coding", profileId: "baseline", locale: "en-US", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", taskId, title: "Upgrade", slug: "stable-package", presetId: "upgrade-task", workspaceRevision: 1, eventId: "event-upgrade-create", opId: "op-upgrade-create" }), store = makeTaskEventStore({ repoId: "preset-upgrade", rootDir }); projection = makeTaskProjection({ rootDir, eventStore: store }); store.append({ event: bootstrap.event, plan: bootstrap.plan, blobs: bootstrap.blobs }); projection.apply(bootstrap.event, bootstrap.plan);
    const planPath = path.join(rootDir, "harness", bootstrap.packagePath, "task_plan.md"), editedPlan = "# User plan\n\nKeep this prose.\n"; writeFileSync(planPath, editedPlan); writePackage(sourceRoot, "upgrade-task", { version: "3.2.0" }); installPresetPackage({ source: path.join(sourceRoot, "upgrade-task"), userRoot }); const task = projection.read(taskId).snapshot.task!, contractPath = `${bootstrap.packagePath}/task-contract.json`, contract = projection.readDocument(contractPath).document!;
    let upgraded: ReturnType<typeof compilePresetSnapshotUpgrade> | undefined; assert.doesNotThrow(() => { upgraded = compilePresetSnapshotUpgrade({ userRoot, task, taskContractBody: contract.body, actor: { principal: { personId: "person-1" }, executor: null }, source: "local", workspaceRevision: 2, eventId: "event-upgrade", opId: "op-upgrade", occurredAt: "2026-08-14T00:01:00.000Z" }); }, "a persisted package slug must not be reported as a changed document set"); assert.ok(upgraded); assert.notEqual(upgraded.snapshot.digest, task.presetSnapshotDigest); assert.equal(upgraded.snapshot.identity.version, "3.2.0"); assert.equal(upgraded.event.payload.taskContractClaim.path, contractPath); assert.equal(JSON.parse(upgraded.blobs.find(({ sha256 }) => sha256 === upgraded!.event.payload.taskContractClaim.sha256)!.body).packagePath, bootstrap.packagePath); store.append(upgraded); projection.apply(upgraded.event, upgraded.plan);
    assert.equal(projection.read(taskId).snapshot.task?.presetSnapshotDigest, upgraded.snapshot.digest); assert.deepEqual(projection.readPresetSnapshot(upgraded.snapshot.digest).snapshot, upgraded.snapshot); assert.equal(JSON.parse(projection.readDocument(contractPath).document!.body).presetSnapshotDigest, upgraded.snapshot.digest); assert.equal(readFileSync(planPath, "utf8"), editedPlan); assert.throws(() => compilePresetSnapshotUpgrade({ userRoot, task: projection.read(taskId).snapshot.task!, taskContractBody: projection.readDocument(contractPath).document!.body, actor: { principal: { personId: "person-1" }, executor: null }, source: "local", workspaceRevision: 3, eventId: "event-current", opId: "op-current", occurredAt: "2026-08-14T00:02:00.000Z" }), (error: unknown) => (error as { code?: string }).code === "snapshot_current");
    const profiles = [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [{ slot: "task.upgrade.evidence", templateRef: "template://upgrade/evidence@1", materializeAs: "upgrade-evidence.md", localePolicy: { prefer: "preset", fallback: "en-US" } }] }]; writePackage(sourceRoot, "upgrade-task", { version: "3.3.0", profiles }); write(path.join(sourceRoot, "upgrade-task/template-catalog.json"), JSON.stringify(templateCatalog([{ id: "upgrade/evidence", version: "1", documentKind: "upgrade-evidence", slot: "task.upgrade.evidence", materializeAs: "upgrade-evidence.md", frontmatterSchema: "task-package/v2", requiredAnchors: ["## Evidence"], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: ["## Evidence"], bodyPath: "templates/upgrade-evidence.md" }] }], "upgrade-task"))); write(path.join(sourceRoot, "upgrade-task/templates/upgrade-evidence.md"), "# Upgrade evidence\n\n## Evidence\n\nAdded by the changed preset definition.\n"); installPresetPackage({ source: path.join(sourceRoot, "upgrade-task"), userRoot }); assert.throws(() => compilePresetSnapshotUpgrade({ userRoot, task: projection.read(taskId).snapshot.task!, taskContractBody: projection.readDocument(contractPath).document!.body, actor: { principal: { personId: "person-1" }, executor: null }, source: "local", workspaceRevision: 3, eventId: "event-document-change", opId: "op-document-change", occurredAt: "2026-08-14T00:03:00.000Z" }), (error: unknown) => (error as { code?: string; message?: string }).code === "upgrade_document_set_changed" && (error as Error).message === "Preset upgrade changes the task document set and requires an explicit migration.");
  } finally { projection?.close(); rmSync(rootDir, { recursive: true, force: true }); }
});

test("user template selections resolve only package-local canonical catalog bodies", async () => {
  const fixture = makeFixture(), sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source"), profile = [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [{ slot: "task.user.impact", templateRef: "template://analysis/code-impact@1", materializeAs: "user-impact.md", localePolicy: { prefer: "preset", fallback: "en-US" } }] }];
  try {
    writePackage(sourceRoot, "user-impact", { profiles: profile }); assert.throws(() => installPresetPackage({ source: path.join(sourceRoot, "user-impact"), userRoot: fixture.userRoot }), (error: unknown) => (error as { code?: string }).code === "missing_template_catalog"); write(path.join(sourceRoot, "outside.md"), "# Outside\n\n## User Impact\n\nMust not be read.\n"); write(path.join(sourceRoot, "user-impact/template-catalog.json"), JSON.stringify(templateCatalog([{ id: "analysis/code-impact", version: "1", documentKind: "user-impact", slot: "task.user.impact", materializeAs: "user-impact.md", frontmatterSchema: "task-package/v2", requiredAnchors: ["## User Impact"], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: ["## User Impact"], bodyPath: "../outside.md" }] }], "user-impact"))); assert.throws(() => installPresetPackage({ source: path.join(sourceRoot, "user-impact"), userRoot: fixture.userRoot }), (error: unknown) => (error as { code?: string }).code === "missing_template");
    write(path.join(sourceRoot, "user-impact/template-catalog.json"), JSON.stringify(templateCatalog([{ id: "analysis/code-impact", version: "1", documentKind: "user-impact", slot: "task.user.impact", materializeAs: "user-impact.md", frontmatterSchema: "task-package/v2", requiredAnchors: ["## User Impact"], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: ["## User Impact"], bodyPath: "templates/user-impact.md" }] }], "user-impact"))); write(path.join(sourceRoot, "user-impact/templates/user-impact.md"), "# Local only\n\n## User Impact\n\nPackage body.\n"); installPresetPackage({ source: path.join(sourceRoot, "user-impact"), userRoot: fixture.userRoot });
    const resolved = createRuntime({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolveInternal({ presetId: "user-impact", verticalId: "software/coding", locale: "en-US", purpose: "task-create" }); assert.match(resolved.documents.find(({ slot }) => slot === "task.user.impact")?.body ?? "", /Package body/u); assert.equal(resolved.snapshot.identity.layer, "user");
  } finally { fixture.cleanup(); }
});

test("the same self-contained package has identical bundled and user snapshot content semantics", async () => {
  const fixture = makeFixture(), packageRoot = path.join(fixture.bundledRoot, "local-impact"), profile = [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [{ slot: "task.user.impact", templateRef: "template://analysis/local-impact@1", materializeAs: "local-impact.md", localePolicy: { prefer: "preset", fallback: "en-US" } }] }];
  try {
    writePackage(fixture.bundledRoot, "local-impact", { profiles: profile, policyPath: "policy.json" }); write(path.join(packageRoot, "policy.json"), JSON.stringify({ schema: "preset-policy/v1", requires: [] })); write(path.join(packageRoot, "template-catalog.json"), JSON.stringify(templateCatalog([{ id: "analysis/local-impact", version: "1", documentKind: "local-impact", slot: "task.user.impact", materializeAs: "local-impact.md", frontmatterSchema: "task-package/v2", requiredAnchors: ["## Local Impact"], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: ["## Local Impact"], bodyPath: "templates/local-impact.md" }] }], "local-impact"))); write(path.join(packageRoot, "templates/local-impact.md"), "# Local only\n\n## Local Impact\n\nPackage body.\n");
    const request = { presetId: "local-impact", verticalId: "software/coding", locale: "en-US", purpose: "task-create" as const }, bundled = createRuntime({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolveInternal(request); installPresetPackage({ source: packageRoot, userRoot: fixture.userRoot }); const user = createRuntime({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolveInternal(request);
    const semantics = ({ snapshot, documents }: typeof bundled) => ({ profile: snapshot.profile, guidance: snapshot.guidance, scaffold: snapshot.scaffold, templates: snapshot.templates, entrypoints: snapshot.entrypoints, provenance: snapshot.provenance, documents }); assert.deepEqual(semantics(user), semantics(bundled)); assert.equal(bundled.snapshot.identity.layer, "bundled"); assert.equal(user.snapshot.identity.layer, "user");
    write(path.join(packageRoot, "policy.json"), JSON.stringify({ schema: "preset-policy/v0", requires: [] })); assert.equal((await runPresetAction({ rootDir: path.dirname(fixture.userRoot), action: { kind: "preset-validate", packageSource: packageRoot } }) as { issues: Array<{ code: string }> }).issues[0]?.code, "invalid_policy"); assert.throws(() => installPresetPackage({ source: packageRoot, userRoot: fixture.userRoot }), (error: unknown) => (error as { code?: string }).code === "invalid_policy");
  } finally { fixture.cleanup(); }
});

test("seed and audit dry-runs report the two-layer inventory without mutation", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-seed-audit-")), userRoot = path.join(rootDir, ".harness/presets");
  try {
    const audit = await runPresetAction({ rootDir, action: { kind: "preset-audit" } }) as { schema: string; total: number; valid: number; unavailable: number; blocked: number; issues: Array<{ presetId: string; code: string }> }; assert.deepEqual({ schema: audit.schema, total: audit.total, valid: audit.valid, unavailable: audit.unavailable, blocked: audit.blocked, issues: audit.issues.map(({ presetId, code }) => ({ presetId, code })) }, { schema: "preset-audit-report/v1", total: 12, valid: 12, unavailable: 0, blocked: 0, issues: [] });
    const drySeed = await runPresetAction({ rootDir, action: { kind: "preset-seed", dryRun: true } }) as { schema: string; mode: string; packageCount: number; packages: Array<{ presetId: string }> }; assert.equal(drySeed.schema, "preset-seed-report/v1"); assert.equal(drySeed.mode, "dry-run"); assert.equal(drySeed.packageCount, 12); assert.deepEqual(drySeed.packages.map(({ presetId }) => presetId), ["architecture-rot-audit", "code-impact-analysis", "create-milestone", "decision-conformance", "docs-task", "github-issue-repair", "legacy-migration", "milestone-closeout", "module", "standard-task", "subtask-expansion", "worker-dispatch"]); assert.equal(existsSync(userRoot), false);
    const seeded = await runPresetAction({ rootDir, action: { kind: "preset-seed" } }) as { mode: string; packageCount: number }; assert.deepEqual({ mode: seeded.mode, packageCount: seeded.packageCount }, { mode: "apply", packageCount: 12 }); assert.equal(readdirSync(path.join(userRoot, "active")).length, 12);
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-resolver-")), bundledRoot = path.join(root, "bundled"), userRoot = path.join(root, "user"), assetsRoot = path.join(root, "assets"), presetRoot = path.join(bundledRoot, "standard-task");
  cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, { recursive: true });
  write(path.join(presetRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "standard-task", title: "Standard Task", vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" }));
  write(path.join(presetRoot, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: General task\nwhenToUse: Use for ordinary repository work.\n---\n# Standard Task\n");
  write(path.join(assetsRoot, "capabilities.json"), JSON.stringify({ schema: "preset-capabilities/v1", providers: [] })); mkdirSync(userRoot, { recursive: true });
  return { bundledRoot, userRoot, assetsRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function writePackage(root: string, id: string, extra: Record<string, unknown> = {}): void { const identity = extra.kind === "agent" || extra.kind === "squad", taskShape = identity ? {} : { kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" }; write(path.join(root, id, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id, title: id, vertical: "software/coding", version: "3.0.0", ...taskShape, ...extra })); write(path.join(root, id, "PRESET.md"), `---\nschema: preset-document/v1\ndescription: ${id}\nwhenToUse: Test ${id}.\n---\n# ${id}\n`); }
function templateCatalog(documents: readonly Record<string, unknown>[], id = "fixture") { return { schema: "template-catalog/v2", package: { id, title: id, version: "1.0.0", owner: "test", locales: ["en-US"] }, documents }; }
function write(target: string, body: string): void { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${body}${body.endsWith("\n") ? "" : "\n"}`); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }

test("a preset document parses the same on a CRLF checkout as on an LF checkout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-crlf-"));
  try {
    const manifest = JSON.stringify({ schema: "preset-manifest/v3", id: "crlf", title: "CRLF", vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline" });
    const frontmatter = (eol: string): string => `---${eol}schema: preset-document/v1${eol}description: CRLF package${eol}whenToUse: Use on a Windows checkout.${eol}---${eol}# CRLF${eol}`;
    const lfRoot = path.join(root, "lf"), crlfRoot = path.join(root, "crlf");
    write(path.join(lfRoot, "preset.json"), manifest); write(path.join(lfRoot, "PRESET.md"), frontmatter("\n"));
    write(path.join(crlfRoot, "preset.json"), manifest); write(path.join(crlfRoot, "PRESET.md"), frontmatter("\r\n"));

    // Git for Windows checks out CRLF by default, so the frontmatter grammar
    // cannot encode LF. Field values must not carry the carriage return either.
    const lf = decodePresetPackageV3(lfRoot).document, crlf = decodePresetPackageV3(crlfRoot).document;
    assert.deepEqual({ ...crlf, body: null }, { ...lf, body: null });
    assert.equal(crlf.description, "CRLF package");
    assert.equal(crlf.whenToUse, "Use on a Windows checkout.");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
