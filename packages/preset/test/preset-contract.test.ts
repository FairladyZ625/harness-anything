// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import presetContract, { parsePresetManifestV3, validatePresetManifestV3, validatePresetSnapshotV1 } from "../src/preset.contract.ts";

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
  const hash = "a".repeat(64), snapshot = { schema: "preset-snapshot/v1", identity: { id: "standard-task", version: "3.0.0", verticalId: "software/coding", layer: "bundled" }, profile: { id: "baseline", outputShape: "repository-diff", completionGateIds: ["ci"] }, guidance: { description: "Standard", whenToUse: "Ordinary work", bodySha256: hash }, templates: [{ slot: "task.plan", path: "task_plan.md", templateRef: "template://planning/task-plan@1", locale: "en-US", content: { sha256: hash, size: 1, mediaType: "text/markdown" } }], entrypoints: {}, provenance: { manifestSha256: hash, packageSha256: hash, verticalSha256: hash, templateCatalogSha256: hash, resolverVersion: "1", ancestry: ["standard-task"] }, digest: `sha256:${hash}` };
  assert.deepEqual(validatePresetSnapshotV1(snapshot), []);
  assert.match(validatePresetSnapshotV1({ ...snapshot, profile: { id: "baseline", completionGateIds: ["ci"] } }).join("\n"), /invalid/u);
  assert.match(validatePresetSnapshotV1({ ...snapshot, provenance: { ...snapshot.provenance, manifestDigest: hash } }).join("\n"), /invalid/u);
});
