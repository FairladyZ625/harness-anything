// harness-test-tier: contract
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const installation: RuntimeInstallationWitness = {
  installationId: "codex-github-worker-installation",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "1.0.0",
  observedAt: "2026-08-25T00:00:00.000Z",
};

test("runtime instance create accepts a distinct GitHub credential reference", () => {
  const parsed = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-github-worker",
    "--name",
    "Codex GitHub Worker",
    "--kind",
    "codex",
    "--installation",
    installation.installationId,
    "--provider",
    "openai",
    "--model",
    "gpt-5.6-sol",
    "--auth",
    "subscription",
    "--github-credential-ref",
    "credential:v1:github-worker",
  ]);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "daemon.runtimeInstance.create");
  assert.deepEqual(parsed.command.action, {
    kind: "runtime-instance-create",
    instanceId: "codex-github-worker",
    name: "Codex GitHub Worker",
    kindId: "codex",
    installationId: installation.installationId,
    providerId: "openai",
    models: ["gpt-5.6-sol"],
    codex: {},
    authMode: "subscription",
    githubCredentialRef: "credential:v1:github-worker",
  });
});

test("GitHub credentials resolve only into the worker Git environment and stay out of public receipts", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-credential-")),
    secret = randomUUID(),
    reference = "credential:v1:github-worker";
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [installation],
      resolveCredential: async (candidate) => {
        assert.equal(candidate, reference);
        return secret;
      },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-github-worker",
      name: "Codex GitHub Worker",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
      githubCredentialRef: reference,
    });

    const environment = await store.prepareWorkerGitEnvironment("codex-github-worker"),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.deepEqual(environment, {
      HARNESS_GITHUB_TOKEN: secret,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
    });
    assert.equal((shown.instance as Record<string, unknown>).githubCredentialState, "configured");
    assert.doesNotMatch(JSON.stringify(shown), new RegExp(secret, "u"));
    assert.doesNotMatch(JSON.stringify(shown), /credential:v1:github-worker|githubCredentialRef/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
