// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, registerDaemonRepo, type AgentDefinitionSnapshot } from "../../kernel/src/index.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { currentDaemonProtocolVersion } from "../src/protocol/version.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const definition: AgentDefinitionSnapshot = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-review",
  installationId: "installation-codex",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://api.example.test/",
  authMode: "api-key",
};
test("runtime spawn maps the GUI Claude kind to a canonical claude-compatible installation", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-spawn-claude-"));
  try {
    git(root, "init", "-q");
    git(root, "config", "user.name", "Spawn Test");
    git(root, "config", "user.email", "spawn@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const claudeDefinition: AgentDefinitionSnapshot = {
      ...definition,
      instanceId: "claude-review",
      installationId: "installation-claude",
      kindId: "claude",
      providerId: "anthropic",
      model: "claude-fable-5",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    };
    const claudeInstallation: RuntimeInstallationWitness = {
      installationId: claudeDefinition.installationId,
      kindId: claudeDefinition.kindId,
      executablePath: "/opt/witnessed/claude",
      version: "1.0.0",
      observedAt: "2026-08-14T00:00:00.000Z",
    };
    let executablePath: string | undefined;
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-spawn-claude"),
      rootDir: canonicalRoot(root),
      ownerId: "spawn-test",
      runtimeInstances: () => [],
      prepareRuntimeLaunch: (_instanceId, request) => ({
        definition: claudeDefinition,
        installation: claudeInstallation,
        executablePath: claudeInstallation.executablePath,
        args: ["-p", "--verbose", "--output-format", "stream-json", "--model", claudeDefinition.model],
        env: { HOME: "/isolated/claude-review/home" },
        cwd: request.cwd,
        prompt: request.prompt,
      }),
      runtimeLaunch: (input) => {
        executablePath = input.executablePath;
        return {
          pid: 124,
          onOutput: () => undefined,
          onErrorOutput: () => undefined,
          onExit: () => undefined,
          terminate: () => undefined,
        };
      },
    });
    try {
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: "claude-review",
          cwd: { scope: "repo-root" },
          prompt: "Inspect the repository",
          taskId: null,
          idempotencyKey: "spawn-claude-once",
        },
        {
          actor: { principal: { personId: "person-spawn" }, executor: null },
          source: "local",
        },
      );
      assert.equal(receipt.outcome, "applied");
      assert.equal(executablePath, "/opt/witnessed/claude");
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime spawn resolves command model, Agent model, then instance default without silent fallback", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-agent-model-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    executablePath = writeProviderExecutable(path.join(parent, "codex-agent-model-stub.mjs"), "process.exit(0)\n"),
    repoId = "runtime-agent-model",
    models = ["instance-default", "agent-declared", "command-override"] as const,
    runtimeInstallation = {
      installationId: "installation-codex-agent-model",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-08-20T00:00:00.000Z",
    },
    claudeInstallation = {
      ...runtimeInstallation,
      installationId: "installation-claude-agent-model",
      kindId: "claude" as const,
    },
    agyInstallation = {
      ...runtimeInstallation,
      installationId: "installation-agy-agent-model",
      kindId: "agy" as const,
    };
  mkdirSync(root);
  initIngressRepo(root, 4306);
  const probed: string[] = [],
    unavailableReadiness = {
      status: "not-ready" as const,
      code: "runtime_subscription_required",
      hint: "Subscription is not ready.",
    },
    instances = openRuntimeInstanceStore({
      userRoot,
      discover: () => [runtimeInstallation, claudeInstallation, agyInstallation],
      subscriptionReady: ({ env }) => {
        const instanceId = path.basename(path.dirname(path.dirname(env.CODEX_HOME ?? "")));
        probed.push(instanceId);
        return ["codex-not-ready", "codex-unchecked-not-ready"].includes(instanceId)
          ? unavailableReadiness
          : { status: "ready", code: null, hint: null };
      },
    });
  instances.create({
    schemaVersion: 2,
    instanceId: "codex-agent-model",
    name: "Codex Agent Model",
    kindId: "codex",
    installationId: runtimeInstallation.installationId,
    providerId: "openai",
    models: [...models],
    defaultModel: "instance-default",
    enabled: true,
    codex: {},
    auth: { mode: "subscription" },
  });
  instances.create({
    schemaVersion: 2,
    instanceId: "codex-agent-model-b",
    name: "Codex Agent Model B",
    kindId: "codex",
    installationId: runtimeInstallation.installationId,
    providerId: "openai",
    models: [...models],
    defaultModel: "instance-default",
    enabled: true,
    codex: {},
    auth: { mode: "subscription" },
  });
  instances.create({
    schemaVersion: 2,
    instanceId: "codex-not-ready",
    name: "Codex Not Ready",
    kindId: "codex",
    installationId: runtimeInstallation.installationId,
    providerId: "openai",
    models: ["not-ready-only"],
    defaultModel: "not-ready-only",
    enabled: true,
    codex: {},
    auth: { mode: "subscription" },
  });
  instances.create({
    schemaVersion: 2,
    instanceId: "codex-unchecked-not-ready",
    name: "Codex Unchecked Not Ready",
    kindId: "codex",
    installationId: runtimeInstallation.installationId,
    providerId: "openai",
    models: ["unchecked-not-ready-only"],
    defaultModel: "unchecked-not-ready-only",
    enabled: true,
    codex: {},
    auth: { mode: "subscription" },
  });
  instances.create({
    schemaVersion: 2,
    instanceId: "claude-agent-model",
    name: "Claude Agent Model",
    kindId: "claude",
    installationId: claudeInstallation.installationId,
    providerId: "anthropic",
    models: ["claude-default"],
    defaultModel: "claude-default",
    enabled: true,
    claude: {},
    auth: { mode: "subscription" },
  });
  instances.create({
    schemaVersion: 2,
    instanceId: "agy-agent-model",
    name: "AGY Agent Model",
    kindId: "agy",
    installationId: agyInstallation.installationId,
    providerId: "google",
    models: ["agy-default"],
    defaultModel: "agy-default",
    enabled: true,
    agy: {},
    auth: { mode: "subscription" },
  });
  await instances.authStatus("codex-not-ready");
  probed.length = 0;
  let launched: {
    readonly definition: AgentDefinitionSnapshot;
    readonly prompt: string;
  } | null = null;
  const cell = await openRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(root),
    ownerId: "agent-model-test",
    runtimeInstances: instances.listPublic,
    prepareRuntimeLaunch: instances.prepareLaunch,
    runtimeLaunch: (prepared) => {
      launched = { definition: prepared.definition, prompt: prepared.prompt };
      return {
        pid: 4306,
        onOutput: () => undefined,
        onErrorOutput: () => undefined,
        onExit: () => undefined,
        terminate: () => undefined,
      };
    },
  });
  const binding = {
    actor: { principal: { personId: "person-agent-model" }, executor: null },
    source: "local" as const,
  };
  for (const declaration of [
    {
      schema: "agent-declaration/v1",
      id: "declared-model",
      name: "Declared Model",
      instructions: "Include the identity marker exactly: AGENT_INSTRUCTIONS_WITNESS.",
      runtime_type: "codex",
      role: "worker",
      model: "agent-declared",
      prompts: ["PROMPT_FRAGMENT_FIRST", "PROMPT_FRAGMENT_SECOND"],
      preset: "standard-task",
    },
    {
      schema: "agent-declaration/v1",
      id: "default-model",
      name: "Default Model",
      instructions: "Use instance default.",
      runtime_type: "codex",
      role: "commander",
    },
    {
      schema: "agent-declaration/v1",
      id: "any-model",
      name: "Any Model",
      instructions: "Use any compatible runtime.",
      runtime_type: "any",
    },
    {
      schema: "agent-declaration/v1",
      id: "opencode-model",
      name: "OpenCode Model",
      instructions: "Use OpenCode only.",
      runtime_type: "opencode",
    },
    {
      schema: "agent-declaration/v1",
      id: "missing-preset",
      name: "Missing Preset",
      instructions: "Do not dispatch without the preset.",
      runtime_type: "codex",
      preset: "missing-preset",
    },
    {
      schema: "squad-declaration/v1",
      id: "persona-squad",
      name: "Persona Squad",
      leader: "default-model",
      workers: ["declared-model"],
      leaderTurnBudget: 8,
      roster: "persona work -> declared-model",
    },
  ] as const) {
    await cell.run(
      { kind: declaration.schema === "agent-declaration/v1" ? "agent-install" : "squad-install", declaration },
      binding,
    );
  }
  try {
    assert.deepEqual(
      instances
        .listPublic()
        .filter((instance) => ["codex-agent-model", "codex-agent-model-b"].includes(instance.instanceId))
        .map((instance) => instance.authReadiness.code),
      ["runtime_auth_not_checked", "runtime_auth_not_checked"],
    );
    await cell.spawnRuntime(
      {
        agentId: "declared-model",
        cwd: { scope: "repo-root" },
        prompt: "Auto route one.",
        taskId: null,
        idempotencyKey: "auto-route-one",
      },
      binding,
    );
    assert.equal(launched?.definition.instanceId, "codex-agent-model");
    assert.deepEqual(probed, ["codex-agent-model"]);
    await cell.spawnRuntime(
      {
        agentId: "declared-model",
        cwd: { scope: "repo-root" },
        prompt: "Auto route two.",
        taskId: null,
        idempotencyKey: "auto-route-two",
      },
      binding,
    );
    assert.equal(launched?.definition.instanceId, "codex-agent-model-b");
    assert.deepEqual(probed, ["codex-agent-model", "codex-agent-model-b"]);
    await assert.rejects(
      cell.spawnRuntime(
        {
          agentId: "default-model",
          model: "missing-model",
          cwd: { scope: "repo-root" },
          prompt: "Missing model.",
          taskId: null,
          idempotencyKey: "auto-route-missing",
        },
        binding,
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "agent_model_unavailable" &&
        error.message.includes("No enabled runtime instance declares model missing-model"),
    );
    await assert.rejects(
      cell.spawnRuntime(
        {
          agentId: "opencode-model",
          cwd: { scope: "repo-root" },
          prompt: "No compatible runtime.",
          taskId: null,
          idempotencyKey: "auto-route-missing-type",
        },
        binding,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "agent_runtime_unavailable",
    );
    const probesBeforeKnownUnavailable = probed.length;
    await assert.rejects(
      cell.spawnRuntime(
        {
          agentId: "default-model",
          model: "not-ready-only",
          cwd: { scope: "repo-root" },
          prompt: "Not ready model.",
          taskId: null,
          idempotencyKey: "auto-route-not-ready",
        },
        binding,
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "runtime_model_not_ready" &&
        error.message.includes("declare model not-ready-only, but none are authentication-ready"),
    );
    assert.equal(probed.length, probesBeforeKnownUnavailable);
    const probesBeforeUncheckedUnavailable = probed.length;
    await assert.rejects(
      cell.spawnRuntime(
        {
          agentId: "default-model",
          model: "unchecked-not-ready-only",
          cwd: { scope: "repo-root" },
          prompt: "Unchecked unavailable model.",
          taskId: null,
          idempotencyKey: "auto-route-unchecked-not-ready",
        },
        binding,
      ),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "runtime_subscription_required" &&
        error.message === unavailableReadiness.hint,
    );
    assert.deepEqual(probed.slice(probesBeforeUncheckedUnavailable), ["codex-unchecked-not-ready"]);
    await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-agent-model",
        agentId: "declared-model",
        cwd: { scope: "repo-root" },
        prompt: "Do the work.",
        taskId: null,
        idempotencyKey: "agent-model",
      },
      binding,
    );
    assert.equal(launched?.definition.model, "agent-declared");
    assert.match(launched?.prompt ?? "", /AGENT_INSTRUCTIONS_WITNESS/u);
    assert.match(
      launched?.prompt ?? "",
      /# Harness Execution Discipline.*configured commit identity.*conventional type prefix.*do not mention AI.*Do not push, open a PR, merge.*# Worker Role.*bounded implementation.*local commit.*residual risks/su,
    );
    assert.match(launched?.prompt ?? "", /# Standard Task/u);
    assert.ok(
      (launched?.prompt ?? "").indexOf("# Worker Role") < (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_FIRST") &&
        (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_FIRST") <
          (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_SECOND") &&
        (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_SECOND") <
          (launched?.prompt ?? "").indexOf("# Standard Task") &&
        (launched?.prompt ?? "").indexOf("# Standard Task") < (launched?.prompt ?? "").indexOf("# Mission"),
    );
    await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-agent-model",
        agentId: "default-model",
        targetAgentId: "declared-model",
        cwd: { scope: "repo-root" },
        prompt: "Squad member keeps its persona.",
        taskId: null,
        idempotencyKey: "squad-persona",
      },
      binding,
    );
    assert.ok(
      (launched?.prompt ?? "").indexOf("# Worker Role") < (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_FIRST") &&
        (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_FIRST") <
          (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_SECOND") &&
        (launched?.prompt ?? "").indexOf("PROMPT_FRAGMENT_SECOND") <
          (launched?.prompt ?? "").indexOf("# Standard Task"),
      "a squad-delegated worker must keep the role, prompts, and preset it declares",
    );
    await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-agent-model",
        agentId: "declared-model",
        model: "command-override",
        cwd: { scope: "repo-root" },
        prompt: "Override the work.",
        taskId: null,
        idempotencyKey: "command-model",
      },
      binding,
    );
    assert.equal(launched?.definition.model, "command-override");
    await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-agent-model",
        agentId: "default-model",
        cwd: { scope: "repo-root" },
        prompt: "Default the work.",
        taskId: null,
        idempotencyKey: "default-model",
      },
      binding,
    );
    assert.equal(launched?.definition.model, "instance-default");
    assert.match(
      launched?.prompt ?? "",
      /# Harness Execution Discipline.*<very_important>.*# Commander Context.*attention.*run the gate yourself.*<\/very_important>/su,
    );
    for (const kindId of ["claude", "codex", "agy"] as const) {
      await cell.spawnRuntime(
        {
          runtimeInstanceId: `${kindId}-agent-model`,
          agentId: "any-model",
          cwd: { scope: "repo-root" },
          prompt: `Wildcard ${kindId}.`,
          taskId: null,
          idempotencyKey: `any-model-${kindId}`,
        },
        binding,
      );
      assert.equal(launched?.definition.kindId, kindId);
      assert.match(launched?.prompt ?? "", /# Worker Role/u);
    }
    await assert.rejects(
      cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-agent-model",
          agentId: "opencode-model",
          cwd: { scope: "repo-root" },
          prompt: "Reject unknown runtime.",
          taskId: null,
          idempotencyKey: "opencode-model",
        },
        binding,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "agent_runtime_type_mismatch",
    );
    await cell.run(
      {
        kind: "agent-install",
        declaration: {
          schema: "agent-declaration/v1",
          id: "declared-model",
          name: "Declared Model",
          instructions: "Include the identity marker exactly: AGENT_INSTRUCTIONS_WITNESS.",
          runtime_type: "codex",
          model: "unavailable-model",
        },
      },
      binding,
    );
    await assert.rejects(
      cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-agent-model",
          agentId: "declared-model",
          cwd: { scope: "repo-root" },
          prompt: "Reject unavailable model.",
          taskId: null,
          idempotencyKey: "unavailable-model",
        },
        binding,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_runtime_model",
    );
    await assert.rejects(
      cell.spawnRuntime(
        {
          runtimeInstanceId: "codex-agent-model",
          agentId: "missing-preset",
          cwd: { scope: "repo-root" },
          prompt: "Reject missing preset.",
          taskId: null,
          idempotencyKey: "missing-preset",
        },
        binding,
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "preset_not_found",
    );
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a squad-delegated worker injects selected absolute skill paths into every provider prompt", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-squad-worker-")),
    root = path.join(parent, "repo"),
    skillDir = path.join(parent, "user-skills", "squad-witness"),
    launches: Array<{
      readonly kindId: "claude" | "codex" | "agy";
      readonly prompt: string;
      readonly request: Record<string, unknown>;
    }> = [],
    kinds = ["claude", "codex", "agy"] as const;
  mkdirSync(root);
  initIngressRepo(root, 4308);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: squad-witness\ndescription: Squad witness\n---\nSQUAD_SKILL_WITNESS\n",
  );
  const cell = await openRepoCell({
    repoId: workspaceId("runtime-squad-worker"),
    rootDir: canonicalRoot(root),
    ownerId: "squad-worker-test",
    prepareRuntimeLaunch: (instanceId, request) => {
      const kindId = instanceId.replace(/-squad$/u, "") as "claude" | "codex" | "agy",
        preparedDefinition = {
          ...definition,
          instanceId,
          installationId: `installation-${kindId}-squad`,
          kindId,
          providerId: kindId === "claude" ? "anthropic" : kindId === "agy" ? "google" : "openai",
          model: `${kindId}-model`,
        },
        installation = {
          installationId: preparedDefinition.installationId,
          kindId,
          executablePath: `/opt/witnessed/${kindId}`,
          version: "1.0.0",
          observedAt: "2026-08-20T00:00:00.000Z",
        };
      launches.push({
        kindId,
        prompt: request.prompt,
        request: request as unknown as Record<string, unknown>,
      });
      return {
        definition: preparedDefinition,
        installation,
        executablePath: installation.executablePath,
        args: [],
        env: {},
        cwd: request.cwd,
        prompt: request.prompt,
      };
    },
    runtimeLaunch: () => ({
      pid: 4308,
      onOutput: () => undefined,
      onErrorOutput: () => undefined,
      onExit: () => undefined,
      terminate: () => undefined,
    }),
  });
  const binding = {
      actor: {
        principal: { personId: "person-squad-worker" },
        executor: null,
      },
      source: "local" as const,
    },
    skillFile = realpathSync(path.join(skillDir, "SKILL.md"));
  for (const [kind, declaration] of [
    [
      "agent",
      {
        schema: "agent-declaration/v1",
        id: "squad-leader",
        name: "Squad Leader",
        instructions: "Delegate work.",
        runtime_type: "codex",
      },
    ],
    [
      "agent",
      {
        schema: "agent-declaration/v1",
        id: "squad-worker",
        name: "Squad Worker",
        instructions: "Use the squad skill.",
        runtime_type: "any",
        skills: [{ id: "squad-witness", path: skillDir }],
      },
    ],
    [
      "squad",
      {
        schema: "squad-declaration/v1",
        id: "runtime-squad",
        name: "Runtime Squad",
        leader: "squad-leader",
        workers: ["squad-worker"],
        leaderTurnBudget: 8,
        roster: "# Runtime Squad",
      },
    ],
  ] as const)
    await cell.run({ kind: `${kind}-install`, declaration }, binding);
  try {
    for (const kindId of kinds) {
      const receipt = await cell.spawnRuntime(
        {
          runtimeInstanceId: `${kindId}-squad`,
          agentId: "squad-leader",
          targetAgentId: "squad-worker",
          cwd: { scope: "repo-root" },
          prompt: `Delegate to ${kindId}.`,
          taskId: null,
          idempotencyKey: `squad-worker-${kindId}`,
        },
        binding,
      );
      assert.equal(receipt.outcome, "applied", kindId);
    }
    for (const launch of launches) {
      assert.match(
        launch.prompt,
        new RegExp(`# Required Skills[\\s\\S]*squad-witness: ${skillFile.replaceAll("\\", "\\\\")}`, "u"),
        launch.kindId,
      );
      assert.equal(Object.hasOwn(launch.request, "skillRoot"), false);
      assert.equal(Object.hasOwn(launch.request, "skills"), false);
    }
    const leaderReceipt = await cell.spawnRuntime(
      {
        runtimeInstanceId: "codex-squad",
        agentId: "squad-leader",
        squadId: "runtime-squad",
        cwd: { scope: "repo-root" },
        prompt: "Run as the attributed squad leader.",
        taskId: null,
        idempotencyKey: "squad-leader-codex",
      },
      binding,
    );
    const header = JSON.parse(
      readFileSync(
        path.join(root, ".harness/runtime/dispatches", `${String(leaderReceipt.dispatchId)}.jsonl`),
        "utf8",
      ).split(/\r?\n/u)[0]!,
    ) as Record<string, unknown>;
    assert.equal(header.squadId, "runtime-squad");
    assert.equal(header.agentId, "squad-leader");
    assert.equal(Object.hasOwn(header, "delegatedByAgentId"), false);
  } finally {
    await cell.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Agent skill is really read by the provider from the absolute path in its final prompt", async (context) => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-agent-skill-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    repoId = "runtime-agent-skill",
    uid = 4307;
  const executablePath = writeProviderExecutable(
      path.join(parent, "codex-skill-provider.mjs"),
      `import fs from "node:fs";\nif (process.argv[2] === "login") process.exit(0);\nlet prompt = ""; for await (const chunk of process.stdin) prompt += chunk; const match = prompt.match(/provider-witness: (.+\\/SKILL\\.md)/u), skill = match ? fs.readFileSync(match[1], "utf8") : "", witness = skill.includes("SKILL_PROVIDER_WITNESS"), frames = [{ type: "thread.started", thread_id: "provider-session" }, { type: "item.completed", item: { id: "provider-witness", type: "agent_message", text: "provider-witness:" + witness, skill_witness: witness, prompt_witness: match?.[0] ?? null, final_prompt: prompt } }, { type: "item.completed", item: { id: "write", type: "file_change", changes: [{ path: "provider-result.txt", kind: "add" }], status: "completed" } }, { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }]; process.stdout.write(frames.map((frame) => JSON.stringify(frame)).join("\\n") + "\\n");\n`,
    ),
    installation = {
      installationId: "installation-codex-skill",
      kindId: "codex" as const,
      executablePath,
      version: "1.0.0",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
  initIngressRepo(root, uid);
  mkdirSync(path.join(root, "harness", "skills", "provider-witness"), {
    recursive: true,
  });
  writeFileSync(
    path.join(root, "harness", "skills", "provider-witness", "SKILL.md"),
    "---\nname: provider-witness\ndescription: Provider witness\n---\nSKILL_PROVIDER_WITNESS\n",
  );
  registerDaemonRepo({
    canonicalRoot: root,
    repoId,
    userRoot,
    createConvenienceLinks: false,
  });
  const auth = {
      transportKind: "unix-socket",
      unixSocketOwnerBoundary: {
        ownerUid: uid,
        source: "unix-socket-filesystem-owner-boundary",
      },
    } as const,
    host = await openDaemonHost({
      daemonId: "runtime-agent-skill",
      userRoot,
      runtimeDiscover: () => [installation],
    });
  await host.attachmentsSettled();
  const install = await host.run(
    repoId,
    {
      kind: "agent-install",
      declaration: {
        schema: "agent-declaration/v1",
        id: "skill-agent",
        name: "Skill Agent",
        instructions: "Use the provider skill.",
        runtime_type: "codex",
        skills: [{ id: "provider-witness", path: "skills/provider-witness" }],
      },
    },
    auth,
  );
  assert.equal(install.outcome, "applied", JSON.stringify(install));
  try {
    host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-skill",
        name: "Codex Skill",
        kindId: "codex",
        installationId: installation.installationId,
        providerId: "openai",
        models: ["skill-model"],
        authMode: "subscription",
      },
      auth,
    );
    const receipt = await rpc(host, auth, "repo.agentRuntime.spawn", {
      repo: { repoId },
      payload: {
        runtimeInstanceId: "codex-skill",
        agentId: "skill-agent",
        cwd: { scope: "repo-root" },
        prompt: "Use the skill.",
        taskId: null,
        idempotencyKey: "agent-skill-provider-witness",
      },
    });
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const attached = await host.attach(repoId, String(receipt.runtimeSessionId), "stream:0", auth);
    try {
      assert.equal(attached.initial.ok, true, JSON.stringify(attached.initial));
      const pending = attached.initial.ok ? [...attached.initial.events] : [];
      for (;;) {
        const event = pending.shift() ?? (await attached.next());
        assert.notEqual(event, null, "runtime attach stream closed before the provider witness arrived");
        if (event?.type === "activity" && event.activity === "message" && event.content === "provider-witness:true")
          break;
        assert.notEqual(event?.type, "exit", "runtime exited before the provider witness arrived");
      }
      const streamPath = path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`),
        stream = readFileSync(streamPath, "utf8"),
        records = stream
          .trim()
          .split(/\r?\n/u)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
        witness = records.find(
          (record) =>
            record.kind === "provider_event" &&
            ((record.event as Record<string, unknown> | undefined)?.item as Record<string, unknown> | undefined)
              ?.skill_witness === true,
        ),
        item = (witness?.event as Record<string, unknown> | undefined)?.item as Record<string, unknown> | undefined;
      assert.equal(item?.skill_witness, true, stream);
      assert.match(
        String(item?.prompt_witness),
        /^provider-witness: .*\/harness\/skills\/provider-witness\/SKILL\.md$/u,
      );
      assert.match(stream, /"text":"provider-witness:true"/u);
      assert.doesNotMatch(stream, /SKILL_PROVIDER_WITNESS/u);
      context.diagnostic(`FINAL_RUNTIME_PROMPT_BEGIN\n${String(item?.final_prompt)}\nFINAL_RUNTIME_PROMPT_END`);
    } finally {
      attached.detach();
    }
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("Codex API-key bearer remains confined to the private provider config", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-bearer-confidentiality-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user"),
    secret = "api-key-only-in-private-config",
    installation = {
      ...definition,
      installationId: "installation-codex-private",
      executablePath: "/opt/witnessed/codex-private",
      version: "1.0.0",
      observedAt: "2026-08-19T00:00:00.000Z",
    } as RuntimeInstallationWitness;
  try {
    mkdirSync(root);
    git(root, "init", "-q");
    git(root, "config", "user.name", "Spawn Test");
    git(root, "config", "user.email", "spawn@example.invalid");
    git(root, "commit", "--allow-empty", "-qm", "base");
    const instances = openRuntimeInstanceStore({
      userRoot,
      discover: () => [installation],
      resolveCredential: () => secret,
    });
    instances.create({
      schemaVersion: 2,
      instanceId: "codex-private",
      name: "Codex Private",
      kindId: "codex",
      installationId: installation.installationId,
      providerId: "codex_local_access",
      models: [definition.model],
      defaultModel: definition.model,
      enabled: true,
      codex: {
        baseUrl: "http://127.0.0.1:50818/v1",
        wireApi: "responses",
        requiresOpenAiAuth: true,
      },
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-private" },
    });
    const cell = await openRepoCell({
      repoId: workspaceId("runtime-bearer-confidentiality"),
      rootDir: canonicalRoot(root),
      ownerId: "spawn-test",
      runtimeInstances: instances.listPublic,
      prepareRuntimeLaunch: instances.prepareLaunch,
      runtimeLaunch: (prepared) => {
        assert.doesNotMatch(JSON.stringify(prepared), new RegExp(secret, "u"));
        return {
          pid: 456,
          onOutput: (listener) => {
            queueMicrotask(() =>
              listener(
                `${JSON.stringify({ type: "thread.started", thread_id: "private-provider-session" })}\n${JSON.stringify({ type: "item.completed", item: { id: "message", type: "agent_message", text: "private final result" } })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } })}\n`,
              ),
            );
          },
          onErrorOutput: () => undefined,
          onExit: (listener) => {
            queueMicrotask(() => listener(0));
          },
          terminate: () => undefined,
        };
      },
    });
    try {
      const receipt = await cell.spawnRuntime(
          {
            runtimeInstanceId: "codex-private",
            cwd: { scope: "repo-root" },
            prompt: "Inspect",
            taskId: null,
            idempotencyKey: "private-bearer",
          },
          {
            actor: { principal: { personId: "person-spawn" }, executor: null },
            source: "local",
          },
        ),
        read = await eventuallyValue(async () => {
          const value = await cell.read("repo.agentRuntime.sessions.read", {
            runtimeSessionId: receipt.runtimeSessionId,
          });
          return value.result ? value : null;
        }),
        events = makeTaskEventStore({
          repoId: "runtime-bearer-confidentiality",
          rootDir: root,
        }).read().events,
        stream = readFileSync(
          path.join(root, ".harness", "runtime", "dispatches", `${receipt.dispatchId}.jsonl`),
          "utf8",
        ),
        config = readFileSync(
          path.join(userRoot, "runtime-instances", "codex-private", "home", ".codex", "config.toml"),
          "utf8",
        );
      assert.match(config, new RegExp(`experimental_bearer_token = ${JSON.stringify(secret)}`, "u"));
      for (const value of [receipt, read, events, stream])
        assert.doesNotMatch(JSON.stringify(value), new RegExp(secret, "u"));
    } finally {
      await cell.close();
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

function initIngressRepo(root: string, uid: number): void {
  mkdirSync(path.join(root, "harness"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.name", "Spawn Test");
  git(root, "config", "user.email", "spawn@example.invalid");
  writeFileSync(
    path.join(root, "harness/harness.yaml"),
    "schema: harness-anything/v1\nname: runtime-spawn-ingress\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
  );
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: "owner", displayName: "Owner", roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(uid) }] }], roles: [{ roleId: "owner", commandClasses: ["repo-read", "repo-write"] }] }, null, 2)}\n`,
  );
  git(root, "add", "harness");
  git(root, "commit", "-qm", "fixture");
}

async function rpc(
  host: Awaited<ReturnType<typeof openDaemonHost>>,
  auth: Parameters<Awaited<ReturnType<typeof openDaemonHost>>["run"]>[2],
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const server = createJsonRpcProtocolServer({
    host,
    build: { commit: null },
    authContext: auth,
    emit: async () => undefined,
  });
  try {
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "protocol.hello",
      params: { protocolVersion: currentDaemonProtocolVersion },
    });
    const response = await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method,
      params,
    });
    assert.ok(response && !Array.isArray(response) && "result" in response);
    return (response as { result: Record<string, unknown> }).result;
  } finally {
    server.close();
  }
}

async function eventuallyValue<T>(read: () => T | null | Promise<T | null>): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("runtime provider event did not arrive");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, ...args]);
}
