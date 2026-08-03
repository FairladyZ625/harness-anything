if (process.env.HARNESS_CLI_TEST_FIXTURE_PRELOAD === "1") {
  globalThis[Symbol.for("harness-anything.cli-test-fixture-runner")] = createCliTestFixtureRunner();
}

export function createCliTestFixtureRunner(loadFixture = loadCliTestFixture) {
  let fixturePromise;
  return async (command) => {
    fixturePromise ??= loadFixture();
    const { runRegisteredCommandWithCliComposition, toCommandReceipt } = await fixturePromise;
    return toCommandReceipt(await runRegisteredCommandWithCliComposition(command, {
      localCoordinatorScope: "test-fixture",
      // task-submit no longer has a client facade. Integration fixtures that
      // need an authored submitted round still exercise the declared command
      // and the application planner, while production-ingress tests cover the
      // daemon compiler and canonical publication path.
      ...(command?.action?.kind === "task-submit"
        ? { inlineCreateProvenanceOnly: true }
        : {})
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
