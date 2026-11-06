// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1, validateSettingsV1, withoutUndeclaredSettingsFields } from "../../src/index.ts";

test("read-side settings projection ignores fields a newer daemon added", () => {
  const newer = {
    ...INITIAL_SETTINGS_V1,
    daemonAddedSection: { enabled: true },
    runtime: { ...INITIAL_SETTINGS_V1.runtime, daemonAddedSetting: ["new-value"] },
  };
  assert.deepEqual(validateSettingsV1(withoutUndeclaredSettingsFields(newer)), []);
  assert.notDeepEqual(validateSettingsV1(newer), [], "the write boundary keeps the closed Settings schema");
});

test("read-side settings projection still rejects malformed declared fields", () => {
  const malformed = {
    ...INITIAL_SETTINGS_V1,
    runtime: { ...INITIAL_SETTINGS_V1.runtime, allowedInstances: "not-an-array" },
  };
  assert.match(validateSettingsV1(withoutUndeclaredSettingsFields(malformed)).join("\n"), /allowedInstances/u);
});
