// harness-test-tier: contract
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { discoverRuntimeInstallations, openRuntimeInstanceStore, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol.contract.ts";

const observed: RuntimeInstallationWitness = { installationId: "codex-installation-test", kindId: "codex", executablePath: "/opt/runtime-test/codex", version: "0.146.1", observedAt: "2026-08-15T00:00:00.000Z" };

test("machine runtime instance CRUD binds a witnessed installation and enforces private storage", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-store-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), config = { schemaVersion: 1 as const, instanceId: "codex-review", name: "Codex Review", kindId: "codex" as const, installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.openai.com/v1", auth: { mode: "api-key" as const, credentialRef: "keychain:harness/codex-review" } };
    assert.deepEqual(store.create(config), config);
    assert.deepEqual(store.list(), [config]);
    assert.deepEqual(store.read(config.instanceId), config);
    const target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", config.instanceId);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { schema: "runtime-instances/v1", instances: [config] });
    assert.deepEqual(store.delete(config.instanceId), config);
    assert.equal(store.read(config.instanceId), null);
    assert.equal(existsSync(stateRoot), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime installation discovery witnesses the exact executable realpath and version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-")), bin = path.join(root, "bin"), real = path.join(root, "real"), executable = path.join(real, "codex-real");
  try {
    requireDirectory(bin); requireDirectory(real);
    writeFileSync(executable, "#!/bin/sh\necho stub-runtime-1.0.0\n", { mode: 0o755 });
    symlinkSync(executable, path.join(bin, "codex"));
    const installations = discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-15T01:00:00.000Z" });
    assert.equal(installations.length, 1);
    assert.deepEqual({ kindId: installations[0]!.kindId, executablePath: installations[0]!.executablePath, version: installations[0]!.version, observedAt: installations[0]!.observedAt }, { kindId: "codex", executablePath: realpathSync(executable), version: "stub-runtime-1.0.0", observedAt: "2026-08-15T01:00:00.000Z" });
    assert.match(installations[0]!.installationId, /^codex_[0-9a-f]{24}$/u);
    assert.deepEqual(discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "later" })[0]!.installationId, installations[0]!.installationId);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("API-key launch preparation uses the witnessed executable and an instance-only environment", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-isolation-"));
  try {
    let resolvedReference: string | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { PATH: "/runtime/tools", HOME: "/host/home", TMPDIR: "/host/tmp", OPENAI_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-token", HTTPS_PROXY: "http://host-proxy" }, resolveCredential: (reference) => { resolvedReference = reference; return "instance-secret"; } });
    store.create({ schemaVersion: 1, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh", baseUrl: "https://gateway.example.test/v1", auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-api"); chmodSync(path.join(userRoot, "runtime-instances.json"), 0o644); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) chmodSync(directory, 0o755);
    const launch = store.prepareLaunch("codex-api", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.equal(resolvedReference, "keychain:harness/codex-api");
    assert.equal(launch.executablePath, observed.executablePath);
    assert.deepEqual(launch.args, ["exec", "--model", "gpt-5.6-sol", "-c", "model_provider=\"openai\"", "-c", "model_reasoning_effort=\"xhigh\"", "-"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CODEX_HOME: path.join(stateRoot, "home", ".codex"), OPENAI_API_KEY: "instance-secret", OPENAI_BASE_URL: "https://gateway.example.test/v1" });
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
    assert.equal(Object.values(launch.env).includes("host-token"), false);
    assert.equal(Object.values(launch.env).includes("http://host-proxy"), false);
    assert.equal(launch.prompt, "Inspect"); assert.equal(launch.cwd, "/workspace/repo");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mode & 0o777, 0o600); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("API-key launch fails closed on a missing key or installation without checking subscription auth", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-fail-closed-"));
  try {
    let installationPresent = true, subscriptionChecks = 0;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installationPresent ? [observed] : [], resolveCredential: () => { throw new Error("missing key"); }, subscriptionReady: () => { subscriptionChecks += 1; return true; } });
    store.create({ schemaVersion: 1, instanceId: "codex-closed", name: "Codex Closed", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/missing" } });
    assert.throws(() => store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_credential_unavailable")); assert.equal(subscriptionChecks, 0);
    installationPresent = false; assert.throws(() => store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_installation_not_found")); assert.equal(subscriptionChecks, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription launch fails closed without provider-native readiness and never falls back to an API key", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-isolation-")), claude: RuntimeInstallationWitness = { ...observed, installationId: "claude-installation-test", kindId: "claude", executablePath: "/opt/runtime-test/claude" };
  try {
    let ready = false, credentialCalls = 0, readinessEnvironment: NodeJS.ProcessEnv | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude], env: { PATH: "/runtime/tools", HOME: "/host/home", ANTHROPIC_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-oauth" }, resolveCredential: () => { credentialCalls += 1; return "fallback-secret"; }, subscriptionReady: ({ env }) => { readinessEnvironment = env; return ready; } });
    store.create({ schemaVersion: 1, instanceId: "claude-subscription", name: "Claude Subscription", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", model: "claude-fable-5", reasoningEffort: "high", auth: { mode: "subscription" } });
    assert.throws(() => store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_subscription_required"));
    assert.equal(credentialCalls, 0);
    ready = true; const launch = store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), stateRoot = path.join(userRoot, "runtime-instances", "claude-subscription");
    assert.deepEqual(launch.args, ["-p", "--model", "claude-fable-5", "--effort", "high"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude") });
    assert.deepEqual(readinessEnvironment, launch.env);
    assert.equal(credentialCalls, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance CRUD is a closed defineCliCommand surface", () => {
  const ids = ["runtime-instance-create", "runtime-instance-list", "runtime-instance-show", "runtime-instance-delete"];
  for (const id of ids) { const command = daemonProtocolCommands.find((entry) => entry.id === id); assert.ok(command, id); assert.deepEqual(command.inputs, command.flags, id); }
  const created = parseThinCommand(["runtime", "instance", "create", "--id", "codex-review", "--name", "Codex Review", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt-5.6-sol", "--effort", "xhigh", "--base-url", "https://gateway.example.test/v1", "--auth", "api-key", "--credential-ref", "keychain:harness/codex-review"]);
  assert.equal(created.ok, true); if (created.ok) assert.deepEqual({ method: created.command.method, action: created.command.action }, { method: "daemon.runtimeInstance.create", action: { kind: "runtime-instance-create", instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "xhigh", baseUrl: "https://gateway.example.test/v1", authMode: "api-key", credentialRef: "keychain:harness/codex-review" } });
  for (const [argv, method, instanceId] of [["list", "daemon.runtimeInstance.list", undefined], ["show", "daemon.runtimeInstance.show", "codex-review"], ["delete", "daemon.runtimeInstance.delete", "codex-review"]] as const) { const parsed = parseThinCommand(["runtime", "instance", argv, ...(instanceId ? [instanceId] : [])]); assert.equal(parsed.ok, true, JSON.stringify(parsed)); if (parsed.ok) assert.deepEqual({ method: parsed.command.method, action: parsed.command.action }, { method, action: { kind: `runtime-instance-${argv}`, ...(instanceId ? { instanceId } : {}) } }); }
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "api-key"]), { ok: false, code: "missing_field", nextAction: "API-key instances require --credential-ref <opaque-ref>.", json: false });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", "--credential-ref", "keychain:harness/bad"]), { ok: false, code: "invalid_field", nextAction: "Subscription instances cannot accept a credential reference.", json: false });
  for (const flag of ["--env", "--argv", "--isolation-profile"]) { const parsed = parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", flag, "open"]); assert.equal(parsed.ok ? "ok" : parsed.code, "unknown_field", flag); }
});

test("runtime instance command receipts expose readiness metadata without credential refs or host paths", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const created = store.command({ kind: "runtime-instance-create", instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", authMode: "api-key", credentialRef: "keychain:harness/codex-safe" });
    assert.deepEqual(created.instance, { schemaVersion: 1, instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: null, baseUrl: null, authMode: "api-key", authState: "configured", baseUrlConfigured: false, isolationState: "enforced" });
    const listed = store.command({ kind: "runtime-instance-list" }), shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-safe" });
    assert.deepEqual(listed.installations, [{ installationId: observed.installationId, kindId: "codex", version: observed.version, observedAt: observed.observedAt }]);
    assert.deepEqual(shown.instance, created.instance);
    for (const receipt of [created, listed, shown]) { assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|instance-secret|executablePath|\/opt\/runtime-test/u); assert.equal(receipt.schema, "command-receipt/v2"); assert.equal(receipt.ok, true); }
    assert.equal(store.command({ kind: "runtime-instance-delete", instanceId: "codex-safe" }).deletedInstanceId, "codex-safe");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance command adapter rejects ambiguous or unknown auth modes", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-auth-command-")), store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), base = { kind: "runtime-instance-create", instanceId: "codex-auth", name: "Codex Auth", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol" };
  try { assert.throws(() => store.command({ ...base, authMode: "oauth", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); assert.throws(() => store.command({ ...base, authMode: "subscription", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); }
  finally { rmSync(userRoot, { recursive: true, force: true }); }
});

function requireDirectory(directory: string): void { mkdirSync(directory); }
function codedAs(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
