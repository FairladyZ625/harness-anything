// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { INITIAL_SETTINGS_V1, type TaskProjectionQueries } from "@harness-anything/kernel";
import { readEffectiveDispatchArchiveRetention } from "../src/repo-cell-settings-state.ts";

const projectionOf = (settingsValue: unknown): Pick<TaskProjectionQueries, "getEntity"> => ({
  getEntity: (entityKind: string, entityId: string) =>
    entityKind === "settings" && entityId === "repository" && settingsValue !== undefined
      ? { value: settingsValue }
      : null,
});

test("dispatch archive retention falls back to the declared defaults without a settings entity", () => {
  assert.deepEqual(readEffectiveDispatchArchiveRetention(projectionOf(undefined)), {
    retentionDays: INITIAL_SETTINGS_V1.dispatchArchive.retentionDays,
    retentionBytes: INITIAL_SETTINGS_V1.dispatchArchive.retentionBytes,
  });
  assert.equal(INITIAL_SETTINGS_V1.dispatchArchive.retentionDays, 60);
  assert.equal(INITIAL_SETTINGS_V1.dispatchArchive.retentionBytes, 0);
});

test("dispatch archive retention reads the repository settings, including limits disabled with 0", () => {
  assert.deepEqual(
    readEffectiveDispatchArchiveRetention(
      projectionOf({ dispatchArchive: { retentionDays: 7, retentionBytes: 53_687_091_200 } }),
    ),
    { retentionDays: 7, retentionBytes: 53_687_091_200 },
  );
  assert.deepEqual(
    readEffectiveDispatchArchiveRetention(projectionOf({ dispatchArchive: { retentionDays: 0, retentionBytes: 0 } })),
    { retentionDays: 0, retentionBytes: 0 },
  );
});

test("a settings entity from before the fields existed reads the defaults, not a hole", () => {
  assert.deepEqual(readEffectiveDispatchArchiveRetention(projectionOf({ defaultVertical: "software/coding" })), {
    retentionDays: 60,
    retentionBytes: 0,
  });
});
