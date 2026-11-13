// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";

const parse = (payload: Record<string, unknown>) =>
  parseDaemonRpcParams("daemon.runtimeInstance.update", { payload: { instanceId: "claude-api-test", ...payload } });
const parseCreate = (payload: Record<string, unknown>) =>
  parseDaemonRpcParams("daemon.runtimeInstance.create", {
    payload: {
      instanceId: "agy-api-test",
      name: "AGY API test",
      kindId: "agy",
      providerId: "google",
      models: [],
      authMode: "subscription",
      ...payload,
    },
  });

test("runtime instance RPC accepts clearing endpoint and effort through the existing update route", () => {
  const payload = {
    name: "Claude API test",
    installationId: "claude-install-test",
    models: ["fable", "sonnet", "opus"],
    defaultModel: "opus",
    baseUrl: "https://example.test/",
    effort: "",
  };
  assert.equal(parse(payload).ok, true);
  assert.equal(parse({ ...payload, baseUrl: "" }).ok, true);
  assert.equal(parse({ models: ["sonnet", "opus"] }).ok, true);
  assert.equal(parse({ baseUrl: "https://example.test/", effort: "high" }).ok, true);
  assert.equal(parse({ webSearch: "live" }).ok, true);
  assert.equal(parse({ webSearch: "" }).ok, true);
  assert.equal(parse({ credentialSource: "instance" }).ok, true);
  assert.equal(parse({ credentialSource: "operator" }).ok, true);
  assert.equal(parse({ credentialSource: "third-party" }).ok, false);
  assert.equal(parseCreate({ credentialSource: "instance" }).ok, true);
  assert.equal(parseCreate({ credentialSource: "operator" }).ok, true);
  assert.equal(parseCreate({ credentialSource: "third-party" }).ok, false);
});

test("runtime instance RPC keeps non-clearable strings and clearable value types constrained", () => {
  for (const field of ["instanceId", "name", "installationId", "defaultModel"])
    assert.equal(parse({ [field]: "" }).ok, false, field);
  for (const field of ["baseUrl", "effort", "webSearch"])
    for (const value of [null, false, 0, [], {}])
      assert.equal(parse({ [field]: value }).ok, false, `${field}: ${JSON.stringify(value)}`);
  assert.equal(parse({ apiKey: "fake-key-must-only-enter-the-target-vault" }).ok, true);
  assert.equal(parse({ credentialRef: "credential:v1:client-chosen" }).ok, false);
});
