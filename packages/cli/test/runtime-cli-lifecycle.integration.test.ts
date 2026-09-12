// harness-test-tier: integration
import test from "node:test";
import { runRuntimeCliLifecycleScenario } from "./runtime-cli.fixture.ts";

test("real CLI runs the runtime lifecycle", async (context) => {
  await runRuntimeCliLifecycleScenario(context);
});
