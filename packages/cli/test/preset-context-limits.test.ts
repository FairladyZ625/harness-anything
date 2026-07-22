// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { resolvePresetContextMilestoneLimits } from "../src/commands/extensions/preset-script-context.ts";

test("preset context limits resolve explicit options over environment and preserve defaults", () => {
  assert.deepEqual(resolvePresetContextMilestoneLimits({ env: {} }), { maxFiles: 20, maxNotes: 3 });
  assert.deepEqual(resolvePresetContextMilestoneLimits({
    env: {
      HARNESS_PRESET_CONTEXT_MAX_MILESTONES: "30",
      HARNESS_PRESET_CONTEXT_MAX_NOTES: "5"
    }
  }), { maxFiles: 30, maxNotes: 5 });
  assert.deepEqual(resolvePresetContextMilestoneLimits({
    maxMilestoneFiles: 4,
    maxMilestoneNotes: 2,
    env: {
      HARNESS_PRESET_CONTEXT_MAX_MILESTONES: "30",
      HARNESS_PRESET_CONTEXT_MAX_NOTES: "5"
    }
  }), { maxFiles: 4, maxNotes: 2 });
});

test("preset context limits reject invalid environment values", () => {
  assert.throws(() => resolvePresetContextMilestoneLimits({
    env: { HARNESS_PRESET_CONTEXT_MAX_MILESTONES: "0" }
  }), /HARNESS_PRESET_CONTEXT_MAX_MILESTONES/u);
  assert.throws(() => resolvePresetContextMilestoneLimits({
    env: { HARNESS_PRESET_CONTEXT_MAX_NOTES: "all" }
  }), /HARNESS_PRESET_CONTEXT_MAX_NOTES/u);
});
