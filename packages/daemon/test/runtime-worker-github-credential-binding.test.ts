// harness-test-tier: contract
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("runtime instance GitHub credential set and unset parse as instance-scoped commands", () => {
  const set = parseThinCommand([
      "runtime",
      "instance",
      "github-credential",
      "set",
      "codex-github-worker",
      "--ref",
      "keychain:harness/github-worker",
    ]),
    unset = parseThinCommand(["runtime", "instance", "github-credential", "unset", "codex-github-worker"]);

  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(unset.ok, true, JSON.stringify(unset));
  if (!set.ok || !unset.ok) return;
  assert.equal(set.command.method, "daemon.runtimeInstance.githubCredential.set");
  assert.deepEqual(set.command.action, {
    kind: "runtime-instance-github-credential-set",
    instanceId: "codex-github-worker",
    githubCredentialRef: "keychain:harness/github-worker",
  });
  assert.equal(unset.command.method, "daemon.runtimeInstance.githubCredential.unset");
  assert.deepEqual(unset.command.action, {
    kind: "runtime-instance-github-credential-unset",
    instanceId: "codex-github-worker",
  });
  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "github-credential",
      "set",
      "codex-github-worker",
      "--ref",
      "plaintext-token",
    ]).ok,
    false,
  );
});

test("set, unset, and show project only GitHub credential state without rebuilding the instance", async () => {
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
    });
    const providerAuth = store.read("codex-github-worker")!.auth,
      stateMarker = path.join(userRoot, "runtime-instances", "codex-github-worker", "binding-marker");
    writeFileSync(stateMarker, "preserved");

    const bound = store.command({
        kind: "runtime-instance-github-credential-set",
        instanceId: "codex-github-worker",
        githubCredentialRef: reference,
      }),
      environment = await store.prepareWorkerGitEnvironment("codex-github-worker"),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.deepEqual(environment, {
      HARNESS_GITHUB_TOKEN: secret,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
    });
    assert.equal((shown.instance as Record<string, unknown>).githubCredentialState, "configured");
    for (const receipt of [bound, shown]) {
      assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret, "u"));
      assert.doesNotMatch(JSON.stringify(receipt), /credential:v1:github-worker|githubCredentialRef/u);
    }

    const unbound = store.command({
        kind: "runtime-instance-github-credential-unset",
        instanceId: "codex-github-worker",
      }),
      shownAfterUnset = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.equal("githubCredentialState" in (unbound.instance as Record<string, unknown>), false);
    assert.equal("githubCredentialState" in (shownAfterUnset.instance as Record<string, unknown>), false);
    assert.equal(await store.prepareWorkerGitEnvironment("codex-github-worker"), null);
    assert.deepEqual(store.read("codex-github-worker")!.auth, providerAuth);
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    for (const receipt of [unbound, shownAfterUnset])
      assert.doesNotMatch(JSON.stringify(receipt), /credential:v1:github-worker|githubCredentialRef/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
