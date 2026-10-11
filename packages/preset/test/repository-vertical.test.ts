// harness-test-tier: integration
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import {
  compileRepoTaskBootstrap,
  compileRepoRepositoryScaffold,
  runPresetAction,
  createPresetProcessService,
  prepareBuiltinVerticalScriptExecution,
} from "../src/index.ts";
import { presetDocumentBody } from "../src/preset-catalog.ts";
import { createRuntime } from "../src/preset-runtime.ts";
import { waitFor } from "./preset-process-service.fixtures.ts";
import { write, writePackage } from "./preset-resolver.fixtures.ts";

const verticalId = "science/experiment";
const capability = { id: "completion-witness", kind: "checker", version: "1" };
function fixture() {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-repository-vertical-")),
    assets = path.join(rootDir, "verticals", "unrelated-directory-name");
  cpSync(new URL("../assets/software-coding/", import.meta.url), assets, { recursive: true });
  const vertical = JSON.parse(readFileSync(path.join(assets, "vertical.json"), "utf8"));
  vertical.id = verticalId;
  vertical.completion = {
    sources: {
      measurement: {
        kind: "command",
        entrypoint: "scripts/check",
        predicateType: "science/measurement/v1",
        resultSchema: {
          type: "object",
          additionalProperties: false,
          required: ["seed"],
          properties: { seed: { type: "integer" } },
        },
      },
    },
    gates: { measured: { source: "measurement", appliesTo: "artifacts", subjects: "all-artifacts" } },
    closeoutDefaults: { review: false, consent: false, factDisposition: false, codeDoc: false },
  };
  write(path.join(assets, "vertical.json"), JSON.stringify(vertical));
  const presets = path.join(assets, "presets");
  writePackage(presets, "experiment", {
    vertical: verticalId,
    outputShape: "artifact-only",
    profiles: [{ id: "baseline", title: "Baseline", completionGates: ["measured"], templateSelections: [] }],
  });
  writePackage(presets, "scripts", {
    vertical: verticalId,
    kind: "process-action",
    capabilityImports: [{ ...capability, required: true }],
    entrypoints: {
      check: {
        type: "script",
        intent: "Measure",
        inputs: [],
        requires: [],
        produces: [capability],
        sideEffects: [],
        command: "scripts/check.mjs",
      },
    },
  });
  const command = path.join(presets, "scripts/scripts/check.mjs");
  const body = (seed: number) =>
    `console.log(JSON.stringify({schema:"preset-script-result/v1",produces:[{capabilityId:"completion-witness",payload:{result:"pass",subjects:[],predicateType:"science/measurement/v1",predicate:{seed:${seed}}}}]}));`;
  write(command, body(42));
  const settings = { ...INITIAL_SETTINGS_V1, defaultVertical: verticalId, defaultPreset: "experiment" };
  const userRoot = path.join(rootDir, ".harness/presets");
  const action = (action: Record<string, unknown> & { kind: string }) => runPresetAction({ rootDir, settings, action });
  const create = (taskId: string) =>
    compileRepoTaskBootstrap({
      rootDir,
      settings,
      action: { kind: "task-create", title: "Experiment" },
      taskId,
      actor: { principal: { personId: "person-test" }, executor: null },
      source: "local",
      workspaceRevision: 1,
      eventId: `event-${taskId}`,
      opId: `op-${taskId}`,
      occurredAt: "2026-10-11T00:00:00.000Z",
    });
  return {
    rootDir,
    assets,
    vertical,
    presets,
    command,
    body,
    settings,
    userRoot,
    action,
    create,
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }),
  };
}

test("repository default shares discovery, scaffold, task freeze and live preset inventory", async () => {
  const f = fixture();
  const published: Array<Readonly<Record<string, unknown>>> = [];
  const port = {
    admitProduce: (kind: string) => kind === "completion-witness",
    publish: async (action: Readonly<Record<string, unknown>>) => {
      published.push(action);
      return { outcome: "applied" as const };
    },
  };
  const service = createPresetProcessService({
    rootDir: f.rootDir,
    userRoot: f.userRoot,
    readSettings: () => f.settings,
  });
  try {
    assert.equal(((await f.action({ kind: "vertical-validate" })) as { valid: boolean }).valid, true);
    const inspected = (await f.action({ kind: "preset-inspect", presetId: "experiment" })) as {
      snapshot: { digest: string; identity: { verticalId: string } };
    };
    assert.equal(inspected.snapshot.identity.verticalId, verticalId);
    assert.equal(
      (
        (await f.action({
          kind: "preset-check",
          presetId: "experiment",
          snapshotDigest: inspected.snapshot.digest,
        })) as { valid: boolean }
      ).valid,
      true,
    );
    assert.ok(((await f.action({ kind: "preset-list" })) as { id: string }[]).some(({ id }) => id === "experiment"));
    assert.match(
      presetDocumentBody({ repoRoot: f.rootDir, userRoot: f.userRoot, verticalId, presetId: "experiment" }),
      /# experiment/u,
    );
    assert.equal(compileRepoRepositoryScaffold(f.rootDir, f.settings).verticalId, verticalId);
    const scripts = (await f.action({ kind: "script-list" })) as { id: string }[];
    const prepared = prepareBuiltinVerticalScriptExecution({
      rootDir: f.rootDir,
      verticalId,
      commitSha: "a".repeat(40),
      action: {
        schema: "vertical-script-action/v1",
        kind: "script-run",
        scriptId: scripts[0]!.id,
        taskId: null,
        inputs: {},
        dryRun: true,
      },
    });
    assert.ok(prepared.command.startsWith(f.assets));
    const before = f.create("task-before");
    assert.equal(before.snapshot.profile.outputShape, "artifact-only");
    assert.equal(before.snapshot.completionPackages.measurement!.files["scripts/check.mjs"], f.body(42) + "\n");
    write(f.command, f.body(43));
    const after = f.create("task-after");
    assert.notEqual(before.snapshot.digest, after.snapshot.digest);
    assert.equal(after.snapshot.completionPackages.measurement!.files["scripts/check.mjs"], f.body(43) + "\n");
    const frozen = await service.startFrozen(
      { presetId: "scripts", entrypoint: "check", idempotencyKey: "frozen" },
      {
        package: before.snapshot.completionPackages.measurement!,
        snapshotDigest: before.snapshot.digest,
        inputFiles: {},
      },
      port,
    );
    assert.equal(frozen.outcome, "started");
    assert.equal(
      (
        await waitFor(
          "frozen completion",
          () => service.status(frozen.runId),
          ({ outcome }) => ["applied", "failed", "op_rejected", "outcome_unknown"].includes(outcome),
        )
      ).outcome,
      "applied",
    );
    assert.deepEqual(published[0]?.predicate, { seed: 42 });
    const live = await service.start({ presetId: "scripts", entrypoint: "check", idempotencyKey: "live" }, port);
    assert.equal(live.outcome, "started");
    assert.equal(
      (
        await waitFor(
          "live command",
          () => service.status(live.runId),
          ({ outcome }) => ["applied", "failed", "op_rejected", "outcome_unknown"].includes(outcome),
        )
      ).outcome,
      "applied",
    );
    assert.deepEqual(published[1]?.predicate, { seed: 43 });
    const runtime = createRuntime({ repoRoot: f.rootDir, userRoot: f.userRoot });
    assert.equal(
      runtime.resolveInternal({
        presetId: "standard-task",
        verticalId: "software/coding",
        locale: "en-US",
        purpose: "inspect",
      }).snapshot.identity.verticalId,
      "software/coding",
    );
  } finally {
    await service.close();
    f.cleanup();
  }
});

test("repository acceptance rejects unknown IDs, unknown sources, duplicate IDs and builtin overrides", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.action({ kind: "preset-inspect", presetId: "experiment", verticalId: "science/missing" }), {
      code: "missing_vertical",
    });
    f.vertical.completion.gates.measured.source = "unknown";
    write(path.join(f.assets, "vertical.json"), JSON.stringify(f.vertical));
    const invalid = (await f.action({ kind: "vertical-validate" })) as { valid: boolean; issues: { code: string }[] };
    assert.equal(invalid.valid, false);
    assert.equal(invalid.issues[0]!.code, "invalid_vertical");
    f.vertical.completion.gates.measured.source = "measurement";
    write(path.join(f.assets, "vertical.json"), JSON.stringify(f.vertical));
    write(path.join(f.rootDir, "verticals/duplicate/vertical.json"), JSON.stringify(f.vertical));
    await assert.rejects(f.action({ kind: "preset-list" }), { code: "duplicate_vertical" });
    f.vertical.id = "software/coding";
    write(path.join(f.rootDir, "verticals/duplicate/vertical.json"), JSON.stringify(f.vertical));
    await assert.rejects(f.action({ kind: "preset-inspect", presetId: "experiment" }), { code: "duplicate_vertical" });
  } finally {
    f.cleanup();
  }
});

test("Python entrypoints report unsupported interpreter before spawning for frozen and live runs", async () => {
  const f = fixture(),
    service = createPresetProcessService({ rootDir: f.rootDir, userRoot: f.userRoot, readSettings: () => f.settings });
  try {
    const task = f.create("task-python");
    const frozen = task.snapshot.completionPackages.measurement!;
    const port = { admitProduce: () => true, publish: async () => assert.fail("Python must not publish") };
    const result = await service.startFrozen(
      { presetId: "scripts", entrypoint: "check", idempotencyKey: "py" },
      {
        package: {
          ...frozen,
          entrypoint: { ...frozen.entrypoint, command: "scripts/check.py" },
          files: { "scripts/check.py": "print('unused')" },
        },
        snapshotDigest: task.snapshot.digest,
        inputFiles: {},
      },
      port,
    );
    assert.equal(result.code, "unsupported_interpreter");
    assert.deepEqual(result.phases, ["op_rejected"]);
    assert.match(result.nextAction!, /Python interpreter is not supported yet/u);
    const manifestPath = path.join(f.presets, "scripts/preset.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.entrypoints.check.command = "scripts/check.py";
    write(manifestPath, JSON.stringify(manifest));
    write(path.join(f.presets, "scripts/scripts/check.py"), "print('unused')");
    assert.equal(
      (await service.start({ presetId: "scripts", entrypoint: "check", idempotencyKey: "live-py" }, port)).code,
      "unsupported_interpreter",
    );
  } finally {
    await service.close();
    f.cleanup();
  }
});
