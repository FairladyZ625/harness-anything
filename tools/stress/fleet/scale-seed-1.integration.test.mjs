// harness-test-tier: integration
import test from "node:test";
import { runFullScaleSeed } from "./scale-runner.mjs";

test("S4 full-scale fixed seed 1", { timeout: 900_000 }, async () => {
  await runFullScaleSeed(1);
});
