// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePresetUninstallImpact,
  evaluatePresetRuntimeAvailability,
  resolveTaskCompletionGates,
  type PresetUninstallTaskReference
} from "../src/index.ts";
import { stablePayloadHash, type PresetManifest, type TaskContractSnapshot } from "../../kernel/src/index.ts";

const declarativeTarget = {
  id: "fixture-preset",
  version: "1.2.3",
  runtimeRequirement: "none"
} as const;

test("preset uninstall allows terminal tasks with a matching snapshot", () => {
  const report = analyzePresetUninstallImpact({
    preset: { ...declarativeTarget, runtimeRequirement: "required" },
    tasks: [taskReference({ status: "done" })]
  });

  assert.equal(report.allowed, true);
  assert.equal(report.blockerCount, 0);
  assert.deepEqual(report.tasks.map((entry) => ({ decision: entry.decision, reason: entry.reason })), [
    { decision: "allow", reason: "terminal_snapshot_self_contained" }
  ]);
});

test("preset uninstall allows nonterminal tasks whose contract is declarative", () => {
  const report = analyzePresetUninstallImpact({
    preset: declarativeTarget,
    tasks: [taskReference({ status: "active" }), taskReference({ taskId: "task_review", status: "in_review" })]
  });

  assert.equal(report.allowed, true);
  assert.equal(report.inboundTaskCount, 2);
  assert.deepEqual(report.tasks.map((entry) => entry.reason), [
    "declarative_snapshot_self_contained",
    "declarative_snapshot_self_contained"
  ]);
});

test("preset uninstall blocks nonterminal tasks that require preset private runtime", () => {
  const report = analyzePresetUninstallImpact({
    preset: { ...declarativeTarget, runtimeRequirement: "required" },
    tasks: [taskReference({ status: "active" })]
  });

  assert.equal(report.allowed, false);
  assert.equal(report.blockerCount, 1);
  assert.equal(report.tasks[0]?.decision, "block");
  assert.equal(report.tasks[0]?.reason, "preset_private_runtime_required");
});

test("preset uninstall fails closed for every inbound task without a proven snapshot", () => {
  const cases: ReadonlyArray<PresetUninstallTaskReference> = [
    taskReference({ taskId: "task_missing", status: "done", snapshot: undefined }),
    taskReference({ taskId: "task_invalid", status: "active", snapshot: undefined, snapshotError: "invalid JSON" }),
    taskReference({
      taskId: "task_mismatch",
      status: "in_review",
      snapshot: snapshot({ preset: { id: "other-preset", version: "1.0.0", digest: digest("9") } })
    })
  ];

  const report = analyzePresetUninstallImpact({ preset: declarativeTarget, tasks: cases });

  assert.equal(report.allowed, false);
  assert.equal(report.blockerCount, 3);
  assert.deepEqual(report.tasks.map((entry) => entry.reason), [
    "task_contract_snapshot_missing",
    "task_contract_snapshot_invalid",
    "task_contract_snapshot_metadata_mismatch"
  ]);
});

test("preset uninstall treats archived packages as terminal and unknown runtime analysis as blocking only for open tasks", () => {
  const report = analyzePresetUninstallImpact({
    preset: { id: "fixture-preset", version: "unknown", runtimeRequirement: "unknown" },
    tasks: [
      taskReference({ taskId: "task_archived", status: "active", packageDisposition: "archived" }),
      taskReference({ taskId: "task_open", status: "blocked" })
    ]
  });

  assert.equal(report.allowed, false);
  assert.deepEqual(report.tasks.map((entry) => entry.reason), [
    "terminal_snapshot_self_contained",
    "preset_private_runtime_unknown"
  ]);
});

test("preset runtime availability is frozen to the task snapshot identity", () => {
  const installed = presetManifest();
  const frozen = snapshot({
    preset: {
      id: installed.id,
      version: installed.version,
      digest: `sha256:${stablePayloadHash(installed)}`
    }
  });

  assert.deepEqual(evaluatePresetRuntimeAvailability({
    requestedPresetId: "fixture-preset",
    snapshot: frozen,
    installedPreset: installed
  }), { status: "available" });

  assert.deepEqual(evaluatePresetRuntimeAvailability({
    requestedPresetId: "fixture-preset",
    snapshot: frozen
  }), {
    status: "unavailable",
    preset: { id: "fixture-preset", version: "1.2.3" },
    reason: "not_installed"
  });

  assert.deepEqual(evaluatePresetRuntimeAvailability({
    requestedPresetId: "fixture-preset",
    snapshot: frozen,
    installedPreset: { ...installed, version: "9.9.9" }
  }), {
    status: "unavailable",
    preset: { id: "fixture-preset", version: "1.2.3" },
    reason: "identity_mismatch"
  });

  assert.deepEqual(evaluatePresetRuntimeAvailability({
    requestedPresetId: "other-preset",
    snapshot: frozen
  }), { status: "not_applicable" });

  assert.deepEqual(resolveTaskCompletionGates({
    snapshot: frozen,
    vertical: "software/coding",
    preset: "fixture-preset",
    profile: "baseline",
    legacyResolver: () => { throw new Error("uninstalled registry must not be consulted"); }
  }), { ok: true, gates: ["ci"], source: "snapshot" });
});

function taskReference(overrides: Partial<PresetUninstallTaskReference> = {}): PresetUninstallTaskReference {
  return {
    taskId: "task_fixture",
    status: "active",
    packageDisposition: "active",
    metadata: {
      vertical: "software/coding",
      presetId: "fixture-preset",
      profileId: "baseline"
    },
    snapshot: snapshot(),
    ...overrides
  };
}

function snapshot(overrides: Partial<TaskContractSnapshot> = {}): TaskContractSnapshot {
  return {
    schema: "task-contract-snapshot/v1",
    capturedAt: "2026-07-14T00:00:00.000Z",
    capturedBy: "task-create",
    vertical: "software/coding",
    preset: { id: "fixture-preset", version: "1.2.3", digest: digest("a") },
    profile: { id: "baseline", checkerProfile: "standard", completionGates: ["ci"] },
    templateCatalog: { id: "core", version: "1.0.0", digest: digest("b") },
    documents: [],
    ...overrides
  };
}

function presetManifest(): PresetManifest {
  return {
    schema: "preset-manifest/v2",
    id: "fixture-preset",
    title: "Fixture Preset",
    vertical: "software/coding",
    version: "1.2.3",
    kind: "process-action",
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
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
