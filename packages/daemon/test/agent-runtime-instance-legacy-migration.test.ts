// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

test("legacy runtime instance records migrate once to schema v2 on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-migration-"));
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 1, instanceId: "codex-legacy", name: "Legacy", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    assert.deepEqual(store.read("codex-legacy"), {
      schemaVersion: 2,
      instanceId: "codex-legacy",
      name: "Legacy",
      installationId: observed.installationId,
      installationIdentity: "path-entry/v1",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "bypass",
      isolationState: "enforced",
      auth: { mode: "subscription" },
      kindId: "codex",
      codex: {},
    });
    assert.equal(
      JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0].schemaVersion,
      2,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("one same-kind witness automatically migrates a legacy installation binding once without moving instance state", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-migration-")),
    target = path.join(userRoot, "runtime-instances.json"),
    stateRoot = path.join(userRoot, "runtime-instances", "claude-upgrade"),
    stateMarker = path.join(stateRoot, "state-marker"),
    current = {
      installationId: "claude_stable_entry",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/versions/2.1.240",
      version: "2.1.240 (Claude Code)",
      observedAt: "2026-08-23T00:00:00.000Z",
    };
  try {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(stateMarker, "preserved");
    writeFileSync(
      target,
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-upgrade", name: "Claude Upgrade", kindId: "claude", installationId: "claude_version_2_1_237", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({
        userRoot,
        discover: () => [current],
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      }),
      migrated = store.read("claude-upgrade")!;
    assert.equal(migrated.installationId, current.installationId);
    assert.equal(migrated.installationIdentity, "path-entry/v1");
    assert.deepEqual(migrated.auth, { mode: "subscription" });
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.equal(
      (await store.prepareLaunch("claude-upgrade", { cwd: "/workspace/repo", prompt: "Continue" })).installation
        .installationId,
      current.installationId,
    );
    const firstMtime = statSync(target).mtimeMs,
      firstContents = readFileSync(target, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.read("claude-upgrade");
    assert.equal(readFileSync(target, "utf8"), firstContents);
    assert.equal(statSync(target).mtimeMs, firstMtime);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("legacy installation migration refuses zero or multiple same-kind witnesses and gives executable repair commands", async () => {
  const candidates = [
    {
      installationId: "claude_candidate_one",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-one",
      version: "2.1.240",
      observedAt: "2026-08-23T00:00:00.000Z",
    },
    {
      installationId: "claude_candidate_two",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-two",
      version: "2.1.240",
      observedAt: "2026-08-23T00:00:00.000Z",
    },
  ];
  for (const [name, witnessed] of [
    ["zero", []],
    ["multiple", candidates],
  ] as const) {
    const userRoot = mkdtempSync(path.join(tmpdir(), `ha-runtime-installation-${name}-`)),
      target = path.join(userRoot, "runtime-instances.json");
    try {
      writeFileSync(
        target,
        `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: `claude-${name}`, name: `Claude ${name}`, kindId: "claude", installationId: "claude_old_version", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`,
      );
      const store = openRuntimeInstanceStore({
          userRoot,
          discover: () => witnessed,
          subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
        }),
        config = store.read(`claude-${name}`)!;
      assert.equal(config.installationId, "claude_old_version");
      assert.equal(config.installationIdentity, undefined);
      const readiness = await store.authStatus(`claude-${name}`);
      assert.equal(readiness.code, "runtime_installation_not_found");
      await assert.rejects(
        store.prepareLaunch(`claude-${name}`, { cwd: "/workspace/repo", prompt: "Continue" }),
        (error: unknown) =>
          codedAs(error, "runtime_installation_not_found") &&
          error instanceof Error &&
          error.message === readiness.hint,
      );
      if (name === "zero")
        assert.match(
          readiness.hint!,
          /ha runtime instance list.*ha runtime instance update claude-zero --installation <installation-id>/u,
        );
      else {
        for (const candidate of candidates) {
          assert.match(readiness.hint!, new RegExp(`${candidate.installationId} \\(${candidate.version}\\)`, "u"));
          assert.ok(
            readiness.hint!.includes(
              `ha runtime instance update claude-multiple --installation ${candidate.installationId}`,
            ),
          );
        }
        store.command({
          kind: "runtime-instance-update",
          instanceId: "claude-multiple",
          installationId: candidates[0]!.installationId,
        });
        assert.equal(store.read("claude-multiple")!.installationIdentity, "path-entry/v1");
        assert.equal(
          (await store.prepareLaunch("claude-multiple", { cwd: "/workspace/repo", prompt: "Continue" })).installation
            .installationId,
          candidates[0]!.installationId,
        );
      }
    } finally {
      rmSync(userRoot, { recursive: true, force: true });
    }
  }
});

test("flat schema v2 runtime config normalizes into its kind section on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-v2-migration-"));
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "codex-flat", name: "Flat", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
      config = store.read("codex-flat");
    assert.deepEqual(config?.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1" });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0];
    assert.deepEqual(persisted.codex, config?.codex);
    assert.equal("reasoningEffort" in persisted, false);
    assert.equal("baseUrl" in persisted, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("flat Claude effort from schema v2 migrates into Claude configuration", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-v2-migration-")),
    claude = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    };
  try {
    writeFileSync(
      path.join(userRoot, "runtime-instances.json"),
      `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-flat", name: "Claude Flat", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, reasoningEffort: "high", baseUrl: "https://gateway.example.test/v1", auth: { mode: "subscription" } }] })}\n`,
    );
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude] });
    assert.deepEqual(store.read("claude-flat")?.claude, { effort: "high", baseUrl: "https://gateway.example.test/v1" });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0];
    assert.deepEqual(persisted.claude, { effort: "high", baseUrl: "https://gateway.example.test/v1" });
    assert.equal("reasoningEffort" in persisted, false);
    assert.equal("codex" in persisted, false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
