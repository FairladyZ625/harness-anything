// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import presetContract, { parsePresetManifestV3, validatePresetManifestV3, validatePresetRunReceiptV1, validatePresetSnapshotV1 } from "../src/preset.contract.ts";
import { decodePresetPackageV3, validateBuiltinVertical } from "../src/preset-resolver.ts";

const manifest = {
  schema: "preset-manifest/v3",
  id: "standard-task",
  title: "Standard Task",
  vertical: "software/coding",
  version: "3.0.0",
  kind: "template-content",
  outputShape: "repository-diff",
  kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
  capabilityImports: [],
  profiles: [{ id: "baseline", title: "Baseline", completionGates: ["ci"], templateSelections: [] }],
  defaultProfile: "baseline"
} as const;

test("preset contract accepts only the closed v3 wire shape", () => {
  assert.equal(parsePresetManifestV3(manifest).id, "standard-task");
  assert.match(validatePresetManifestV3({ ...manifest, schema: "preset-manifest/v2" }).join("\n"), /v3/u);
  assert.match(validatePresetManifestV3({ ...manifest, fallback: true }).join("\n"), /unknown/u);
  assert.deepEqual(presetContract.schemas.map((schema) => schema.id), ["preset-manifest/v3", "preset-document/v1", "preset-snapshot/v1", "preset-run-receipt/v1"]);
});

test("preset snapshot codec rejects nested field deletion and unknown aliases", () => {
  const hash = "a".repeat(64), snapshot = { schema: "preset-snapshot/v1", identity: { id: "standard-task", version: "3.0.0", verticalId: "software/coding", layer: "bundled" }, profile: { id: "baseline", outputShape: "repository-diff", completionGateIds: ["ci"] }, guidance: { description: "Standard", whenToUse: "Ordinary work", bodySha256: hash }, scaffold: { baseVersion: "software-coding/v1", overlayDigest: null, resolvedSelectionDigest: `sha256:${hash}` }, templates: [{ slot: "task.plan", path: "task_plan.md", templateRef: "template://planning/task-plan@1", locale: "en-US", owner: "doc-sync", requiredAnchors: ["## Goal"], content: { sha256: hash, size: 1, mediaType: "text/markdown" } }], entrypoints: {}, provenance: { manifestSha256: hash, packageSha256: hash, verticalSha256: hash, templateCatalogSha256: hash, resolverVersion: "1", ancestry: ["standard-task"] }, digest: `sha256:${hash}` };
  assert.deepEqual(validatePresetSnapshotV1(snapshot), []);
  assert.match(validatePresetSnapshotV1({ ...snapshot, profile: { id: "baseline", completionGateIds: ["ci"] } }).join("\n"), /invalid/u);
  assert.match(validatePresetSnapshotV1({ ...snapshot, provenance: { ...snapshot.provenance, manifestDigest: hash } }).join("\n"), /invalid/u);
});

test("script run declares one closed start route and one read-only status route", () => {
  const command = presetContract.commands.find(({ id }) => id === "preset-run-start");
  assert.deepEqual(command && { path: command.path, method: command.method, commandClass: command.commandClass }, {
    path: ["script", "run"], method: "repo.preset.run.start", commandClass: "repo-write"
  });
  assert.deepEqual(presetContract.methods.filter(({ method }) => method.startsWith("repo.preset.run.")).map(({ method, commandClass, params }) => ({ method, commandClass, fields: Object.keys(params.fields.payload.fields) })), [
    { method: "repo.preset.run.start", commandClass: "repo-write", fields: ["presetId", "entrypoint", "taskId", "inputs", "idempotencyKey"] },
    { method: "repo.preset.run.status", commandClass: "repo-read", fields: ["runId"] }
  ]);
});

test("builtin vertical and template discovery stay read-only while vertical run is one typed write route", () => {
  assert.deepEqual(presetContract.commands.filter(({ id }) => ["vertical-validate", "template-list", "template-render", "script-list", "script-inspect"].includes(id)).map(({ id, path, method, commandClass }) => ({ id, path, method, commandClass })), [
    { id: "vertical-validate", path: ["vertical", "validate"], method: "repo.vertical.validate", commandClass: "repo-read" },
    { id: "template-list", path: ["template", "list"], method: "repo.template.list", commandClass: "repo-read" },
    { id: "template-render", path: ["template", "render"], method: "repo.template.render", commandClass: "repo-read" },
    { id: "script-list", path: ["script", "list"], method: "repo.script.list", commandClass: "repo-read" },
    { id: "script-inspect", path: ["script", "inspect"], method: "repo.script.inspect", commandClass: "repo-read" }
  ]);
  const run = presetContract.methods.find(({ actionKind }) => actionKind === "script-run"); assert.deepEqual(run && { method: run.method, commandClass: run.commandClass, fields: Object.keys(run.params.fields.payload.fields) }, { method: "repo.script.run", commandClass: "repo-write", fields: ["scriptId", "taskId", "inputs", "dryRun"] });
});

test("preset failures reach the daemon boundary as readable text and survive report serialization", () => {
  const thrown = (() => { try { decodePresetPackageV3("/nonexistent-preset-package"); return null; } catch (error) { return error; } })();
  const hint = thrown instanceof Error ? thrown.message : String(thrown);
  assert.notEqual(hint, "[object Object]"); assert.match(hint, /is not a regular directory/u); assert.equal((thrown as { readonly code?: string }).code, "invalid_package");
  assert.deepEqual(JSON.parse(JSON.stringify(validateBuiltinVertical({ source: "custom-vertical" }).issues)), [{ code: "custom_vertical_unavailable", message: "Custom verticals remain unavailable until validate, discovery, and create materialization share one source." }]);
});

test("preset run receipt requires an exact current phase and bounded terminal vocabulary", () => {
  const receipt = { schema: "preset-run-receipt/v1", runId: "run_1", outcome: "started", phase: "admitted", phases: ["admitted"], snapshotDigest: `sha256:${"a".repeat(64)}` };
  assert.deepEqual(validatePresetRunReceiptV1(receipt), []); assert.match(validatePresetRunReceiptV1({ ...receipt, phase: "running" }).join("\n"), /invalid/u); assert.match(validatePresetRunReceiptV1({ ...receipt, outcome: "queued" }).join("\n"), /invalid/u); assert.match(validatePresetRunReceiptV1({ ...receipt, retry: true }).join("\n"), /invalid/u);
});
