// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { INITIAL_SETTINGS_V1 } from "../../kernel/src/index.ts";
import { makeRepoCellSettingsActions } from "../src/repo-cell-settings-actions.ts";

test("locale updates stay local and do not append a settings event", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-local-"));
  try {
    mkdirSync(path.join(rootDir, "harness"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/harness.yaml"), "settings:\n  defaultVertical: software/coding\n");
    const repository = {
        schema: "settings/v1",
        settingsId: "repository",
        defaultVertical: INITIAL_SETTINGS_V1.defaultVertical,
        defaultPreset: INITIAL_SETTINGS_V1.defaultPreset,
        defaultProfile: INITIAL_SETTINGS_V1.defaultProfile,
        scaffolds: INITIAL_SETTINGS_V1.scaffolds,
      },
      appended = { count: 0 },
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
      },
      actions = makeRepoCellSettingsActions(cell),
      receipt = await actions.update(
        { kind: "settings-update", locale: "zh-CN" },
        { actor: { principal: { personId: "p" }, executor: null }, source: "local" },
      );
    assert.equal(receipt.outcome, "applied");
    assert.equal(appended.count, 0);
    assert.equal(actions.read().locale, "zh-CN");
    const localPath = path.join(rootDir, ".harness/settings.local.json");
    assert.equal(existsSync(localPath), true);
    assert.deepEqual(JSON.parse(readFileSync(localPath, "utf8")), { schema: "settings-local/v1", locale: "zh-CN" });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
