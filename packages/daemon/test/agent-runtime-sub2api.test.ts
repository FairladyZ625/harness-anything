// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeHttpHeaders } from "../src/agent-runtime-instance-config.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

test("Codex private HTTP API-key launch writes the credential only to its contracted header", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-secret-header-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-sub2api",
      name: "Codex sub2api",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "sub2api",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "read-only",
      isolationState: "enforced",
      codex: {
        baseUrl: "http://192.168.1.20:8080/v1",
        allowInsecureHttp: true,
        wireApi: "responses",
        credentialHeader: "x-api-key",
      },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-sub2api" },
    });
    const launch = await store.prepareLaunch("codex-sub2api", { cwd: "/workspace/repo", prompt: "Inspect" });
    const configText = readFileSync(path.join(launch.env.CODEX_HOME!, "config.toml"), "utf8");
    assert.match(configText, /http_headers = \{ "x-api-key" = "instance-secret" \}/u);
    assert.match(configText, /requires_openai_auth = false/u);
    assert.doesNotMatch(configText, /experimental_bearer_token/u);
    assert.doesNotMatch(JSON.stringify(launch), /instance-secret/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Codex private HTTP and credential-header configuration preserves its trust boundaries", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-private-http-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const common = {
      schemaVersion: 2 as const,
      name: "Codex private",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "sub2api",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "enforced" as const,
      auth: { mode: "api-key" as const, credentialRef: "credential:v1:codex-private" },
    };
    assert.throws(
      () => store.create({ ...common, instanceId: "without-flag", codex: { baseUrl: "http://10.0.0.2/v1" } }),
      (error: unknown) => codedAs(error, "invalid_base_url"),
    );
    assert.throws(
      () =>
        store.create({
          ...common,
          instanceId: "public-http",
          codex: { baseUrl: "http://8.8.8.8/v1", allowInsecureHttp: true },
        }),
      (error: unknown) => codedAs(error, "invalid_base_url"),
    );
    assert.throws(
      () =>
        store.create({
          ...common,
          instanceId: "header-collision",
          codex: { httpHeaders: { "X-Custom": "static" }, credentialHeader: "x-custom" },
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_credential_header"),
    );
    assert.deepEqual(runtimeHttpHeaders({ "X-Custom": "static" }), { "X-Custom": "static" });
    assert.throws(
      () => runtimeHttpHeaders({ "X-Custom": "first", "x-custom": "second" }),
      (error: unknown) => codedAs(error, "invalid_runtime_http_headers"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
