// harness-test-tier: contract
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const installation: RuntimeInstallationWitness = {
  installationId: "codex-github-worker-installation",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "1.0.0",
  observedAt: "2026-08-25T00:00:00.000Z",
};

test("runtime instance hosting credential set and unset parse as instance-scoped commands", () => {
  const set = parseThinCommand([
      "runtime",
      "instance",
      "hosting-credential",
      "set",
      "codex-github-worker",
      "--provider",
      "gitlab",
      "--ref",
      "keychain:harness/gitlab-worker",
    ]),
    unset = parseThinCommand([
      "runtime",
      "instance",
      "hosting-credential",
      "unset",
      "codex-github-worker",
      "--provider",
      "gitlab",
    ]);

  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(unset.ok, true, JSON.stringify(unset));
  if (!set.ok || !unset.ok) return;
  assert.equal(set.command.method, "daemon.runtimeInstance.hostingCredential.set");
  assert.deepEqual(set.command.action, {
    kind: "runtime-instance-hosting-credential-set",
    instanceId: "codex-github-worker",
    provider: "gitlab",
    credentialRef: "keychain:harness/gitlab-worker",
  });
  assert.equal(unset.command.method, "daemon.runtimeInstance.hostingCredential.unset");
  assert.deepEqual(unset.command.action, {
    kind: "runtime-instance-hosting-credential-unset",
    instanceId: "codex-github-worker",
    provider: "gitlab",
    credentialRef: undefined,
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

test("hosting credentials stay daemon-side and only configured provider reaches its git child", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-github-credential-")),
    secret = randomUUID(),
    reference = "credential:v1:gitlab-worker";
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
        kind: "runtime-instance-hosting-credential-set",
        instanceId: "codex-github-worker",
        provider: "gitlab",
        credentialRef: reference,
      }),
      environment = await store.prepareDaemonGitEnvironment("codex-github-worker", "gitlab"),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.deepEqual(environment, {
      GITLAB_TOKEN: secret,
      HARNESS_GITLAB_TOKEN: secret,
      GIT_ASKPASS_REQUIRE: "force",
      GIT_TERMINAL_PROMPT: "0",
    });
    assert.equal((shown.instance as Record<string, unknown>).hostingCredentialState, "configured");
    assert.equal("GH_TOKEN" in environment!, false);
    const workerEnvironment = { PATH: "/usr/bin", HOME: userRoot };
    assert.equal(
      Object.keys(workerEnvironment).some((key) => /(?:GH_TOKEN|GITLAB_TOKEN|HARNESS_.*TOKEN)/u.test(key)),
      false,
    );
    for (const receipt of [bound, shown]) {
      assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret, "u"));
      assert.doesNotMatch(
        JSON.stringify(receipt),
        /credential:v1:gitlab-worker|githubCredentialRef|hostingCredentialRefs/u,
      );
    }

    const unbound = store.command({
        kind: "runtime-instance-hosting-credential-unset",
        instanceId: "codex-github-worker",
        provider: "gitlab",
      }),
      shownAfterUnset = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.equal("hostingCredentialState" in (unbound.instance as Record<string, unknown>), false);
    assert.equal("hostingCredentialState" in (shownAfterUnset.instance as Record<string, unknown>), false);
    assert.equal(await store.prepareDaemonGitEnvironment("codex-github-worker", "gitlab"), null);
    assert.deepEqual(store.read("codex-github-worker")!.auth, providerAuth);
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    for (const receipt of [unbound, shownAfterUnset])
      assert.doesNotMatch(
        JSON.stringify(receipt),
        /credential:v1:gitlab-worker|githubCredentialRef|hostingCredentialRefs/u,
      );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
