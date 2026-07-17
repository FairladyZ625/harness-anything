// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { runPairedQualification } from "./paired-qualification-benchmark.mjs";

test("paired qualification alternates baseline and candidate and reports median relative overhead", async () => {
  const calls = [];
  const result = await runPairedQualification({
    writerCounts: [1],
    rounds: 3,
    sourceCommit: "candidate-sha",
    baselineCommit: "baseline-sha",
    runArm: async ({ arm, round }) => {
      calls.push(`${round}:${arm}`);
      return {
        metrics: {
          submitToDurableReceiptMs: arm === "baseline" ? 10 + round : 12 + round,
          queueWaitMs: arm === "baseline" ? 2 : 3,
          commitIndexMs: arm === "baseline" ? 4 : 5,
          exactCutLocalApplyMs: arm === "baseline" ? 1 : 2,
          acknowledgementMs: arm === "baseline" ? 3 : 4
        },
        correctness: {
          committed: 1,
          durableReceipts: 1,
          exactCutLocalApplies: 1,
          acknowledgements: 1,
          disconnectRetries: 1,
          restartRecoveries: 1,
          guiConvergences: 1
        }
      };
    }
  });

  assert.deepEqual(calls, ["0:baseline", "0:candidate", "1:candidate", "1:baseline", "2:baseline", "2:candidate"]);
  assert.equal(result.schema, "production-client-paired-qualification/v1");
  assert.equal(result.scenarios[0].arms.baseline.medians.submitToDurableReceiptMs, 11);
  assert.equal(result.scenarios[0].arms.candidate.medians.submitToDurableReceiptMs, 13);
  assert.equal(result.scenarios[0].ratios.submitToDurableReceipt, 1.18);
  assert.deepEqual(result.scenarios[0].correctness, {
    committed: 6,
    durableReceipts: 6,
    exactCutLocalApplies: 6,
    acknowledgements: 6,
    disconnectRetries: 6,
    restartRecoveries: 6,
    guiConvergences: 6
  });
});
