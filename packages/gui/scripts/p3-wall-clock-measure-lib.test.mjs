import assert from "node:assert/strict";
import test from "node:test";
import { evaluateFiveKFirstScreenMet } from "./p3-wall-clock-measure-lib.mjs";

test("5k first-screen fails when launch is over budget even if in-app navigation is fast", () => {
  assert.equal(evaluateFiveKFirstScreenMet({
    size: 5_000,
    overviewLaunchToUsableMs: 15_662,
    executionsFirstNavMs: 3_436,
  }), false);
});
