// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";

const observed: RuntimeInstallationWitness = {
  installationId: "claude-installation-test",
  kindId: "claude",
  executablePath: "/opt/runtime-test/claude",
  version: "2.1.260",
  observedAt: "2026-09-13T00:00:00.000Z",
};

type EffortConfiguration = { readonly configuration: { readonly effort: string | null } };
type CodexEffortConfiguration = { readonly configuration: { readonly reasoningEffort: string | null } };

function installationWitness(kindId: "codex" | "agy" | "zcode"): RuntimeInstallationWitness {
  return {
    installationId: `${kindId}-installation-test`,
    kindId,
    executablePath: `/opt/runtime-test/${kindId}`,
    version: "1.0.0",
    observedAt: "2026-09-13T00:00:00.000Z",
  };
}

test("effort rides the create and update write paths for every kind that declares it", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-effort-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [
        observed,
        installationWitness("codex"),
        installationWitness("agy"),
        installationWitness("zcode"),
      ],
    });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "claude-effort",
      name: "Claude Effort",
      kindId: "claude",
      installationId: observed.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      claude: { effort: "high" },
      authMode: "subscription",
    });
    assert.equal((created.instance as EffortConfiguration).configuration.effort, "high");
    // A value replaces the stored preset and leaves the rest of the kind config alone.
    const replaced = store.command({
      kind: "runtime-instance-update",
      instanceId: "claude-effort",
      effort: "xhigh",
    });
    assert.equal((replaced.instance as EffortConfiguration).configuration.effort, "xhigh");
    // An unrelated update does not touch the stored preset.
    const renamed = store.command({
      kind: "runtime-instance-update",
      instanceId: "claude-effort",
      name: "Claude Effort Edited",
    });
    assert.equal((renamed.instance as EffortConfiguration).configuration.effort, "xhigh");
    // An explicit empty effort clears back to the provider default.
    const cleared = store.command({
      kind: "runtime-instance-update",
      instanceId: "claude-effort",
      effort: "",
    });
    assert.equal((cleared.instance as EffortConfiguration).configuration.effort, null);
    // Values outside the create-time vocabulary are rejected by the same validation.
    assert.throws(
      () => store.command({ kind: "runtime-instance-update", instanceId: "claude-effort", effort: "ultra" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
    // The effort write path is declaration-driven: every kind whose catalog entry declares
    // an effort configuration field can update it under that field's own name.
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-effort",
      name: "Codex Effort",
      kindId: "codex",
      installationId: "codex-installation-test",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      codex: { reasoningEffort: "high" },
      authMode: "subscription",
    });
    const codexReplaced = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-effort",
      effort: "xhigh",
    });
    assert.equal((codexReplaced.instance as CodexEffortConfiguration).configuration.reasoningEffort, "xhigh");
    const codexRenamed = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-effort",
      name: "Codex Effort Edited",
    });
    assert.equal(
      (codexRenamed.instance as CodexEffortConfiguration).configuration.reasoningEffort,
      "xhigh",
      "an unrelated update preserves the stored codex effort",
    );
    const codexCleared = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-effort",
      effort: "",
    });
    assert.equal((codexCleared.instance as CodexEffortConfiguration).configuration.reasoningEffort, null);
    assert.throws(
      () => store.command({ kind: "runtime-instance-update", instanceId: "codex-effort", effort: "ultra" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-effort",
      name: "AGY Effort",
      kindId: "agy",
      installationId: "agy-installation-test",
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      agy: { effort: "high" },
      authMode: "subscription",
    });
    const agyReplaced = store.command({
      kind: "runtime-instance-update",
      instanceId: "agy-effort",
      effort: "low",
    });
    assert.equal((agyReplaced.instance as EffortConfiguration).configuration.effort, "low");
    const agyCleared = store.command({
      kind: "runtime-instance-update",
      instanceId: "agy-effort",
      effort: "",
    });
    assert.equal((agyCleared.instance as EffortConfiguration).configuration.effort, null);
    // agy's own vocabulary applies on update just as it does on create.
    assert.throws(
      () => store.command({ kind: "runtime-instance-update", instanceId: "agy-effort", effort: "xhigh" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
    // zcode declares no effort field at all, so the update write path rejects it.
    store.command({
      kind: "runtime-instance-create",
      instanceId: "zcode-effort",
      name: "ZCode Effort",
      kindId: "zcode",
      installationId: "zcode-installation-test",
      providerId: "zai",
      models: ["glm-5.3-air"],
      authMode: "subscription",
    });
    assert.throws(
      () => store.command({ kind: "runtime-instance-update", instanceId: "zcode-effort", effort: "high" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("stored effort reaches launch flags for agy and config.toml for codex when dispatch sends none", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-effort-launch-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      env: { HOME: "/operator/home", PATH: "/bin" },
      discover: () => [installationWitness("codex"), installationWitness("agy")],
      resolveCredential: () => "instance-secret",
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-stored-effort",
      name: "AGY Stored Effort",
      kindId: "agy",
      installationId: "agy-installation-test",
      providerId: "google",
      models: ["gemini-3.1-pro-low"],
      agy: { effort: "high" },
      authMode: "subscription",
    });
    // The launch flag is the stored value's only consumption channel, so it rides
    // every launch even when the dispatch sends no effort of its own.
    const stored = await store.prepareLaunch("agy-stored-effort", {
      cwd: "/workspace/repo",
      prompt: "Stored",
    });
    assert.deepEqual(stored.args, [
      "-p",
      "Stored",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "30m",
      "--model",
      "gemini-3.1-pro-low",
      "--dangerously-skip-permissions",
      "--effort",
      "high",
    ]);
    assert.equal(stored.definition.reasoningEffort, "high");
    // A request-level effort still wins over the stored one.
    const overridden = await store.prepareLaunch("agy-stored-effort", {
      cwd: "/workspace/repo",
      prompt: "Override",
      effort: "low",
    });
    assert.equal(overridden.args[overridden.args.indexOf("--effort") + 1], "low");
    assert.equal(store.read("agy-stored-effort")?.agy.effort, "high");
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-stored-effort",
      name: "Codex Stored Effort",
      kindId: "codex",
      installationId: "codex-installation-test",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      codex: { reasoningEffort: "high" },
      authMode: "api-key",
      credentialRef: "credential:v1:codex-stored-effort",
    });
    // codex materializes the stored effort into config.toml instead, so launch args
    // carry no effort of their own when the dispatch sends none.
    const codexLaunch = await store.prepareLaunch("codex-stored-effort", {
      cwd: "/workspace/repo",
      prompt: "Config only",
    });
    assert.equal(codexLaunch.args.includes("model_reasoning_effort"), false);
    assert.match(
      readFileSync(path.join(codexLaunch.env.CODEX_HOME!, "config.toml"), "utf8"),
      /model_reasoning_effort = "high"/u,
    );
    assert.equal(codexLaunch.definition.reasoningEffort, "high");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
