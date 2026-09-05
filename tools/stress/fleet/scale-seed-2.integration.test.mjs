// harness-test-tier: integration
import test from "node:test";
import { runFullScaleSeed } from "./scale-runner.mjs";

test("S4 full-scale fixed seed 2", { timeout: 900_000 }, async () => {
  await runFullScaleSeed(2);
});
