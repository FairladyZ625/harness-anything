// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { blankedCliTestEnvKeys, cliTestEnv } from "./cli-test-env.ts";

test("cliTestEnv blanks every inherited agent session input", () => {
  const inheritedEnv = Object.fromEntries(blankedCliTestEnvKeys.map((key) => [key, "developer-machine-value"]));
  const env = cliTestEnv({}, inheritedEnv);

  for (const key of blankedCliTestEnvKeys) assert.equal(env[key], "");
});

test("cliTestEnv applies explicit test overrides after isolation", () => {
  const [key] = blankedCliTestEnvKeys;
  const env = cliTestEnv({ [key]: "fixture-value" }, { [key]: "developer-machine-value" });

  assert.equal(env[key], "fixture-value");
});
