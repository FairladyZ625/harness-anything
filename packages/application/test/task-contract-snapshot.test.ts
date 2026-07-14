// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { compileTaskContractSnapshot, parseTaskContractSnapshot, resolveTaskCompletionGates } from "../src/index.ts";

test("task contract compiler freezes declarative preset and template behavior", () => {
  const snapshot = compileTaskContractSnapshot({
    vertical: "software/coding",
    preset: {
      schema: "preset-manifest/v2",
      id: "fixture-task",
      title: "Fixture Task",
      vertical: "software/coding",
      version: "2.3.0",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "standard",
        completionGates: ["ci"],
        templateSelections: []
      }],
      defaultProfile: "baseline"
    },
    profileId: "baseline",
    catalog: {
      schema: "template-catalog/v2",
      package: {
        id: "fixture-catalog",
        title: "Fixture Catalog",
        version: "4.0.0",
        owner: "tests",
        locales: ["en-US"]
      },
      documents: []
    },
    documents: [{
      slot: "task.plan",
      templateRef: "task.plan@7",
      documentKind: "task-plan",
      materializeAs: "task_plan.md",
      locale: "en-US",
      fallbackUsed: false,
      requiredAnchors: ["## Goal"],
      body: "# Plan\n\n## Goal\n"
    }],
    capturedAt: "2026-07-14T00:00:00.000Z",
    capturedBy: "task-create"
  });

  assert.equal(snapshot.schema, "task-contract-snapshot/v1");
  assert.deepEqual(snapshot.preset, {
    id: "fixture-task",
    version: "2.3.0",
    digest: "sha256:01c793f9c513d76a41886a088436d0ab98ea46987d2ee9a9e5112f62d115e3bd"
  });
  assert.deepEqual(snapshot.profile, {
    id: "baseline",
    checkerProfile: "standard",
    completionGates: ["ci"]
  });
  assert.equal(snapshot.templateCatalog.id, "fixture-catalog");
  assert.equal(snapshot.templateCatalog.version, "4.0.0");
  assert.match(snapshot.templateCatalog.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(snapshot.documents, [{
    slot: "task.plan",
    templateRef: "task.plan@7",
    materializeAs: "task_plan.md",
    locale: "en-US",
    requiredAnchors: ["## Goal"],
    bodyDigest: "sha256:149a285bb076d38ea2612eb53441c375664daa01833679bfd9ed0f0c1175ef30"
  }]);
  assert.equal("entrypoints" in snapshot, false);
  assert.equal("command" in snapshot, false);
});

test("task contract reader rejects executable or undeclared fields", () => {
  const body = JSON.stringify({
    schema: "task-contract-snapshot/v1",
    capturedAt: "2026-07-14T00:00:00.000Z",
    capturedBy: "legacy-migration",
    vertical: "software/coding",
    preset: {
      id: "standard-task",
      version: "1.0.0",
      digest: `sha256:${"0".repeat(64)}`
    },
    profile: { id: "baseline", checkerProfile: "standard", completionGates: ["ci"] },
    templateCatalog: {
      id: "software-coding-core",
      version: "1.1.0",
      digest: `sha256:${"1".repeat(64)}`
    },
    documents: [],
    command: "rm -rf /"
  });

  assert.throws(() => parseTaskContractSnapshot(body), /unknown field.*command/u);
});

test("task contract compiler preserves v1 preset behavior with legacy completion gates", () => {
  const snapshot = compileTaskContractSnapshot({
    vertical: "software/coding",
    preset: {
      schema: "preset-manifest/v1",
      id: "legacy-profiled-task",
      title: "Legacy Profiled Task",
      vertical: "software/coding",
      version: "1.0.0",
      kernelVersionRange: { min: "1.0.0" },
      capabilityImports: [],
      profiles: [{
        id: "baseline",
        title: "Baseline",
        checkerProfile: "legacy",
        templateSelections: []
      }],
      defaultProfile: "baseline"
    },
    catalog: {
      schema: "template-catalog/v2",
      package: {
        id: "fixture-catalog",
        title: "Fixture Catalog",
        version: "1.0.0",
        owner: "tests",
        locales: ["en-US"]
      },
      documents: []
    },
    documents: [],
    capturedAt: "2026-07-14T00:00:00.000Z",
    capturedBy: "task-create"
  });

  assert.deepEqual(snapshot.profile, {
    id: "baseline",
    checkerProfile: "legacy",
    completionGates: ["ci", "code-doc-reconciliation"]
  });
});

test("completion gates prefer the frozen snapshot without consulting the mutable registry", () => {
  const snapshot = parseTaskContractSnapshot(JSON.stringify({
    schema: "task-contract-snapshot/v1",
    capturedAt: "2026-07-14T00:00:00.000Z",
    capturedBy: "task-create",
    vertical: "software/coding",
    preset: { id: "retired-preset", version: "1.0.0", digest: `sha256:${"0".repeat(64)}` },
    profile: { id: "baseline", checkerProfile: "standard", completionGates: ["ci"] },
    templateCatalog: { id: "core", version: "1.0.0", digest: `sha256:${"1".repeat(64)}` },
    documents: []
  }));

  const result = resolveTaskCompletionGates({
    snapshot,
    vertical: "software/coding",
    preset: "retired-preset",
    profile: "baseline",
    legacyResolver: () => { throw new Error("registry must not be consulted"); }
  });

  assert.deepEqual(result, { ok: true, gates: ["ci"], source: "snapshot" });
});
