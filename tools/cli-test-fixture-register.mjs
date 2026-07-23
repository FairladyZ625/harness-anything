if (process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD === "1") {
  globalThis[Symbol.for("harness-anything.cli-test-fixture-runner")] = createCliTestFixtureRunner();
}

export function createCliTestFixtureRunner(loadFixture = loadCliTestFixture) {
  let fixturePromise;
  return async (command) => {
    fixturePromise ??= loadFixture();
    const { runRegisteredCommandWithCliComposition, toCommandReceipt } = await fixturePromise;
    return toCommandReceipt(await runRegisteredCommandWithCliComposition(command, {
      localCoordinatorScope: "test-fixture"
    }));
  };
}

async function loadCliTestFixture() {
  const [{ toCommandReceipt }, { runRegisteredCommandWithCliComposition }] = await Promise.all([
    import("../packages/cli/src/cli/receipt.ts"),
    import("../packages/cli/src/composition/command-executor.ts")
  ]);
  return { runRegisteredCommandWithCliComposition, toCommandReceipt };
}
