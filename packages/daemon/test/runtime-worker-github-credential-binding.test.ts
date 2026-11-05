// harness-test-tier: contract
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDaemonRpcParams } from "../src/protocol/daemon-protocol.contract.ts";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const installation: RuntimeInstallationWitness = {
  installationId: "codex-github-worker-installation",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "1.0.0",
  observedAt: "2026-08-25T00:00:00.000Z",
};

test("runtime instance hosting credential set and unset require an explicit repository scope", () => {
  const set = parseThinCommand([
      "runtime",
      "instance",
      "hosting-credential",
      "set",
      "codex-github-worker",
      "--repo-id",
      "repo-a",
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
      "--repo-id",
      "repo-a",
      "--provider",
      "gitlab",
    ]);

  assert.equal(
    parseThinCommand([
      "runtime",
      "instance",
      "hosting-credential",
      "set",
      "codex-github-worker",
      "--provider",
      "github",
      "--ref",
      "credential:v1:repo-a",
    ]).ok,
    false,
  );
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.equal(unset.ok, true, JSON.stringify(unset));
  if (!set.ok || !unset.ok) return;
  assert.equal(set.command.method, "daemon.runtimeInstance.hostingCredential.set");
  assert.deepEqual(set.command.action, {
    kind: "runtime-instance-hosting-credential-set",
    instanceId: "codex-github-worker",
    repoId: "repo-a",
    provider: "gitlab",
    credentialRef: "keychain:harness/gitlab-worker",
  });
  assert.equal(unset.command.method, "daemon.runtimeInstance.hostingCredential.unset");
  assert.deepEqual(unset.command.action, {
    kind: "runtime-instance-hosting-credential-unset",
    instanceId: "codex-github-worker",
    repoId: "repo-a",
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
        repoId: "repo-a",
        provider: "gitlab",
        credentialRef: reference,
      }),
      environment = await store.prepareDaemonGitEnvironment("codex-github-worker", "gitlab", "repo-a"),
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
        repoId: "repo-a",
        provider: "gitlab",
      }),
      shownAfterUnset = store.command({ kind: "runtime-instance-show", instanceId: "codex-github-worker" });
    assert.equal("hostingCredentialState" in (unbound.instance as Record<string, unknown>), false);
    assert.equal("hostingCredentialState" in (shownAfterUnset.instance as Record<string, unknown>), false);
    assert.equal(await store.prepareDaemonGitEnvironment("codex-github-worker", "gitlab", "repo-a"), null);
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

test("scoped refs isolate repositories and providers, rotate immediately and persist across reopen", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-hosting-scope-"));
  const resolved: string[] = [];
  const open = () =>
    openRuntimeInstanceStore({
      userRoot,
      discover: () => [installation],
      resolveCredential: async (ref) => {
        resolved.push(ref);
        return `fixture-value-for-${ref}`;
      },
    });
  try {
    const seed = open();
    seed.create({
      schemaVersion: 2,
      instanceId: "shared",
      name: "Shared",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {},
      auth: { mode: "subscription" },
      hostingCredentialRefs: { github: "credential:v1:legacy" },
    });
    // A fresh reader loads the previous-version field from disk, without inferring a repository.
    const store = open();
    assert.equal(
      await store.prepareDaemonGitEnvironment("shared", "github", "repo-a"),
      null,
      "previous-version unscoped refs must not grant repository access",
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-hosting-credential-set",
          instanceId: "shared",
          provider: "github",
          credentialRef: "credential:v1:a",
        }),
      /repoId/u,
    );
    for (const [repoId, provider, credentialRef] of [
      ["repo-a", "github", "credential:v1:a"],
      ["repo-b", "github", "credential:v1:b"],
      ["repo-a", "gitlab", "credential:v1:lab"],
    ])
      store.command({
        kind: "runtime-instance-hosting-credential-set",
        instanceId: "shared",
        repoId,
        provider,
        credentialRef,
      });
    assert.equal(
      (await store.prepareDaemonGitEnvironment("shared", "github", "repo-a"))?.GH_TOKEN,
      "fixture-value-for-credential:v1:a",
    );
    assert.equal(
      (await store.prepareDaemonGitEnvironment("shared", "github", "repo-b"))?.GH_TOKEN,
      "fixture-value-for-credential:v1:b",
    );
    assert.equal(
      (await store.prepareDaemonGitEnvironment("shared", "gitlab", "repo-a"))?.GITLAB_TOKEN,
      "fixture-value-for-credential:v1:lab",
    );
    assert.equal(await store.prepareDaemonGitEnvironment("shared", "github", "repo-c"), null);
    assert.equal(await store.prepareDaemonGitEnvironment("shared", "github", "toString"), null);
    assert.equal(await store.prepareDaemonGitEnvironment("shared", "gitlab", "repo-b"), null);
    assert.equal(resolved.includes("credential:v1:legacy"), false);
    store.command({
      kind: "runtime-instance-hosting-credential-set",
      instanceId: "shared",
      repoId: "repo-a",
      provider: "github",
      credentialRef: "credential:v1:rotated",
    });
    assert.equal(
      (await store.prepareDaemonGitEnvironment("shared", "github", "repo-a"))?.GH_TOKEN,
      "fixture-value-for-credential:v1:rotated",
    );
    store.command({
      kind: "runtime-instance-hosting-credential-unset",
      instanceId: "shared",
      repoId: "repo-a",
      provider: "github",
    });
    assert.equal(await store.prepareDaemonGitEnvironment("shared", "github", "repo-a"), null);
    const reopened = open();
    assert.equal(
      (await reopened.prepareDaemonGitEnvironment("shared", "github", "repo-b"))?.GH_TOKEN,
      "fixture-value-for-credential:v1:b",
    );
    assert.equal(
      (await reopened.prepareDaemonGitEnvironment("shared", "gitlab", "repo-a"))?.GITLAB_TOKEN,
      "fixture-value-for-credential:v1:lab",
    );
    assert.throws(
      () =>
        store.create({
          ...store.read("shared")!,
          instanceId: "invalid-map",
          hostingCredentialRefsByRepo: { "repo-a": { github: "plaintext" } },
        }),
      /opaque/u,
    );
    assert.throws(
      () => store.create({ ...store.read("shared")!, instanceId: "invalid-map", hostingCredentialRefsByRepo: [] }),
      /must be an object/u,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("hosting credential RPC rejects ambiguous writes without a repository namespace", () => {
  for (const method of ["set", "unset"]) {
    const payload = {
      instanceId: "shared",
      provider: "github",
      ...(method === "set" ? { credentialRef: "credential:v1:a" } : {}),
    };
    const rpc = `daemon.runtimeInstance.hostingCredential.${method}`;
    assert.equal(parseDaemonRpcParams(rpc, { payload }).ok, false);
    assert.equal(parseDaemonRpcParams(rpc, { payload: { ...payload, repoId: "" } }).ok, false);
    assert.equal(parseDaemonRpcParams(rpc, { payload: { ...payload, repoId: "repo-a" } }).ok, true);
  }
});
