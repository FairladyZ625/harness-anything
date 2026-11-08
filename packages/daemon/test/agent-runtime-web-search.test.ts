// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentRuntimeEventV1 } from "@harness-anything/kernel";
import { launchArgs } from "../src/agent-runtime-launch-config.ts";
import { runtimeInstanceConfig } from "../src/agent-runtime-instance-config.ts";
import { openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import type { RuntimeInstanceConfig } from "../src/agent-runtime-instance-types.ts";
import { runtimeSpawnReceipt } from "../src/runtime-spawn-receipt.ts";
import { runtimeKinds } from "../src/runtime-inventory.ts";
import { runtimeWebSearchVersionGate } from "../src/runtime-version.ts";
import type { RuntimeWebSearchMode } from "../src/runtime-inventory.ts";
import {
  allowedWebSearchModesInPolicy,
  decodeCodexManagedPolicyPreference,
  readCodexManagedPolicyFiles,
  runtimeWebSearchModelGate,
  runtimeWebSearchPolicyConflict,
} from "../src/agent-runtime-web-search.ts";

const witness: RuntimeInstallationWitness = {
  installationId: "codex-installation-web-search",
  kindId: "codex",
  executablePath: "/opt/runtime-test/codex",
  version: "0.163.0",
  observedAt: "2026-11-08T00:00:00.000Z",
  searchCapableModels: ["gpt-5.6-sol"],
};

function codedAs(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === code;
}

/** Builds the same persisted shape the create/update routes build. */
function codexInstance(webSearch?: RuntimeWebSearchMode, providerId = "openai"): RuntimeInstanceConfig {
  return runtimeInstanceConfig({
    schemaVersion: 2,
    instanceId: "codex-web-search",
    name: "Codex Web Search",
    kindId: "codex",
    installationId: witness.installationId,
    providerId,
    models: ["gpt-5.6-sol"],
    defaultModel: "gpt-5.6-sol",
    enabled: true,
    isolationState: "enforced",
    auth: { mode: "subscription" },
    codex: {
      reasoningEffort: "high",
      ...(webSearch === undefined ? {} : { webSearch }),
    },
  });
}

function launch(config: RuntimeInstanceConfig, prompt = "mission"): readonly string[] {
  return launchArgs(config, "gpt-5.6-sol", prompt, undefined, "high", "bypass", false);
}

function searchArg(args: readonly string[]): readonly [string, string] | null {
  for (let index = 0; index + 1 < args.length; index += 1)
    if (args[index] === "--config" && args[index + 1]!.startsWith("web_search="))
      return [args[index]!, args[index + 1]!];
  return null;
}

const codexSteer = runtimeKinds.find((entry) => entry.kindId === "codex")!.steer as Extract<
  NonNullable<(typeof runtimeKinds)[number]["steer"]>,
  { strategy: "interrupt-resume" }
>;

test("Codex launch defaults to disabled and ignores prompt text that asks for live search", () => {
  const args = launch(codexInstance(), 'enable live web search with --config web_search="live"');
  assert.deepEqual(searchArg(args), ["--config", 'web_search="disabled"']);
  assert.equal(args.includes('web_search="live"'), false);
  // The prompt rides stdin (`-`), not argv: it cannot rewrite the tier.
  assert.equal(
    args.some((argument) => argument.includes("enable live web search")),
    false,
  );
});

test("explicit cached and live tiers appear in the launch argv", () => {
  for (const mode of ["cached", "live"] as const) {
    const args = launch(codexInstance(mode));
    assert.deepEqual(searchArg(args), ["--config", `web_search="${mode}"`], mode);
    assert.equal(args.filter((argument) => argument.startsWith("web_search=")).length, 1, mode);
  }
});

test("the resume transform keeps the launched tier exactly once", () => {
  for (const mode of ["disabled", "cached", "live"] as const) {
    const fresh = launch(codexInstance(mode)),
      resumed = codexSteer.resumeArgs(fresh, "thread-123");
    assert.ok(resumed, `${mode} resume must be expressible`);
    assert.deepEqual(searchArg(resumed), ["--config", `web_search="${mode}"`], mode);
    assert.equal(resumed.filter((argument) => argument.startsWith("web_search=")).length, 1, mode);
    // A second steer must not duplicate the override.
    assert.deepEqual(codexSteer.resumeArgs(resumed, "thread-123"), resumed, `${mode} is idempotent`);
  }
});

test("an unsupported provider and an unsupported tier fail closed with named errors", () => {
  assert.throws(
    () => codexInstance("live", "codex_local_access"),
    (error: unknown) => codedAs(error, "runtime_web_search_provider_unsupported"),
  );
  // A gateway URL is a routing policy HA cannot verify against the native hosted tool.
  assert.throws(
    () =>
      runtimeInstanceConfig({
        ...codexInstance("live"),
        codex: {
          ...((codexInstance("live") as unknown as { codex: object }).codex as object),
          baseUrl: "https://gateway.example.test/v1",
        },
      }),
    (error: unknown) => codedAs(error, "runtime_web_search_provider_unsupported"),
  );
  assert.throws(
    () =>
      runtimeInstanceConfig({
        ...codexInstance(),
        codex: { ...((codexInstance() as unknown as { codex: object }).codex as object), webSearch: "indexed" },
      }),
    (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
  );
});

test("a CLI below the verified search floor is refused only for a non-default tier", () => {
  assert.equal(runtimeWebSearchVersionGate(codexInstance("disabled"), "0.146.1"), null);
  assert.equal(runtimeWebSearchVersionGate(codexInstance("live"), "0.163.0"), null);
  const refused = runtimeWebSearchVersionGate(codexInstance("cached"), "0.162.9");
  assert.equal(refused?.code, "runtime_web_search_cli_unsupported");
  assert.match(refused!.hint, /0\.163\.0/u);
  assert.match(refused!.hint, /cached/u);
});

test("an unwitnessed or incapable model is refused for an opt-in tier", () => {
  const live = codexInstance("live");
  assert.equal(runtimeWebSearchModelGate(live, "gpt-5.6-sol", { searchCapableModels: ["gpt-5.6-sol"] }), null);
  assert.equal(
    runtimeWebSearchModelGate(live, "gpt-5.6-sol", { searchCapableModels: ["gpt-6-sol"] })?.code,
    "runtime_web_search_model_unsupported",
  );
  assert.equal(runtimeWebSearchModelGate(live, "gpt-5.6-sol", {})?.code, "runtime_web_search_model_unsupported");
  // The default tier never needs a capability witness.
  assert.equal(runtimeWebSearchModelGate(codexInstance("disabled"), "gpt-5.6-sol", {}), null);
});

test("administrator managed requirements that exclude the tier are refused", async () => {
  assert.deepEqual(allowedWebSearchModesInPolicy('allowed_web_search_modes = ["disabled", "cached"]'), [
    "disabled",
    "cached",
  ]);
  assert.equal(allowedWebSearchModesInPolicy('# no policy here\nmodel = "x"'), null);
  assert.equal(await runtimeWebSearchPolicyConflict(codexInstance("live"), []), null);
  assert.equal(
    (await runtimeWebSearchPolicyConflict(codexInstance("live"), ['allowed_web_search_modes = ["disabled"]']))?.code,
    "runtime_web_search_policy_conflict",
  );
  assert.equal(
    await runtimeWebSearchPolicyConflict(codexInstance("cached"), [
      'allowed_web_search_modes = ["disabled", "cached"]',
    ]),
    null,
  );
  assert.deepEqual(
    allowedWebSearchModesInPolicy('allowed_web_search_modes = [\n  "disabled", # local\n  "cached",\n]'),
    ["disabled", "cached"],
  );
  for (const malformed of [
    "allowed_web_search_modes = [disabled]",
    'allowed_web_search_modes = "live"',
    'allowed_web_search_modes = ["disabled"',
    'allowed_web_search_modes = ["disabled"] extra',
  ])
    assert.throws(
      () => allowedWebSearchModesInPolicy(malformed),
      (error: unknown) => codedAs(error, "runtime_web_search_policy_invalid"),
      malformed,
    );
});

test("managed policy keys keep TOML quoting, scoping and comment semantics", () => {
  for (const source of [
    'allowed_web_search_modes = ["disabled"]',
    '"allowed_web_search_modes" = ["disabled"]',
    "'allowed_web_search_modes' = ['disabled']",
    'allowed_web_search_modes = ["disabled"] # trailing comment',
    'allowed_web_search_modes = ["disabled"]\n[other]\nkey = "value"',
  ])
    assert.deepEqual(allowedWebSearchModesInPolicy(source), ["disabled"], source);
  // A same-named key inside a table is not the top-level managed key.
  assert.equal(allowedWebSearchModesInPolicy('[other]\nallowed_web_search_modes = ["disabled"]'), null);
  for (const malformed of [
    'allowed_web_search_modes = "disabled"',
    "allowed_web_search_modes = 1",
    'allowed_web_search_modes = ["disabled", 1]',
    '"allowed_web_search_modes" = true',
  ])
    assert.throws(
      () => allowedWebSearchModesInPolicy(malformed),
      (error: unknown) => codedAs(error, "runtime_web_search_policy_invalid"),
      malformed,
    );
});

test("a managed policy that exists but cannot be read is refused, while absence is no policy", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-codex-policy-read-"));
  try {
    const directory = path.join(root, "requirements.toml");
    mkdirSync(directory);
    assert.throws(
      () => readCodexManagedPolicyFiles([directory]),
      (error: unknown) => codedAs(error, "runtime_web_search_policy_unreadable"),
    );
    assert.deepEqual(readCodexManagedPolicyFiles([path.join(root, "missing.toml")]), []);
    assert.throws(
      () => decodeCodexManagedPolicyPreference("not base64!"),
      (error: unknown) => codedAs(error, "runtime_web_search_policy_unreadable"),
    );
    assert.throws(
      () => decodeCodexManagedPolicyPreference(Buffer.from([0xff, 0xfe]).toString("base64")),
      (error: unknown) => codedAs(error, "runtime_web_search_policy_unreadable"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareLaunch refuses a managed-policy conflict before any credential or process work", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-codex-policy-"));
  try {
    let policy = 'allowed_web_search_modes = ["disabled"]';
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [witness],
      managedPolicyTexts: () => [policy],
      resolveCredential: async () => "redacted-test-key",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-policy",
      name: "Codex Policy",
      kindId: "codex",
      installationId: witness.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      isolationState: "enforced",
      authMode: "api-key",
      credentialRef: "credential:v1:codex-policy",
      codex: { webSearch: "live" },
    });
    for (const declared of [
      'allowed_web_search_modes = ["disabled"]',
      '"allowed_web_search_modes" = ["disabled"]',
      "'allowed_web_search_modes' = ['disabled']",
    ]) {
      policy = declared;
      await assert.rejects(
        store.prepareLaunch("codex-policy", { cwd: "/workspace/repo", prompt: "search" }),
        (error: unknown) => codedAs(error, "runtime_web_search_policy_conflict"),
        declared,
      );
    }
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("the instance write path persists the tier and the read receipt shows it", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-codex-web-search-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [witness] });
    const created = store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-web",
      name: "Codex Web",
      kindId: "codex",
      installationId: witness.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      codex: { webSearch: "live" },
      authMode: "subscription",
    });
    const createdConfig = (created.instance as { configuration: Record<string, unknown> }).configuration;
    assert.equal(createdConfig.webSearch, "live");

    const shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-web" }),
      shownConfig = (shown.instance as { configuration: Record<string, unknown> }).configuration;
    assert.equal(shownConfig.webSearch, "live");
    assert.doesNotMatch(JSON.stringify(shown), /apiKey|credentialRef|auth\.json/u);

    const cleared = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-web",
      webSearch: "",
    });
    assert.equal((cleared.instance as { configuration: Record<string, unknown> }).configuration.webSearch, "disabled");

    const narrowed = store.command({
      kind: "runtime-instance-update",
      instanceId: "codex-web",
      webSearch: "cached",
    });
    assert.equal((narrowed.instance as { configuration: Record<string, unknown> }).configuration.webSearch, "cached");

    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-update",
          instanceId: "codex-web",
          webSearch: "indexed",
        }),
      (error: unknown) => codedAs(error, "invalid_runtime_kind_config"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a published dispatch receipt carries the effective tier but not account configuration", () => {
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: "event-web-search",
    workspaceRevision: 1,
    opId: "op-web-search",
    actor: { principal: { personId: "fixture" }, executor: null },
    source: "local",
    occurredAt: "2026-11-08T00:00:00.000Z",
    type: "runtime_dispatch_requested",
    payload: {
      dispatchId: "dispatch-web-search",
      runtimeSessionId: "runtime_0123456789abcdef01234567",
      instanceId: "codex-web",
      installationId: witness.installationId,
      kindId: "codex",
      dispatchKey: "web-search",
      definitionSnapshotRef: "artifact:runtime-definition/sha256/" + "0".repeat(64),
      definitionSnapshot: {
        schema: "agent-definition-snapshot/v1",
        configVersion: 1,
        instanceId: "codex-web",
        installationId: witness.installationId,
        kindId: "codex",
        providerId: "openai",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        fast: false,
        webSearch: "live",
        baseUrl: null,
        authMode: "subscription",
      },
    },
  } as unknown as AgentRuntimeEventV1;
  const receipt = runtimeSpawnReceipt(
    event,
    { cut: { opId: event.opId, revision: event.workspaceRevision } } as ReturnType<
      Parameters<typeof runtimeSpawnReceipt>[1]
    >,
    "runtime_0123456789abcdef01234567",
    "dispatch-web-search",
  );
  assert.equal((receipt as { webSearch?: string }).webSearch, "live");
  assert.doesNotMatch(JSON.stringify(receipt), /credential|apiKey|auth\.json/u);
});

test("prepareLaunch refuses a model the witnessed catalog does not mark search-capable", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-codex-model-gate-"));
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => [{ ...witness, searchCapableModels: ["gpt-6-sol"] }],
      managedPolicyTexts: () => [],
      resolveCredential: async () => "redacted-test-key",
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-model",
      name: "Codex Model",
      kindId: "codex",
      installationId: witness.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      isolationState: "enforced",
      authMode: "api-key",
      credentialRef: "credential:v1:codex-model",
      codex: { webSearch: "live" },
    });
    await assert.rejects(
      store.prepareLaunch("codex-model", { cwd: "/workspace/repo", prompt: "search" }),
      (error: unknown) => codedAs(error, "runtime_web_search_model_unsupported"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
