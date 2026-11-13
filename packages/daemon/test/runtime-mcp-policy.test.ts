// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection } from "@harness-anything/storage";
import { parseAgentDeclarationV1 } from "@harness-anything/kernel";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { readAgentEntityGuiProjection } from "../src/agent-entities.ts";
import { diffAgentDeclarations } from "../src/agent-version-read.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { runtimeKinds } from "../src/runtime-inventory.ts";
import { resolveRuntimeMcpPolicy, runtimeMcpPolicy, runtimeSupportsMcpPolicy } from "../src/runtime-permissions.ts";
import { openBootstrappedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { initRepo } from "./task-surface.fixtures.ts";

const installations: readonly RuntimeInstallationWitness[] = [
  {
    installationId: "codex-install-mcp",
    kindId: "codex",
    executablePath: "/opt/runtime-test/codex",
    version: "0.147.0",
    observedAt: "2026-11-13T00:00:00.000Z",
  },
  {
    installationId: "claude-install-mcp",
    kindId: "claude",
    executablePath: "/opt/runtime-test/claude",
    version: "2.1.305 (Claude Code)",
    observedAt: "2026-11-13T00:00:00.000Z",
  },
  {
    installationId: "copilot-install-mcp",
    kindId: "copilot",
    executablePath: "/opt/runtime-test/copilot",
    version: "1.0.0",
    observedAt: "2026-11-13T00:00:00.000Z",
  },
];

function createStore(userRoot: string) {
  return openRuntimeInstanceStore({
    userRoot,
    discover: () => installations,
    resolveCredential: () => "instance-secret",
    subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
  });
}

test("3-tier mcpPolicy precedence prefers dispatch > agent > instance > disabled and rejects unsupported kinds", () => {
  assert.equal(runtimeSupportsMcpPolicy("codex"), true);
  assert.equal(runtimeSupportsMcpPolicy("claude"), true);
  assert.equal(runtimeSupportsMcpPolicy("copilot"), false);
  assert.equal(runtimeSupportsMcpPolicy("codex-acp"), false);
  assert.equal(runtimeSupportsMcpPolicy("agy"), false);

  assert.equal(resolveRuntimeMcpPolicy({ kindId: "codex" }), "disabled");
  assert.equal(resolveRuntimeMcpPolicy({ kindId: "codex", instanceMcpPolicy: "inherit" }), "inherit");
  assert.equal(
    resolveRuntimeMcpPolicy({ kindId: "codex", instanceMcpPolicy: "inherit", agentMcpPolicy: "disabled" }),
    "disabled",
  );
  assert.equal(
    resolveRuntimeMcpPolicy({
      kindId: "claude",
      instanceMcpPolicy: "disabled",
      agentMcpPolicy: "disabled",
      dispatchMcpPolicy: "inherit",
    }),
    "inherit",
  );

  assert.throws(
    () => runtimeMcpPolicy("inherit", "copilot"),
    (error: unknown) => (error as { readonly code?: string }).code === "invalid_runtime_mcp_policy",
  );
  assert.throws(
    () => resolveRuntimeMcpPolicy({ kindId: "copilot", dispatchMcpPolicy: "inherit" }),
    (error: unknown) => (error as { readonly code?: string }).code === "runtime_mcp_policy_unsupported",
  );
  assert.throws(
    () => resolveRuntimeMcpPolicy({ kindId: "agy", agentMcpPolicy: "inherit" }),
    (error: unknown) => (error as { readonly code?: string }).code === "runtime_mcp_policy_unsupported",
  );
});

test("Codex injects --ignore-user-config only in operator-environment when mcpPolicy is disabled and preserves across steer resume", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-codex-mcp-policy-")),
    codexKind = runtimeKinds.find((entry) => entry.kindId === "codex")!,
    codexSteer = codexKind.steer as Extract<NonNullable<typeof codexKind.steer>, { strategy: "interrupt-resume" }>;
  try {
    const store = createStore(userRoot);
    store.create({
      schemaVersion: 2,
      instanceId: "codex-op",
      name: "Codex Operator",
      kindId: "codex",
      installationId: "codex-install-mcp",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "operator-environment",
      codex: {},
      auth: { mode: "subscription" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-enf",
      name: "Codex Enforced",
      kindId: "codex",
      installationId: "codex-install-mcp",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "enforced",
      codex: {},
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-enf" },
    });

    const opDisabled = await store.prepareLaunch("codex-op", { cwd: "/workspace/repo", prompt: "go" });
    assert.equal(opDisabled.definition.mcpPolicy, "disabled");
    assert.equal(opDisabled.args.includes("--ignore-user-config"), true);
    assert.equal(
      opDisabled.args.some((arg) => arg.includes("mcp_servers=")),
      false,
    );

    const opResumed = codexSteer.resumeArgs(opDisabled.args, "thread-mcp-1");
    assert.ok(opResumed && opResumed.includes("--ignore-user-config"));

    const opInherit = await store.prepareLaunch("codex-op", {
      cwd: "/workspace/repo",
      prompt: "go",
      mcpPolicy: "inherit",
    });
    assert.equal(opInherit.definition.mcpPolicy, "inherit");
    assert.equal(opInherit.args.includes("--ignore-user-config"), false);

    const enfDisabled = await store.prepareLaunch("codex-enf", { cwd: "/workspace/repo", prompt: "go" });
    assert.equal(enfDisabled.definition.mcpPolicy, "disabled");
    assert.equal(
      enfDisabled.args.includes("--ignore-user-config"),
      false,
      "enforced codex instances must still read stateRoot/home/.codex/config.toml",
    );

    const probeArgs = launchArgs(
      store.read("codex-op") as never,
      "gpt-5.6-sol",
      "go",
      undefined,
      undefined,
      "bypass",
      false,
      undefined,
      [],
      [],
      [],
      "disabled",
    );
    assert.equal(probeArgs.includes("--ignore-user-config"), true);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Claude injects --strict-mcp-config when disabled, omits when inherit, and preserves on steer resume", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-claude-mcp-policy-")),
    claudeKind = runtimeKinds.find((entry) => entry.kindId === "claude")!,
    claudeSteer = claudeKind.steer as Extract<NonNullable<typeof claudeKind.steer>, { strategy: "interrupt-resume" }>;
  try {
    const store = createStore(userRoot);
    store.create({
      schemaVersion: 2,
      instanceId: "claude-op",
      name: "Claude Operator",
      kindId: "claude",
      installationId: "claude-install-mcp",
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      isolationState: "operator-environment",
      claude: {},
      auth: { mode: "subscription" },
    });

    const disabledLaunch = await store.prepareLaunch("claude-op", { cwd: "/workspace/repo", prompt: "go" });
    assert.equal(disabledLaunch.definition.mcpPolicy, "disabled");
    assert.equal(disabledLaunch.args.includes("--strict-mcp-config"), true);

    const disabledResumed = claudeSteer.resumeArgs(disabledLaunch.args, "claude-session-1");
    assert.ok(disabledResumed && disabledResumed.includes("--strict-mcp-config"));

    store.command({ kind: "runtime-instance-update", instanceId: "claude-op", mcpPolicy: "inherit" });
    assert.equal(store.read("claude-op")?.mcpPolicy, "inherit");

    const inheritLaunch = await store.prepareLaunch("claude-op", { cwd: "/workspace/repo", prompt: "go" });
    assert.equal(inheritLaunch.definition.mcpPolicy, "inherit");
    assert.equal(inheritLaunch.args.includes("--strict-mcp-config"), false);

    const dispatchOverride = await store.prepareLaunch("claude-op", {
      cwd: "/workspace/repo",
      prompt: "go",
      mcpPolicy: "disabled",
    });
    assert.equal(dispatchOverride.definition.mcpPolicy, "disabled");
    assert.equal(dispatchOverride.args.includes("--strict-mcp-config"), true);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("Agent declaration schema accepts mcpPolicy and version diff reports mcpPolicy changes", () => {
  const v1 = parseAgentDeclarationV1({
    schema: "agent-declaration/v1",
    id: "mcp-agent",
    name: "MCP Agent",
    role: "worker",
    runtimes: [{ type: "codex" }],
    instructions: "Work.",
    mcpPolicy: "inherit",
  });
  assert.equal(v1.mcpPolicy, "inherit");
  const diff = diffAgentDeclarations({ ...v1, mcpPolicy: "disabled" }, v1);
  assert.deepEqual(diff.fields, [{ field: "mcpPolicy", kind: "changed", from: "disabled", to: "inherit" }]);
});

test("Runtime instance update with cleared mcpPolicy deletes persisted override and show returns default", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-instance-clear-mcp-"));
  try {
    const store = createStore(userRoot);
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-clear",
      name: "Codex Clear",
      kindId: "codex",
      installationId: "codex-install-mcp",
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      authMode: "subscription",
      mcpPolicy: "inherit",
    });
    const instancesFile = path.join(userRoot, "runtime-instances.json"),
      readPersistedEntry = () =>
        (
          JSON.parse(readFileSync(instancesFile, "utf8")) as {
            readonly instances: ReadonlyArray<Record<string, unknown>>;
          }
        ).instances.find((entry) => entry.instanceId === "codex-clear")!;

    assert.equal(readPersistedEntry().mcpPolicy, "inherit");
    assert.equal(
      store.command({ kind: "runtime-instance-show", instanceId: "codex-clear" }).instance.mcpPolicy,
      "inherit",
    );

    store.command({ kind: "runtime-instance-update", instanceId: "codex-clear", mcpPolicy: "disabled" });
    assert.equal(Object.hasOwn(readPersistedEntry(), "mcpPolicy"), true);
    assert.equal(readPersistedEntry().mcpPolicy, "disabled");

    store.command({ kind: "runtime-instance-update", instanceId: "codex-clear", mcpPolicy: "" });
    assert.equal(Object.hasOwn(readPersistedEntry(), "mcpPolicy"), false);
    assert.equal(store.read("codex-clear")?.mcpPolicy, undefined);
    const shownAfterClear = store.command({ kind: "runtime-instance-show", instanceId: "codex-clear" });
    assert.equal(shownAfterClear.instance.mcpPolicy, "disabled");
    assert.match(shownAfterClear.summary, /mcpPolicy: disabled/u);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("agent-install sets and clears mcpPolicy by source or agentId, updates inspect, and returns dispatch to instance default", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-clear-mcp-"));
  initRepo(rootDir);
  const cell = await openRepoCell({
      repoId: workspaceId("agent-mcp-policy"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "agent-mcp-policy-test",
    }),
    binding = withPolicyGroup(
      {
        actor: { principal: { personId: "person-agent-mcp" }, executor: null },
        source: "local" as const,
      },
      "contributor",
    );
  try {
    const manifestPath = path.join(rootDir, "mcp-worker.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          schema: "agent-declaration/v1",
          id: "mcp-worker",
          name: "MCP Worker",
          role: "worker",
          instructions: "Verify MCP policy updates across canonical agent revisions.",
          runtimes: [{ type: "codex" }],
        },
        null,
        2,
      )}\n`,
    );

    const installed = await cell.run(
      {
        kind: "agent-install",
        packageSource: manifestPath,
        mcpPolicy: "inherit",
        expectedVersion: 0,
        idempotencyKey: "mcp-agent-v1",
      },
      binding,
    );
    assert.equal(installed.outcome, "applied", JSON.stringify(installed));
    assert.equal(
      resolveRuntimeMcpPolicy({ kindId: "codex", instanceMcpPolicy: "disabled", agentMcpPolicy: "inherit" }),
      "inherit",
    );

    const inspectV1 = await cell.run({ kind: "agent-inspect", agentId: "mcp-worker" }, binding);
    assert.equal(inspectV1.outcome, "applied", JSON.stringify(inspectV1));
    const inspectV1Body = JSON.parse(String(inspectV1.evidence)) as {
      readonly expectedVersion?: number;
      readonly agent: { readonly mcpPolicy?: string };
    };
    assert.equal(inspectV1Body.agent.mcpPolicy, "inherit");

    const updated = await cell.run(
      {
        kind: "agent-install",
        agentId: "mcp-worker",
        mcpPolicy: "disabled",
        expectedVersion: inspectV1Body.expectedVersion ?? installed.revision,
        idempotencyKey: "mcp-agent-v2",
      },
      binding,
    );
    assert.equal(updated.outcome, "applied", JSON.stringify(updated));
    const inspectV2 = await cell.run({ kind: "agent-inspect", agentId: "mcp-worker" }, binding);
    const inspectV2Body = JSON.parse(String(inspectV2.evidence)) as {
      readonly expectedVersion?: number;
      readonly agent: { readonly mcpPolicy?: string };
    };
    assert.equal(inspectV2Body.agent.mcpPolicy, "disabled");
    assert.equal(
      resolveRuntimeMcpPolicy({ kindId: "codex", instanceMcpPolicy: "inherit", agentMcpPolicy: "disabled" }),
      "disabled",
    );

    const cleared = await cell.run(
      {
        kind: "agent-install",
        agentId: "mcp-worker",
        clearMcpPolicy: true,
        expectedVersion: inspectV2Body.expectedVersion ?? updated.revision,
        idempotencyKey: "mcp-agent-v3",
      },
      binding,
    );
    assert.equal(cleared.outcome, "applied", JSON.stringify(cleared));
    const inspectV3 = await cell.run({ kind: "agent-inspect", agentId: "mcp-worker" }, binding);
    const inspectedAgent = JSON.parse(String(inspectV3.evidence)).agent as Record<string, unknown>;
    assert.equal(Object.hasOwn(inspectedAgent, "mcpPolicy"), false);
    const projection = makeTaskProjection({
      rootDir: canonicalRoot(rootDir),
      eventStore: makeTaskEventStore({ repoId: "agent-mcp-policy", rootDir: canonicalRoot(rootDir) }),
    });
    projection.catchUp();
    const guiDetail = readAgentEntityGuiProjection({
      kind: "agent-inspect",
      entityId: "mcp-worker",
      projection,
    });
    assert.equal(guiDetail.agent.mcpPolicy, null);
    assert.equal(
      resolveRuntimeMcpPolicy({
        kindId: "codex",
        instanceMcpPolicy: "inherit",
        agentMcpPolicy: inspectedAgent.mcpPolicy as "disabled" | "inherit" | undefined,
      }),
      "inherit",
    );
  } finally {
    await cell.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
