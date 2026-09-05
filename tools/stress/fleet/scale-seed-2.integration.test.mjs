// harness-test-tier: integration
import test from "node:test";
import { runFullScaleSeed } from "./scale-runner.mjs";

// One seed is 1,000,000 accepted events, 100,000 blobs and two cold rebuilds:
// about sixteen minutes on the ten-vCPU isolated target and past the CI
// per-file watchdog. It is an operator run on the isolated target, opted in
// with HARNESS_STRESS_FULL_SCALE=1; calibration stays in CI.
const fullScaleRequested = process.env.HARNESS_STRESS_FULL_SCALE === "1";

test(
  "S4 full-scale fixed seed 2",
  {
    timeout: 900_000,
    skip: fullScaleRequested ? false : "operator-only full-scale run; set HARNESS_STRESS_FULL_SCALE=1",
  },
  async () => {
    await runFullScaleSeed(2);
  },
);
