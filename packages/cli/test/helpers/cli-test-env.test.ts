// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { defaultRuntimeSessionEnvCandidates } from "../../../application/src/index.ts";
import { blankedCliTestEnvKeys, cliTestEnv } from "./cli-test-env.ts";

test("cliTestEnv blanks exactly the production session inputs and test authority manifest", () => {
  const productionSessionEnvKeys = defaultRuntimeSessionEnvCandidates.flatMap(({ keys }) => keys);
  const expectedBlankedKeys = [...new Set(["HARNESS_AUTHORITY_MANIFEST", ...productionSessionEnvKeys])].sort();
  const inheritedEnv = {
    UNRELATED_TEST_ENV: "preserved-value",
    ...Object.fromEntries(expectedBlankedKeys.map((key) => [key, "developer-machine-value"]))
  };
  const env = cliTestEnv({}, inheritedEnv);
  const actuallyBlankedKeys = Object.keys(inheritedEnv).filter((key) => env[key] === "").sort();

  assert.deepEqual(actuallyBlankedKeys, expectedBlankedKeys);
  assert.equal(env.UNRELATED_TEST_ENV, "preserved-value");
});

test("cliTestEnv applies explicit test overrides after isolation", () => {
  const [key] = blankedCliTestEnvKeys;
  const env = cliTestEnv({ [key]: "fixture-value" }, { [key]: "developer-machine-value" });

  assert.equal(env[key], "fixture-value");
});
