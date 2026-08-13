// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCanonicalPresetResolver, installPresetPackage, runPresetAction, uninstallPresetPackage } from "../src/index.ts";
import { decodePresetPackageV3 } from "../src/preset-resolver.ts";

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
    assert.deepEqual(result.snapshot.templates.map((entry) => entry.path), ["task_plan.md"]);
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
    write(path.join(fixture.assetsRoot, "template-catalog.json"), JSON.stringify({ schema: "preset-template-catalog/v1", documents: [{ ref: "template://planning/task-plan@1", variants: [{ locale: "en-US", path: "../escaped.md", mediaType: "text/markdown" }] }] })); write(path.join(path.dirname(fixture.assetsRoot), "escaped.md"), "# Escaped\n");
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

test("bundled standard-task and create-milestone resolve three exact task documents without id branches", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-builtins-"));
  try {
    const resolver = createCanonicalPresetResolver({ userRoot: root }), common = { verticalId: "software/coding", profileId: "baseline", locale: "en-US", purpose: "task-create" } as const;
    const standard = await resolver.resolve({ ...common, presetId: "standard-task" }), milestone = await resolver.resolve({ ...common, presetId: "create-milestone" });
    assert.equal(standard.ok, true); assert.equal(milestone.ok, true); if (!standard.ok || !milestone.ok) return;
    assert.deepEqual(standard.snapshot.templates.map(({ slot, path: target, templateRef }) => ({ slot, target, templateRef })), [
      { slot: "task.plan", target: "task_plan.md", templateRef: "template://planning/task-plan@1" }, { slot: "task.closeout", target: "closeout.md", templateRef: "template://planning/closeout@1" }, { slot: "task.artifacts.keep", target: "artifacts/.gitkeep", templateRef: "template://planning/keep-file@1" }
    ]);
    assert.deepEqual(milestone.snapshot.templates.map(({ slot, path: target, templateRef }) => ({ slot, target, templateRef })), [
      { slot: "task.plan", target: "task_plan.md", templateRef: "template://planning/milestone-task-plan@1" }, { slot: "task.closeout", target: "closeout.md", templateRef: "template://planning/closeout@1" }, { slot: "task.artifacts.keep", target: "artifacts/.gitkeep", templateRef: "template://planning/keep-file@1" }
    ]);
    const noEntrypoint = await resolver.resolve({ presetId: "create-milestone", verticalId: "software/coding", locale: "en-US", purpose: "script-run", entrypoint: "run" }); assert.equal(noEntrypoint.ok, false); if (!noEntrypoint.ok) assert.equal(noEntrypoint.error.code, "entrypoint_not_found");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("generic list, inspect, check, install, and uninstall actions share the canonical inventory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-preset-actions-")), sourceRoot = path.join(rootDir, "source");
  try {
    const listed = await runPresetAction({ rootDir, action: { kind: "preset-list" } }) as Array<{ id: string }>; assert.deepEqual(listed.map(({ id }) => id), ["create-milestone", "standard-task"]);
    const inspected = await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "standard-task" } }) as { digest: string }; assert.match(inspected.digest, /^sha256:/u);
    assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-check", presetId: "standard-task" } }), { valid: true, digest: inspected.digest });
    writePackage(sourceRoot, "user-task", { version: "3.4.0" }); assert.deepEqual(Object.keys(await runPresetAction({ rootDir, action: { kind: "preset-install", packageSource: path.join(sourceRoot, "user-task") } }) as object).sort(), ["digest", "presetId"]); assert.equal((await runPresetAction({ rootDir, action: { kind: "preset-inspect", presetId: "user-task" } }) as { identity: { layer: string } }).identity.layer, "user"); assert.deepEqual(await runPresetAction({ rootDir, action: { kind: "preset-uninstall", presetId: "user-task" } }), { presetId: "user-task", removed: true });
    await assert.rejects(runPresetAction({ rootDir, action: { kind: "preset-unknown", presetId: "standard-task" } }), (error: unknown) => (error as { code?: string }).code === "unsupported_command");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-preset-resolver-")), bundledRoot = path.join(root, "bundled"), userRoot = path.join(root, "user"), assetsRoot = path.join(root, "assets"), presetRoot = path.join(bundledRoot, "standard-task");
  write(path.join(presetRoot, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id: "standard-task", title: "Standard Task", vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci", "code-doc-reconciliation"], templateSelections: [] }], defaultProfile: "baseline" }));
  write(path.join(presetRoot, "PRESET.md"), "---\nschema: preset-document/v1\ndescription: General task\nwhenToUse: Use for ordinary repository work.\n---\n# Standard Task\n");
  write(path.join(assetsRoot, "vertical.json"), JSON.stringify({ schema: "preset-vertical/v1", id: "software/coding", version: "1", taskTemplates: [{ slot: "task.plan", templateRef: "template://planning/task-plan@1", materializeAs: "task_plan.md" }] }));
  write(path.join(assetsRoot, "template-catalog.json"), JSON.stringify({ schema: "preset-template-catalog/v1", documents: [{ ref: "template://planning/task-plan@1", variants: [{ locale: "en-US", path: "templates/task-plan.en-US.md", mediaType: "text/markdown" }] }] }));
  write(path.join(assetsRoot, "capabilities.json"), JSON.stringify({ schema: "preset-capabilities/v1", providers: [] })); write(path.join(assetsRoot, "templates/task-plan.en-US.md"), "# Plan\n"); mkdirSync(userRoot, { recursive: true });
  return { bundledRoot, userRoot, assetsRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function writePackage(root: string, id: string, extra: Record<string, unknown> = {}): void { write(path.join(root, id, "preset.json"), JSON.stringify({ schema: "preset-manifest/v3", id, title: id, vertical: "software/coding", version: "3.0.0", kind: "template-content", outputShape: "repository-diff", kernelVersionRange: { min: "1.0.0" }, capabilityImports: [], profiles: [{ id: "baseline", title: "Baseline", completionGates: [], templateSelections: [] }], defaultProfile: "baseline", ...extra })); write(path.join(root, id, "PRESET.md"), `---\nschema: preset-document/v1\ndescription: ${id}\nwhenToUse: Test ${id}.\n---\n# ${id}\n`); }
function write(target: string, body: string): void { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, `${body}${body.endsWith("\n") ? "" : "\n"}`); }
