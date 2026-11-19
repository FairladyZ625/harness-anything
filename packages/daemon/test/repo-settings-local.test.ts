// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, localSettings, repositorySettings, type LocalSettingsV1 } from "@harness-anything/kernel";
import { nodeMaterializationStorage } from "../src/daemon-host/node-materialization-settings.ts";
import { makeRepoCellSettingsState } from "../src/daemon-host/repo-cell-settings-state.ts";
import { applyLocalAgentBinding } from "../src/daemon-host/runtime-spawn-agent.ts";
import { resolveRuntimeInstanceCandidates } from "../src/daemon-host/runtime-spawn-mission.ts";

function settingsStateFor(rootDir: string, appended: { count: number } = { count: 0 }) {
  const repository = {
      schema: "settings/v1",
      settingsId: "repository",
      defaultVertical: INITIAL_SETTINGS_V1.defaultVertical,
      defaultPreset: INITIAL_SETTINGS_V1.defaultPreset,
      defaultProfile: INITIAL_SETTINGS_V1.defaultProfile,
      scaffolds: INITIAL_SETTINGS_V1.scaffolds,
      decisions: { enabledPoints: ["example@0123456789ab"] },
      runtime: { allowedKinds: ["codex"] },
    },
    cell = {
      rootDir,
      input: { repoId: "settings-local" },
      projection: { getEntity: () => ({ value: repository }) },
      store: {
        readHead: () => ({ revision: 3 }),
        append: () => {
          appended.count += 1;
          throw new Error("local settings must not append");
        },
      },
      cellCodedError: (_code: string, message: string) => new Error(message),
      operationId: () => "settings-local-op",
      now: () => "2026-08-27T00:00:00.000Z",
    };
  return makeRepoCellSettingsState(cell);
}

test("local state stays local and does not append a settings event", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-local-"));
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  defaultVertical: software/coding\n");
    const appended = { count: 0 },
      settings = settingsStateFor(rootDir, appended),
      changed = settings.writeLocal(localSettings({ locale: "zh-CN" }));
    assert.equal(changed, true);
    assert.equal(appended.count, 0);
    assert.equal(settings.read().locale, "zh-CN");
    const localPath = path.join(rootDir, ".harness/settings.local.json");
    assert.equal(existsSync(localPath), true);
    assert.deepEqual(JSON.parse(readFileSync(localPath, "utf8")), {
      schema: "settings-local/v1",
      nodeTaskMaterializationPolicy: "include_done",
      locale: "zh-CN",
      gui: { connectTimeoutMs: 2000, requestTimeoutMs: 30000, terminalBrowser: "embedded" },
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local provider and Agent bindings overlay the shared capability and decision point settings", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-local-provider-bindings-"));
  try {
    const state = settingsStateFor(rootDir);
    state.writeLocal(
      localSettings({
        decisions: { provider: "local-decisions" },
        runtime: { allowedInstances: ["local-codex", "local-backup"] },
        runtimeAgentBindings: [{ agentId: "worker", instance: "local-codex", preferredInstances: ["local-backup"] }],
      }),
    );
    const settings = state.read();
    assert.deepEqual(settings.decisions, { enabledPoints: ["example@0123456789ab"], provider: "local-decisions" });
    assert.deepEqual(settings.runtime.allowedKinds, ["codex"]);
    assert.deepEqual(settings.runtime.allowedInstances, ["local-codex", "local-backup"]);
    assert.equal(Object.hasOwn(repositorySettings(settings).runtime, "allowedInstances"), false);
    assert.equal(Object.hasOwn(repositorySettings(settings).decisions, "provider"), false);
    const worker = { id: "worker", name: "Worker", instructions: "Work.", runtimes: [{ type: "codex" }] };
    const pinnedWorker = applyLocalAgentBinding({ readSettings: state.read }, worker);
    assert.deepEqual(pinnedWorker, {
      ...worker,
      instance: "local-codex",
      preferredInstances: ["local-backup"],
    });
    const instances = [
      {
        instanceId: "local-backup",
        kindId: "codex",
        models: ["gpt-6.1-sol"],
        enabled: true,
        authReadiness: { status: "ready", code: null, hint: null },
      },
      {
        instanceId: "local-codex",
        kindId: "codex",
        models: ["gpt-6.1-sol"],
        enabled: true,
        authReadiness: { status: "ready", code: null, hint: null },
      },
    ] as never;
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: pinnedWorker,
        instances,
        sessions: [],
        allowedInstanceIds: settings.runtime.allowedInstances,
      }),
      ["local-codex"],
    );

    state.writeLocal(
      localSettings({
        runtime: { allowedInstances: ["local-codex", "local-backup"] },
        runtimeAgentBindings: [{ agentId: "worker", preferredInstances: ["local-backup"] }],
      }),
    );
    const preferredWorker = applyLocalAgentBinding({ readSettings: state.read }, worker);
    assert.deepEqual(
      resolveRuntimeInstanceCandidates({
        agent: preferredWorker,
        instances,
        sessions: [],
        allowedInstanceIds: state.read().runtime.allowedInstances,
      }),
      ["local-backup", "local-codex"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a local file written before the gui fields existed reads back with their declared defaults", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-local-legacy-"));
  try {
    mkdirSync(path.join(rootDir, ".harness"), { recursive: true });
    writeFileSync(
      path.join(rootDir, ".harness/settings.local.json"),
      `${JSON.stringify({ schema: "settings-local/v1", locale: "zh-CN" })}\n`,
    );
    const settings = settingsStateFor(rootDir),
      local = settings.readLocal();
    assert.equal(local.locale, "zh-CN");
    assert.equal(local.gui.connectTimeoutMs, 2000);
    assert.equal(local.gui.requestTimeoutMs, 30_000);
    assert.equal(local.gui.terminalBrowser, "embedded");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a gui deadline update keeps the machine's current locale and takes effect on read", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-local-gui-"));
  try {
    mkdirSync(path.join(rootDir, ".harness"), { recursive: true });
    const settings = settingsStateFor(rootDir),
      current = settings.readLocal(),
      raised: LocalSettingsV1 = { ...current, gui: { ...current.gui, requestTimeoutMs: 60_000 } },
      changed = settings.writeLocal(raised);
    assert.equal(changed, true);
    assert.equal(settings.read().locale, current.locale);
    assert.equal(settings.read().gui.requestTimeoutMs, 60_000);
    // Writing the same value again is no change.
    assert.equal(settings.writeLocal(raised), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("role defaults survive old preference files and local policy updates reach live configurations only on this node", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-policy-")),
    other = mkdtempSync(path.join(tmpdir(), "ha-settings-policy-other-"));
  try {
    mkdirSync(path.join(rootDir, ".harness"));
    writeFileSync(
      path.join(rootDir, ".harness/settings.local.json"),
      JSON.stringify({ schema: "settings-local/v1", locale: "zh-CN" }),
    );
    const center = nodeMaterializationStorage({ rootDir, mode: "remote-center" }),
      edge = nodeMaterializationStorage({ rootDir, mode: "remote-edge" }),
      otherNode = nodeMaterializationStorage({ rootDir: other, mode: "remote-edge" });
    assert.equal(center.nodeTaskMaterializationPolicy, "none");
    assert.equal(edge.nodeTaskMaterializationPolicy, "in_flight");
    const settings = settingsStateFor(rootDir);
    settings.writeLocal({ ...settings.readLocal(), nodeTaskMaterializationPolicy: "include_done" });
    assert.equal(edge.nodeTaskMaterializationPolicy, "include_done");
    assert.equal(center.nodeTaskMaterializationPolicy, "include_done");
    assert.equal(otherNode.nodeTaskMaterializationPolicy, "in_flight");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
