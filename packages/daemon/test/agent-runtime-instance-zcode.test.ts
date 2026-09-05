// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "codex-installation-test",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.146.1",
  observedAt: "2026-08-15T00:00:00.000Z",
};

test("ZCode API-key instances materialize one pinned model in their isolated HOME", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-zcode-config-")),
    zcode = {
      ...observed,
      installationId: "zcode-installation-test",
      kindId: "zcode" as const,
      executablePath: "/opt/runtime-test/zcode",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [zcode],
      resolveCredential: async () => "redacted-test-key",
    });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "zcode-glm",
      name: "ZCode GLM",
      kindId: "zcode",
      providerId: "bigmodel",
      models: ["GLM-5.3"],
      zcode: { baseUrl: "https://open.bigmodel.cn/api/anthropic" },
      authMode: "api-key",
      credentialRef: "credential:v1:zcode-glm",
    }).instance as { readonly isolationState: string };
    assert.equal(created.isolationState, "enforced");
    const launch = await store.prepareLaunch("zcode-glm", { cwd: "/workspace/repo", prompt: "Probe" }),
      stateRoot = path.join(userRoot, "runtime-instances", "zcode-glm"),
      configPath = path.join(stateRoot, "home", ".zcode", "cli", "config.json");
    assert.equal(launch.env.HOME, path.join(stateRoot, "home"));
    assert.equal(launch.args.includes("--model"), false);
    assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
      provider: {
        bigmodel: {
          name: "bigmodel",
          kind: "anthropic",
          options: {
            apiKey: "redacted-test-key",
            baseURL: "https://open.bigmodel.cn/api/anthropic",
          },
          enabled: true,
          models: { "GLM-5.3": {} },
        },
      },
      model: { main: "bigmodel/GLM-5.3" },
    });
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "zcode-glm",
          models: ["GLM-5.3", "GLM-5.3-Flash"],
        }),
      (error: unknown) => codedAs(error, "invalid_command"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "zcode-multi",
          name: "ZCode Multi",
          kindId: "zcode",
          providerId: "bigmodel",
          models: ["GLM-5.3", "GLM-5.3-Flash"],
          authMode: "api-key",
          credentialRef: "credential:v1:zcode-multi",
        }),
      (error: unknown) => codedAs(error, "invalid_command"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
