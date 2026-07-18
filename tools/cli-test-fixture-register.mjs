import { toCommandReceipt } from "../packages/cli/src/cli/receipt.ts";
import { runRegisteredCommandWithCliComposition } from "../packages/cli/src/composition/command-executor.ts";

if (process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD === "1") {
  globalThis[Symbol.for("harness-anything.cli-test-fixture-runner")] = async (command) =>
    toCommandReceipt(await runRegisteredCommandWithCliComposition(command, {
      localCoordinatorScope: "test-fixture"
    }));
}
