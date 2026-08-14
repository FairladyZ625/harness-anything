// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, sha256Text } from "../../kernel/src/index.ts";
import { compilePresetSnapshotUpgrade, compileRepoTaskPackage, compileRepositoryScaffold, compileTaskBootstrap, createCanonicalPresetResolver, installPresetPackage, runPresetAction, uninstallPresetPackage } from "../src/index.ts";
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

test("an invalid user package shadows the bundled package without fallback", async () => {
  const fixture = makeFixture();
  try {
    const digest = "d".repeat(64), objectRoot = path.join(fixture.userRoot, "preset-objects", digest);
    write(path.join(objectRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3" }));
    write(path.join(fixture.userRoot, "active/standard-task.json"), JSON.stringify({ schema: "preset-active-pointer/v1", presetId: "standard-task", verticalId: "software/coding", digest }));
    const resolver = createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }), listed = await resolver.list({ verticalId: "software/coding" }), result = await resolver.resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.deepEqual(listed.map(({ id, layer, validity, errorCode }) => ({ id, layer, validity, errorCode })), [{ id: "standard-task", layer: "user", validity: "blocked", errorCode: "shadow_invalid" }]);
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("a symbolic-link active pointer blocks the bundled package", async () => {
  const fixture = makeFixture();
  try {
    write(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), JSON.stringify({ schema: "preset-active-pointer/v1" })); mkdirSync(path.join(fixture.userRoot, "active"), { recursive: true }); symlinkSync(path.join(path.dirname(fixture.userRoot), "outside-pointer.json"), path.join(fixture.userRoot, "active/standard-task.json"));
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "standard-task", verticalId: "software/coding", locale: "en-US", purpose: "inspect" }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "shadow_invalid");
  } finally { fixture.cleanup(); }
});

test("a symbolic-link pointer blocks the same preset id in every vertical", async () => {
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
    mkdirSync(outsideActive, { recursive: true }); rmSync(path.join(fixture.userRoot, "active"), { recursive: true, force: true }); symlinkSync(outsideActive, path.join(fixture.userRoot, "active"));
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

test("package decoder rejects symlinks and missing PRESET or script files", () => {
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

test("resolver rejects a required capability without an exact provider", async () => {
  const fixture = makeFixture();
  try {
    writePackage(fixture.bundledRoot, "needs-provider", { capabilityImports: [{ id: "policy:missing/v1", kind: "command", version: "1", required: true }] });
    const result = await createCanonicalPresetResolver({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolve({ presetId: "needs-provider", verticalId: "software/coding", locale: "en-US", purpose: "inspect" });
    assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "missing_provider");
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

test("twelve bundled packages list through one catalog while missing workflow prerequisites stay unavailable", async () => {
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
      { id: "module", validity: "unavailable", errorCode: "missing_provider" },
      { id: "standard-task", validity: "valid", errorCode: undefined },
      { id: "subtask-expansion", validity: "unavailable", errorCode: "missing_provider" },
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
      ["decision-conformance", "repository-diff", ["ci", "code-doc-reconciliation"], ["task.plan", "task.closeout", "task.artifacts.keep"]]
    ] as const;
    for (const [presetId, outputShape, completionGateIds, slots] of matrix) { const result = await resolver.resolve({ ...common, presetId }); assert.equal(result.ok, true, presetId); if (result.ok) assert.deepEqual({ outputShape: result.snapshot.profile.outputShape, completionGateIds: result.snapshot.profile.completionGateIds, slots: result.snapshot.templates.map(({ slot }) => slot), entrypoints: Object.keys(result.snapshot.entrypoints) }, { outputShape, completionGateIds, slots, entrypoints: [] }); }
    for (const presetId of ["module", "subtask-expansion"]) { const result = await resolver.resolve({ ...common, presetId }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, "missing_provider"); }
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
  { presetId: "legacy-migration", gates: ["ci", "code-doc-reconciliation"], addedPath: null },
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

test("module locale, required anchors, and body digests close through the canonical catalog when its owner capability is present", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-module-catalog-")), assetsRoot = path.join(root, "assets");
  try {
    cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, { recursive: true }); const capabilities = JSON.parse(readFileSync(path.join(assetsRoot, "capabilities.json"), "utf8")) as { providers: Array<Record<string, unknown>> }; capabilities.providers.push({ id: "task-create-module-context", kind: "command", version: "1" }); write(path.join(assetsRoot, "capabilities.json"), JSON.stringify(capabilities));
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
    const applied = compile(); assert.equal(applied.documents.length, 15); assert.deepEqual(applied.documents.map(({ disposition }) => disposition), Array(15).fill("created")); assert.equal(applied.documents.find(({ slot }) => slot === "repository.context.architecture")?.templateRef, "project://templates/architecture.md"); assert.deepEqual(applied.documents.filter(({ slot }) => slot.startsWith("repository.standard.")).map(({ path: target }) => target), ["harness/governance/standards/README.md", "harness/governance/standards/repository-governance.md", "harness/governance/standards/decision-writing.md"]); assert.match(String(applied.projectOverlayDigest), /^sha256:/u); assert.match(applied.baseScaffoldDigest, /^sha256:/u);
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

test("generic list, inspect, check, install, and uninstall actions share the canonical inventory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-actions-")), sourceRoot = path.join(rootDir, "source");
  try {
    const listed = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string; version?: string; kind?: string; defaultProfile?: string; entrypoints?: string[]; issueCount?: number }>; assert.equal(listed.length, 12); assert.deepEqual(listed.find(({ id }) => id === "standard-task"), { id: "standard-task", title: "Standard Task", description: "Create the standard planning, facts, and closeout scaffold for general software work.", verticalId: "software/coding", layer: "bundled", validity: "valid", version: "3.0.0", kind: "template-content", defaultProfile: "baseline", entrypoints: [], issueCount: 0 });
    const inspected = await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "standard-task" } }) as { manifest: { id: string }; snapshot: { digest: string }; entrypoints: string[] }; assert.equal(inspected.manifest.id, "standard-task"); assert.deepEqual(inspected.entrypoints, []); assert.match(inspected.snapshot.digest, /^sha256:/u);
    assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task" } }), { valid: true, digest: inspected.snapshot.digest });
    const stale = `sha256:${"0".repeat(64)}`; assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task", snapshotDigest: stale } }), { valid: false, code: "snapshot_mismatch", actualDigest: stale, expectedDigest: inspected.snapshot.digest, nextAction: "Run ha preset upgrade <task-id>." }); assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task", snapshotDigest: inspected.snapshot.digest } }), { valid: true, digest: inspected.snapshot.digest });
    writePackage(sourceRoot, "user-task", { version: "3.4.0" }); assert.deepEqual(Object.keys(await runPresetAction({ rootDir, action: { kind: "preset-install", packageSource: path.join(sourceRoot, "user-task") } }) as object).sort(), ["digest", "presetId"]); assert.equal((await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "user-task" } }) as { snapshot: { identity: { layer: string } } }).snapshot.identity.layer, "user"); assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-uninstall", presetId: "user-task" } }), { presetId: "user-task", removed: true });
    await assert.rejects(runPresetAction({ rootDir, action: { kind: "preset-unknown", presetId: "standard-task" } }), (error: unknown) => (error as { code?: string }).code === "unsupported_command");
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
  try {
    git(rootDir, "init", "-q"); git(rootDir, "config", "user.name", "Preset Test"); git(rootDir, "config", "user.email", "preset@example.invalid"); git(rootDir, "commit", "--allow-empty", "-qm", "base"); writePackage(sourceRoot, "upgrade-task", { version: "3.1.0" }); installPresetPackage({ source: path.join(sourceRoot, "upgrade-task"), userRoot });
    const bootstrap = compileTaskBootstrap({ userRoot, verticalId: "software/coding", profileId: "baseline", locale: "en-US", actor: { principal: { personId: "person-1" }, executor: null }, source: "local", occurredAt: "2026-08-14T00:00:00.000Z", taskId, title: "Upgrade", presetId: "upgrade-task", workspaceRevision: 1, eventId: "event-upgrade-create", opId: "op-upgrade-create" }), store = makeTaskEventStore({ repoId: "preset-upgrade", rootDir }), projection = makeTaskProjection({ rootDir, eventStore: store }); store.append({ event: bootstrap.event, plan: bootstrap.plan, blobs: bootstrap.blobs }); projection.apply(bootstrap.event, bootstrap.plan);
    const planPath = path.join(rootDir, "harness", bootstrap.packagePath, "task_plan.md"), editedPlan = "# User plan\n\nKeep this prose.\n"; writeFileSync(planPath, editedPlan); writePackage(sourceRoot, "upgrade-task", { version: "3.2.0" }); installPresetPackage({ source: path.join(sourceRoot, "upgrade-task"), userRoot }); const task = projection.read(taskId).snapshot.task!, contractPath = `${bootstrap.packagePath}/task-contract.json`, contract = projection.readDocument(contractPath).document!;
    const upgraded = compilePresetSnapshotUpgrade({ userRoot, task, taskContractBody: contract.body, actor: { principal: { personId: "person-1" }, executor: null }, source: "local", workspaceRevision: 2, eventId: "event-upgrade", opId: "op-upgrade", occurredAt: "2026-08-14T00:01:00.000Z" }); assert.notEqual(upgraded.snapshot.digest, task.presetSnapshotDigest); assert.equal(upgraded.snapshot.identity.version, "3.2.0"); store.append(upgraded); projection.apply(upgraded.event, upgraded.plan);
    assert.equal(projection.read(taskId).snapshot.task?.presetSnapshotDigest, upgraded.snapshot.digest); assert.deepEqual(projection.readPresetSnapshot(upgraded.snapshot.digest).snapshot, upgraded.snapshot); assert.equal(JSON.parse(projection.readDocument(contractPath).document!.body).presetSnapshotDigest, upgraded.snapshot.digest); assert.equal(readFileSync(planPath, "utf8"), editedPlan); assert.throws(() => compilePresetSnapshotUpgrade({ userRoot, task: projection.read(taskId).snapshot.task!, taskContractBody: projection.readDocument(contractPath).document!.body, actor: { principal: { personId: "person-1" }, executor: null }, source: "local", workspaceRevision: 3, eventId: "event-current", opId: "op-current", occurredAt: "2026-08-14T00:02:00.000Z" }), (error: unknown) => (error as { code?: string }).code === "snapshot_current");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("user template selections resolve only package-local canonical catalog bodies", async () => {
  const fixture = makeFixture(), sourceRoot = path.join(path.dirname(fixture.bundledRoot), "user-source"), profile = [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [{ slot: "task.user.impact", templateRef: "template://analysis/code-impact@1", materializeAs: "user-impact.md", localePolicy: { prefer: "preset", fallback: "en-US" } }] }];
  try {
    writePackage(sourceRoot, "user-impact", { profiles: profile }); assert.throws(() => installPresetPackage({ source: path.join(sourceRoot, "user-impact"), userRoot: fixture.userRoot }), (error: unknown) => (error as { code?: string }).code === "missing_template_catalog");
    write(path.join(sourceRoot, "user-impact/template-catalog.json"), JSON.stringify(templateCatalog([{ id: "analysis/code-impact", version: "1", documentKind: "user-impact", slot: "task.user.impact", materializeAs: "user-impact.md", frontmatterSchema: "task-package/v2", requiredAnchors: ["## User Impact"], fallbackLocale: "en-US", locales: [{ locale: "en-US", anchors: ["## User Impact"], bodyPath: "templates/user-impact.md" }] }], "user-impact"))); write(path.join(sourceRoot, "user-impact/templates/user-impact.md"), "# Local only\n\n## User Impact\n\nPackage body.\n"); installPresetPackage({ source: path.join(sourceRoot, "user-impact"), userRoot: fixture.userRoot });
    const resolved = createRuntime({ bundledRoot: fixture.bundledRoot, userRoot: fixture.userRoot, assetsRoot: fixture.assetsRoot }).resolveInternal({ presetId: "user-impact", verticalId: "software/coding", locale: "en-US", purpose: "task-create" }); assert.match(resolved.documents.find(({ slot }) => slot === "task.user.impact")?.body ?? "", /Package body/u); assert.equal(resolved.snapshot.identity.layer, "user");
  } finally { fixture.cleanup(); }
});

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-resolver-")), bundledRoot = path.join(root, "bundled"), userRoot = path.join(root, "user"), assetsRoot = path.join(root, "assets"), presetRoot = path.join(bundledRoot, "standard-task");
  cpSync(new URL("../assets/software-coding/", import.meta.url), assetsRoot, { recursive: true });
  write(path.join(presetRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "standard-task", title: "Standard Task", vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" }));
  write(path.join(presetRoot, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: General task\nwhenToUse: Use for ordinary repository work.\n---\n# Standard Task\n");
  write(path.join(assetsRoot, "capabilities.json"), JSON.stringify({ schema: "preset-capabilities/v1", providers: [] })); mkdirSync(userRoot, { recursive: true });
  return { bundledRoot, userRoot, assetsRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function writePackage(root: string, id: string, extra: Record<string, unknown> = {}): void { write(path.join(root, id, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id, title: id, vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline", ...extra })); write(path.join(root, id, "PRESET.md"), `---\nschema: preset-document/v1\ndescription: ${id}\nwhenToUse: Test ${id}.\n---\n# ${id}\n`); }
function templateCatalog(documents: readonly Record<string, unknown>[], id = "fixture") { return { schema: "template-catalog/v2", package: { id, title: id, version: "1.0.0", owner: "test", locales: ["en-US"] }, documents }; }
function write(target: string, body: string): void { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${body}${body.endsWith("\n") ? "" : "\n"}`); }
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
