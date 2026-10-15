// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1, localSettings, type LocalSettingsV1 } from "@harness-anything/kernel";
import { makeRepoCellSettingsState } from "../src/repo-cell-settings-state.ts";

function settingsStateFor(rootDir: string, appended: { count: number } = { count: 0 }) {
  const repository = {
      schema: "settings/v1",
      settingsId: "repository",
      defaultVertical: INITIAL_SETTINGS_V1.defaultVertical,
      defaultPreset: INITIAL_SETTINGS_V1.defaultPreset,
      defaultProfile: INITIAL_SETTINGS_V1.defaultProfile,
      scaffolds: INITIAL_SETTINGS_V1.scaffolds,
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
      locale: "zh-CN",
      gui: { connectTimeoutMs: 2000, requestTimeoutMs: 30000 },
    });
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
