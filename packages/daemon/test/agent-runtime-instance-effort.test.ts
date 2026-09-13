// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

test("claude effort rides the create and update write paths and reads back", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-effort-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
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
    // The effort write path is claude-only today.
    const codexStore = openRuntimeInstanceStore({
      userRoot,
      discover: () => [
        observed,
        {
          ...observed,
          installationId: "codex-installation-test",
          kindId: "codex" as const,
          executablePath: "/opt/runtime-test/codex",
        },
      ],
    });
    codexStore.command({
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
    assert.throws(
      () => codexStore.command({ kind: "runtime-instance-update", instanceId: "codex-effort", effort: "high" }),
      (error: unknown) => codedAs(error, "invalid_runtime_effort"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
