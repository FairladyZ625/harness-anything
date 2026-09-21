// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "@harness-anything/cli/internal/cli/thin-command";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instances.ts";
import {
  daemonProtocolCommands,
  runtimeInstanceMethods,
  validateDaemonRpcCall,
} from "../src/protocol/daemon-protocol.contract.ts";
import { runtimeKindIds, runtimeKinds, type RuntimeProviderDeclaration } from "../src/runtime-inventory.ts";
import { providerFrameParsers } from "../src/runtime-spawn-provider-frames.ts";
import { codedAs, observed } from "./agent-runtime-instance-environment.fixture.ts";

test("ZCode inventory declares API-key configuration isolation", () => {
  const zcode = runtimeKinds.find(({ kindId }) => kindId === "zcode");
  assert.ok(zcode);
  assert.equal(zcode.auth.shape, "separate");
  assert.deepEqual(zcode.auth.modes, ["subscription", "api-key"]);
  assert.equal(zcode.isolation.defaultState, "enforced");
  assert.deepEqual(zcode.isolation.states, ["enforced", "operator-environment"]);
  assert.equal(zcode.capabilities.configurationIsolation, "supported");
  assert.equal(zcode.configuration.fields.baseUrl, "url");
});

test("runtime instance create RPC leaves provider configuration wrappers open to the inventory", () => {
  const create = runtimeInstanceMethods.find((method) => method.method === "daemon.runtimeInstance.create"),
    payload = create?.params.fields.payload;
  assert.ok(payload && typeof payload === "object" && "fields" in payload);
  assert.equal(payload.open, true);
});

test("a synthetic declaration can extend isolated copies without mutating shared provider surfaces", () => {
  const declaration = {
      ...runtimeKinds[0],
      kindId: "fixture",
      protocolFamily: "fixture",
      displayName: "Fixture Runtime",
      defaultProviderId: "fixture-provider",
      executable: { ...runtimeKinds[0].executable, command: "fixture", configDirectory: ".fixture" },
      configuration: { fields: {}, publicFields: {}, publicDefaults: {} },
    } as unknown as RuntimeProviderDeclaration,
    declarations: RuntimeProviderDeclaration[] = [...runtimeKinds, declaration],
    ids = [...runtimeKindIds, declaration.kindId],
    frameParsers = {
      ...providerFrameParsers,
      fixture: (_value: Record<string, unknown>, _sessionId: string | null) => ({
        finalText: "fixture-ok",
        outcome: "succeeded" as const,
      }),
    };
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-declaration-fixture-"));
  try {
    const parsed = parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "fixture-one",
      "--name",
      "Fixture One",
      "--kind",
      "fixture",
      "--installation",
      "fixture-installation",
      "--provider",
      "fixture-provider",
      "--model",
      "fixture-model",
      "--auth",
      "subscription",
    ]);
    assert.equal(parsed.ok && parsed.command.action.kindId, "fixture");
    const selected = declarations.find(
      ({ kindId }) => kindId === (parsed.ok ? parsed.command.action.kindId : undefined),
    );
    assert.equal(selected?.defaultProviderId, "fixture-provider");
    assert.deepEqual(selected?.configuration.fields, {});
    assert.ok(ids.includes(declaration.kindId));
    assert.equal(
      runtimeKinds.some(({ kindId }) => kindId === declaration.kindId),
      false,
    );
    assert.equal(
      runtimeKindIds.some((kindId) => kindId === declaration.kindId),
      false,
    );
    assert.deepEqual(frameParsers.fixture({ type: "result", session_id: "fixture-session" }, "fixture-session"), {
      finalText: "fixture-ok",
      outcome: "succeeded",
    });
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("machine runtime instance CRUD binds a witnessed installation and enforces private storage", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-store-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
      config = {
        schemaVersion: 1 as const,
        instanceId: "codex-review",
        name: "Codex Review",
        kindId: "codex" as const,
        installationId: observed.installationId,
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        baseUrl: "https://api.openai.com/v1",
        auth: { mode: "api-key" as const, credentialRef: "keychain:harness/codex-review" },
      };
    const normalized = {
      schemaVersion: 2 as const,
      instanceId: config.instanceId,
      name: config.name,
      installationId: config.installationId,
      installationIdentity: "path-entry/v1" as const,
      providerId: config.providerId,
      models: [config.model],
      defaultModel: config.model,
      enabled: true,
      permissionMode: "bypass" as const,
      isolationState: "enforced" as const,
      auth: config.auth,
      kindId: config.kindId,
      codex: { reasoningEffort: config.reasoningEffort, baseUrl: config.baseUrl },
    };
    assert.deepEqual(store.create(config), normalized);
    assert.deepEqual(store.list(), [normalized]);
    assert.deepEqual(store.read(config.instanceId), normalized);
    const target = path.join(userRoot, "runtime-instances.json"),
      stateRoot = path.join(userRoot, "runtime-instances", config.instanceId);
    assertPrivateModes(target, [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), {
      schema: "runtime-instances/v1",
      instances: [normalized],
    });
    assert.deepEqual(store.delete(config.instanceId), normalized);
    assert.equal(store.read(config.instanceId), null);
    assert.equal(existsSync(stateRoot), false);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance CRUD is a closed defineCliCommand surface", async () => {
  const ids = [
    "runtime-instance-create",
    "runtime-instance-list",
    "runtime-instance-show",
    "runtime-instance-update",
    "runtime-instance-delete",
  ];
  for (const id of ids) {
    const command = daemonProtocolCommands.find((entry) => entry.id === id);
    assert.ok(command, id);
    assert.deepEqual(command.inputs, command.flags, id);
  }
  assert.equal(
    daemonProtocolCommands
      .find((entry) => entry.id === "runtime-instance-update")
      ?.inputs.some(({ name }) => name === "--installation"),
    true,
  );
  const created = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "codex-review",
    "--name",
    "Codex Review",
    "--kind",
    "codex",
    "--installation",
    observed.installationId,
    "--provider",
    "codex_local_access",
    "--model",
    "gpt-5.6-sol",
    "--model",
    "gpt-5.6-terra",
    "--default-model",
    "gpt-5.6-terra",
    "--permission-mode",
    "workspace-write",
    "--effort",
    "xhigh",
    "--base-url",
    "http://127.0.0.1:1/v1",
    "--wire-api",
    "responses",
    "--requires-openai-auth",
    "--http-header",
    "X-Harness-Probe=present",
    "--auth",
    "api-key",
    "--credential-ref",
    "keychain:harness/codex-review",
  ]);
  assert.equal(created.ok, true);
  if (created.ok)
    assert.deepEqual(
      { method: created.command.method, action: created.command.action },
      {
        method: "daemon.runtimeInstance.create",
        action: {
          kind: "runtime-instance-create",
          instanceId: "codex-review",
          name: "Codex Review",
          kindId: "codex",
          installationId: observed.installationId,
          providerId: "codex_local_access",
          models: ["gpt-5.6-sol", "gpt-5.6-terra"],
          defaultModel: "gpt-5.6-terra",
          permissionMode: "workspace-write",
          codex: {
            reasoningEffort: "xhigh",
            baseUrl: "http://127.0.0.1:1/v1",
            wireApi: "responses",
            requiresOpenAiAuth: true,
            httpHeaders: { "X-Harness-Probe": "present" },
          },
          authMode: "api-key",
          credentialRef: "keychain:harness/codex-review",
        },
      },
    );
  const claudeCreated = parseThinCommand([
    "runtime",
    "instance",
    "create",
    "--id",
    "claude-review",
    "--name",
    "Claude Review",
    "--kind",
    "claude",
    "--installation",
    "claude-installation",
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5",
    "--effort",
    "high",
    "--auth",
    "subscription",
  ]);
  assert.equal(claudeCreated.ok, true);
  if (claudeCreated.ok) assert.deepEqual(claudeCreated.command.action.claude, { effort: "high" });
  for (const [argv, method, instanceId] of [
    ["list", "daemon.runtimeInstance.list", undefined],
    ["show", "daemon.runtimeInstance.show", "codex-review"],
    ["update", "daemon.runtimeInstance.update", "codex-review"],
    ["delete", "daemon.runtimeInstance.delete", "codex-review"],
  ] as const) {
    const parsed = parseThinCommand(["runtime", "instance", argv, ...(instanceId ? [instanceId] : [])]);
    assert.equal(parsed.ok, argv === "update" ? false : true, JSON.stringify(parsed));
    if (parsed.ok)
      assert.deepEqual(
        { method: parsed.command.method, action: parsed.command.action },
        { method, action: { kind: `runtime-instance-${argv}`, ...(instanceId ? { instanceId } : {}) } },
      );
  }
  const update = parseThinCommand([
    "runtime",
    "instance",
    "update",
    "codex-review",
    "--name",
    "Updated",
    "--installation",
    "codex-new",
    "--model",
    "gpt-5.6-sol",
    "--model",
    "gpt-5.6-terra",
    "--default-model",
    "gpt-5.6-terra",
    "--permission-mode",
    "read-only",
    "--disable",
  ]);
  assert.equal(update.ok, true);
  if (update.ok)
    assert.deepEqual(update.command.action, {
      kind: "runtime-instance-update",
      instanceId: "codex-review",
      name: "Updated",
      installationId: "codex-new",
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      permissionMode: "read-only",
      enabled: false,
    });
  assert.deepEqual(
    validateDaemonRpcCall({
      method: "daemon.runtimeInstance.update",
      params: { payload: { instanceId: "codex-review", installationId: "codex-new" } },
    }),
    [],
  );
  const run = parseThinCommand([
    "runtime",
    "run",
    "codex-review",
    "--model",
    "gpt-5.6-terra",
    "--effort",
    "xhigh",
    "--permission-mode",
    "workspace-write",
    "--prompt",
    "Inspect",
  ]);
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.equal(run.command.action.model, "gpt-5.6-terra");
    assert.equal(run.command.action.effort, "xhigh");
    assert.equal(run.command.action.permissionMode, "workspace-write");
  }
  assert.deepEqual(parseThinCommand(["runtime", "run", "codex-review", "--effort", "turbo", "--prompt", "Inspect"]), {
    ok: false,
    code: "invalid_runtime_effort",
    nextAction:
      "Use minimal, low, medium, high, xhigh, or max with Claude or Codex; agy supports low, medium, or high.",
    json: false,
  });
  const probed = parseThinCommand(["runtime", "instance", "show", "codex-review", "--probe"]);
  assert.equal(probed.ok, true);
  if (probed.ok)
    assert.deepEqual(
      { method: probed.command.method, action: probed.command.action },
      {
        method: "daemon.runtimeInstance.show",
        action: { kind: "runtime-instance-show", instanceId: "codex-review", probe: true },
      },
    );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "api-key",
    ]),
    {
      ok: false,
      code: "missing_field",
      nextAction: "API-key instances require --credential-ref <opaque-ref>.",
      json: false,
    },
  );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "subscription",
      "--credential-ref",
      "keychain:harness/bad",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "Subscription instances cannot accept a credential reference.",
      json: false,
    },
  );
  assert.deepEqual(
    parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "claude",
      "--installation",
      observed.installationId,
      "--provider",
      "anthropic",
      "--model",
      "claude",
      "--wire-api",
      "responses",
      "--auth",
      "subscription",
    ]),
    {
      ok: false,
      code: "invalid_field",
      nextAction: "This runtime kind does not accept options for another adapter.",
      json: false,
    },
  );
  for (const flag of ["--env", "--argv", "--isolation-profile"]) {
    const parsed = parseThinCommand([
      "runtime",
      "instance",
      "create",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--kind",
      "codex",
      "--installation",
      observed.installationId,
      "--provider",
      "openai",
      "--model",
      "gpt",
      "--auth",
      "subscription",
      flag,
      "open",
    ]);
    assert.equal(parsed.ok ? "ok" : parsed.code, "unknown_field", flag);
  }
});

test("runtime instance command receipts expose readiness metadata without credential refs or host paths", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-safe",
      name: "Codex Safe",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "api-key",
      credentialRef: "keychain:harness/codex-safe",
    });
    assert.deepEqual(created.instance, {
      schemaVersion: 2,
      instanceId: "codex-safe",
      name: "Codex Safe",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      permissionMode: "bypass",
      configuration: {
        reasoningEffort: null,
        fast: false,
        baseUrl: null,
        baseUrlConfigured: false,
        wire_api: null,
        requires_openai_auth: null,
        http_headers: null,
      },
      authMode: "api-key",
      authState: "configured",
      authReadiness: {
        status: "not-ready",
        code: "runtime_auth_not_checked",
        hint: "Authentication has not been verified in this daemon generation.",
      },
      isolationState: "enforced",
    });
    const listed = store.command({ kind: "runtime-instance-list" }),
      shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-safe" });
    assert.deepEqual(listed.installations, [
      {
        installationId: observed.installationId,
        kindId: "codex",
        version: observed.version,
        observedAt: observed.observedAt,
      },
    ]);
    assert.equal(
      listed.summary,
      `ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS\tPERMISSION MODE\ncodex-safe\tCodex Safe\tcodex\tgpt-5.6-sol\tenabled\tapi-key\tnot-checked\tbypass\n\nINSTALLATION\tKIND\tVERSION\tOBSERVED AT\n${observed.installationId}\tcodex\t${observed.version}\t${observed.observedAt}`,
    );
    assert.deepEqual(shown.instance, created.instance);
    for (const receipt of [created, listed, shown]) {
      assert.doesNotMatch(
        JSON.stringify(receipt),
        /credentialRef|keychain:|instance-secret|executablePath|\/opt\/runtime-test/u,
      );
      assert.equal(receipt.schema, "command-receipt/v2");
      assert.equal(receipt.ok, true);
    }
    assert.equal(
      store.command({ kind: "runtime-instance-delete", instanceId: "codex-safe" }).deletedInstanceId,
      "codex-safe",
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime catalog reads and auth probes reuse one installation discovery snapshot per command", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-snapshot-"));
  let discoveries = 0;
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => {
        discoveries += 1;
        return [observed];
      },
      subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-discovery-snapshot",
      name: "Codex discovery snapshot",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });

    discoveries = 0;
    store.command({ kind: "runtime-instance-list", all: true });
    assert.equal(discoveries, 1);

    discoveries = 0;
    const probed = await store.command({ kind: "runtime-instance-list", probe: true });
    assert.equal(discoveries, 1);
    assert.equal(probed.instances[0]?.authReadiness.status, "ready");

    discoveries = 0;
    await store.command({ kind: "runtime-instance-show", instanceId: "codex-discovery-snapshot", probe: true });
    assert.equal(discoveries, 1);

    discoveries = 0;
    store.command({ kind: "runtime-instance-update", instanceId: "codex-discovery-snapshot", enabled: false });
    assert.equal(discoveries, 0);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance create filters auto-resolution by kind and rejects same-kind ambiguity", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-resolution-")),
    ambiguousRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-ambiguous-")),
    claude = {
      ...observed,
      installationId: "claude-first",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
      version: "claude 1.0.0",
    },
    codex = { ...observed, installationId: "codex-first", version: "codex 1.0.0" },
    secondClaude = { ...claude, installationId: "claude-second", version: "claude 2.0.0" };
  try {
    const automatic = openRuntimeInstanceStore({ userRoot, discover: () => [claude, codex] }),
      created = automatic.command({
        kind: "runtime-instance-create",
        instanceId: "claude-auto",
        name: "Claude Auto",
        kindId: "claude",
        providerId: "anthropic",
        models: ["claude-fable-5"],
        authMode: "subscription",
      });
    assert.equal((created.instance as Record<string, unknown>).installationId, claude.installationId);
    const ambiguous = openRuntimeInstanceStore({
      userRoot: ambiguousRoot,
      discover: () => [claude, codex, secondClaude],
    });
    assert.throws(
      () =>
        ambiguous.command({
          kind: "runtime-instance-create",
          instanceId: "claude-ambiguous",
          name: "Claude Ambiguous",
          kindId: "claude",
          providerId: "anthropic",
          models: ["claude-fable-5"],
          authMode: "subscription",
        }),
      (error: unknown) =>
        codedAs(error, "runtime_installation_ambiguous") &&
        error instanceof Error &&
        error.message.includes(claude.installationId) &&
        error.message.includes(secondClaude.installationId),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
    rmSync(ambiguousRoot, { recursive: true, force: true });
  }
});

test("runtime instance command adapter rejects ambiguous or unknown auth modes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-auth-command-")),
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }),
    base = {
      kind: "runtime-instance-create",
      instanceId: "codex-auth",
      name: "Codex Auth",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
    };
  try {
    assert.throws(
      () => store.command({ ...base, authMode: "oauth", credentialRef: "keychain:harness/codex-auth" }),
      (error: unknown) => codedAs(error, "invalid_runtime_auth"),
    );
    assert.throws(
      () => store.command({ ...base, authMode: "subscription", credentialRef: "keychain:harness/codex-auth" }),
      (error: unknown) => codedAs(error, "invalid_runtime_auth"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("public instance projections expose one generic provider configuration", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-public-projection-")),
    claude = {
      ...observed,
      installationId: "claude-projection",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    store.create({
      schemaVersion: 2,
      instanceId: "codex-projection",
      name: "Codex Projection",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "sidecar",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      codex: {
        reasoningEffort: "high",
        baseUrl: "http://127.0.0.1:1/v1",
        wireApi: "responses",
        requiresOpenAiAuth: true,
        httpHeaders: { "X-Probe": "present" },
      },
      auth: { mode: "subscription" },
    });
    store.create({
      schemaVersion: 2,
      instanceId: "claude-projection",
      name: "Claude Projection",
      kindId: "claude",
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude"],
      defaultModel: "claude",
      enabled: true,
      claude: { effort: "medium", baseUrl: "https://gateway.example.test/v1" },
      auth: { mode: "subscription" },
    });
    const codex = store.command({ kind: "runtime-instance-show", instanceId: "codex-projection" }).instance as Record<
        string,
        unknown
      >,
      claudeDto = store.command({ kind: "runtime-instance-show", instanceId: "claude-projection" }).instance as Record<
        string,
        unknown
      >,
      listed = store.command({ kind: "runtime-instance-list" }).instances as Array<Record<string, unknown>>;
    assert.deepEqual(codex.configuration, {
      reasoningEffort: "high",
      fast: false,
      baseUrl: "http://127.0.0.1:1/v1",
      baseUrlConfigured: true,
      wire_api: "responses",
      requires_openai_auth: true,
      http_headers: { "X-Probe": "present" },
    });
    assert.equal("reasoningEffort" in codex, false);
    assert.equal("baseUrl" in codex, false);
    assert.deepEqual(claudeDto.configuration, {
      effort: "medium",
      baseUrl: "https://gateway.example.test/v1",
      baseUrlConfigured: true,
    });
    assert.equal(
      listed.every((item) => "configuration" in item),
      true,
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("kind-specific runtime config fails closed across adapters and rejects secret-like persisted headers", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-kind-config-")),
    claude = {
      ...observed,
      installationId: "claude-installation-test",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude",
    },
    store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    const common = {
      schemaVersion: 2 as const,
      instanceId: "claude-closed",
      name: "Claude Closed",
      kindId: "claude" as const,
      installationId: claude.installationId,
      providerId: "anthropic",
      models: ["claude-fable-5"],
      defaultModel: "claude-fable-5",
      enabled: true,
      auth: { mode: "subscription" as const },
    };
    assert.throws(
      () => store.create({ ...common, claude: {}, codex: { wireApi: "responses" } } as never),
      (error: unknown) =>
        codedAs(error, "invalid_runtime_kind_config") &&
        error.message.includes("claude runtime instance cannot include codex"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "claude-command",
          name: "Claude Command",
          kindId: "claude",
          installationId: claude.installationId,
          providerId: "anthropic",
          models: ["claude-fable-5"],
          claude: {},
          codex: { wireApi: "responses" },
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
    assert.throws(
      () =>
        store.create({
          schemaVersion: 2,
          instanceId: "codex-secret-header",
          name: "Codex Secret Header",
          kindId: "codex",
          installationId: observed.installationId,
          providerId: "sidecar",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-sol",
          enabled: true,
          codex: { baseUrl: "http://127.0.0.1:1/v1", httpHeaders: { Authorization: "Bearer forbidden" } },
          auth: { mode: "subscription" },
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_http_headers"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("runtime instance update changes metadata and models without touching credentials or state root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-update-")),
    replacement = {
      ...observed,
      installationId: "codex-installation-replacement",
      executablePath: "/opt/runtime-test/codex-replacement",
      version: "0.147.0",
    },
    wrongKind = {
      ...observed,
      installationId: "claude-installation-replacement",
      kindId: "claude" as const,
      executablePath: "/opt/runtime-test/claude-replacement",
      version: "2.1.240",
    };
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [observed, replacement, wrongKind],
      resolveCredential: () => "instance-secret",
    });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-update",
      name: "Before",
      kindId: "codex",
      installationId: observed.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      auth: { mode: "api-key", credentialRef: "credential:v1:codex-update" },
    });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-update"),
      stateMarker = path.join(stateRoot, "state-marker"),
      auth = store.read("codex-update")!.auth;
    writeFileSync(stateMarker, "preserved");
    const updated = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-update",
      name: "After",
      installationId: replacement.installationId,
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
      defaultModel: "gpt-5.6-terra",
      enabled: false,
    });
    assert.equal((updated.instance as { readonly name: string }).name, "After");
    assert.deepEqual((updated.instance as { readonly models: readonly string[] }).models, [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
    assert.equal((updated.instance as { readonly defaultModel: string }).defaultModel, "gpt-5.6-terra");
    assert.equal((updated.instance as { readonly enabled: boolean }).enabled, false);
    assert.equal(store.read("codex-update")!.installationId, replacement.installationId);
    assert.equal(store.read("codex-update")!.installationIdentity, "path-entry/v1");
    assert.deepEqual(store.read("codex-update")!.auth, auth);
    assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.deepEqual(store.command({ kind: "runtime-instance-list" }).instances, []);
    assert.equal(
      (
        store.command({ kind: "runtime-instance-list", all: true }).instances as Array<{ readonly enabled: boolean }>
      )[0]!.enabled,
      false,
    );
    await assert.rejects(
      store.prepareLaunch("codex-update", { cwd: "/workspace/repo", prompt: "Inspect", model: "gpt-5.6-sol" }),
      (error: unknown) => codedAs(error, "runtime_instance_disabled"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-update",
          models: ["gpt-5.6-sol"],
          defaultModel: "gpt-5.6-terra",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_model"),
    );
    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-update",
          installationId: wrongKind.installationId,
        }),
      (error: unknown) => codedAs(error, "runtime_installation_not_found"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

function assertPrivateModes(file: string, directories: readonly string[]): void {
  if (process.platform === "win32") {
    assert.equal(existsSync(file), true);
    for (const directory of directories) assert.equal(statSync(directory).isDirectory(), true, directory);
    return;
  }
  assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const directory of directories) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
}
