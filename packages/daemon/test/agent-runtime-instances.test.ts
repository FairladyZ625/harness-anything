// harness-test-tier: contract
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { credentialPort, runCredentialCommand } from "../src/agent-runtime-credential-port.ts";
import { discoverRuntimeInstallations, openRuntimeInstanceStore, type RuntimeAuthReadiness, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { daemonProtocolCommands, validateDaemonRpcCall } from "../src/protocol/daemon-protocol.contract.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const observed: RuntimeInstallationWitness = { installationId: "codex-installation-test", kindId: "codex", executablePath: "/opt/runtime-test/codex", version: "0.146.1", observedAt: "2026-08-15T00:00:00.000Z" };

test("a blocked credential backend keeps the daemon runtime-instance caller responsive", async (context) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-block-"));
  try {
    const port = credentialPort("darwin", () => runCredentialCommand({ file: process.execPath, args: ["-e", "setTimeout(() => process.stdout.write('resolved-secret'), 200)"] }));
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: port.resolve });
    store.create({ schemaVersion: 2, instanceId: "codex-blocked", name: "Codex blocked", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "api-key", credentialRef: "credential:v1:codex-blocked" } });
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats += 1; }, 5);
    try { assert.deepEqual(await store.authStatus("codex-blocked"), { status: "ready", code: null, hint: null }); }
    finally { clearInterval(heartbeat); }
    context.diagnostic(`daemon-runtime-heartbeats-during-credential-command=${heartbeats}`);
    assert.ok(heartbeats > 0, `expected a responsive daemon caller, observed ${heartbeats} heartbeats`);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("machine runtime instance CRUD binds a witnessed installation and enforces private storage", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-store-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), config = { schemaVersion: 1 as const, instanceId: "codex-review", name: "Codex Review", kindId: "codex" as const, installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.openai.com/v1", auth: { mode: "api-key" as const, credentialRef: "keychain:harness/codex-review" } };
    const normalized = { schemaVersion: 2 as const, instanceId: config.instanceId, name: config.name, installationId: config.installationId, installationIdentity: "path-entry/v1" as const, providerId: config.providerId, models: [config.model], defaultModel: config.model, enabled: true, permissionMode: "bypass" as const, isolationState: "enforced" as const, auth: config.auth, kindId: config.kindId, codex: { reasoningEffort: config.reasoningEffort, baseUrl: config.baseUrl } };
    assert.deepEqual(store.create(config), normalized);
    assert.deepEqual(store.list(), [normalized]);
    assert.deepEqual(store.read(config.instanceId), normalized);
    const target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", config.instanceId);
    assert.equal(statSync(target).mode & 0o777, 0o600);
    for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { schema: "runtime-instances/v1", instances: [normalized] });
    assert.deepEqual(store.delete(config.instanceId), normalized);
    assert.equal(store.read(config.instanceId), null);
    assert.equal(existsSync(stateRoot), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime installation identity survives an upgrade behind the same PATH entry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-discovery-")), bin = path.join(root, "bin"), versions = path.join(root, "versions"), entry = path.join(bin, "claude"), oldExecutable = path.join(versions, "2.1.237"), newExecutable = path.join(versions, "2.1.240");
  try {
    requireDirectory(bin); requireDirectory(versions);
    writeProviderExecutable(oldExecutable, "console.log(\"2.1.237 (Claude Code)\");\n");
    writeProviderExecutable(newExecutable, "console.log(\"2.1.240 (Claude Code)\");\n");
    symlinkSync(oldExecutable, entry);
    const before = discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" })[0]!;
    rmSync(entry); symlinkSync(newExecutable, entry);
    const after = discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-23T00:00:00.000Z" })[0]!;
    assert.deepEqual([before.version, after.version], ["2.1.237 (Claude Code)", "2.1.240 (Claude Code)"]);
    assert.deepEqual([before.executablePath, after.executablePath], [realpathSync(oldExecutable), realpathSync(newExecutable)]);
    assert.equal(before.executableEntryPath, path.resolve(entry)); assert.equal(after.executableEntryPath, before.executableEntryPath);
    assert.notEqual(after.executablePath, before.executablePath); assert.notEqual(after.version, before.version);
    assert.equal(after.installationId, before.installationId);
    assert.match(after.installationId, /^claude_[0-9a-f]{24}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runtime installation discovery projects each provider's detected model catalog", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-discovery-")), bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    writeProviderExecutable(path.join(bin, "codex"), `const args = process.argv.slice(2); if (args[0] === "--version") console.log("codex-test"); else if (args.join(" ") === "debug models --bundled") console.log(JSON.stringify({ models: [{ slug: "gpt-sol" }, { slug: "gpt-terra" }] }));\n`);
    writeProviderExecutable(path.join(bin, "agy"), `const args = process.argv.slice(2); if (args[0] === "--version") console.log("agy-test"); else if (args[0] === "models") console.log("gemini-high\\tGemini High\\ngemini-low\\tGemini Low");\n`);
    writeProviderExecutable(path.join(bin, "claude"), `const args = process.argv.slice(2); if (args[0] === "--version") console.log("claude-test"); else if (args[0] === "--help") console.log("aliases 'fable', 'sonnet', and 'opus'");\n`);
    const rows = discoverRuntimeInstallations({ env: { PATH: bin }, now: () => "2026-08-22T00:00:00.000Z" });
    assert.deepEqual(rows.map(({ kindId, models, defaultModel }) => ({ kindId, models, defaultModel })), [
      { kindId: "agy", models: ["gemini-high", "gemini-low"], defaultModel: "gemini-high" },
      { kindId: "claude", models: ["fable", "sonnet", "opus"], defaultModel: "fable" },
      { kindId: "codex", models: ["gpt-sol", "gpt-terra"], defaultModel: "gpt-sol" }
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Codex sidecar launch materializes the complete non-secret provider config in isolated CODEX_HOME", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-isolation-"));
  try {
    let resolvedReference: string | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { PATH: "/runtime/tools", HOME: "/host/home", TMPDIR: "/host/tmp", OPENAI_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-token", HTTPS_PROXY: "http://host-proxy" }, resolveCredential: (reference) => { resolvedReference = reference; return "instance-secret"; } });
    store.create({ schemaVersion: 2, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "codex_local_access", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "xhigh", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Harness-Probe": "present", "X-Static-Route": "sidecar" } }, auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-api"); chmodSync(path.join(userRoot, "runtime-instances.json"), 0o644); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) chmodSync(directory, 0o755);
    const launch = await store.prepareLaunch("codex-api", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.equal(resolvedReference, "keychain:harness/codex-api");
    assert.deepEqual(launch.installation, observed);
    assert.equal(launch.executablePath, observed.executablePath);
    assert.deepEqual(launch.args, ["exec", "--json", "--sandbox", "danger-full-access", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CODEX_HOME: path.join(stateRoot, "home", ".codex") });
    const codexConfig = path.join(launch.env.CODEX_HOME!, "config.toml"), text = readFileSync(codexConfig, "utf8"); assert.equal(statSync(codexConfig).mode & 0o777, 0o600); assert.equal(text, `model_provider = "codex_local_access"\nmodel_reasoning_effort = "xhigh"\n\n[model_providers."codex_local_access"]\nname = "codex_local_access"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nhttp_headers = { "X-Harness-Probe" = "present", "X-Static-Route" = "sidecar" }\nexperimental_bearer_token = "instance-secret"\n`); assert.match(text, /experimental_bearer_token = "instance-secret"/u); assert.doesNotMatch(JSON.stringify(launch), /instance-secret/u);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
    assert.equal(Object.values(launch.env).includes("host-token"), false);
    assert.equal(Object.values(launch.env).includes("http://host-proxy"), false);
    assert.equal(launch.prompt, "Inspect"); assert.equal(launch.cwd, "/workspace/repo");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mode & 0o777, 0o600); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime kinds receive prompt-injected skills without native discovery mounts", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-skill-prompt-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), installations = (["codex", "claude", "agy"] as const).map((kindId) => ({ installationId: `${kindId}-skills`, kindId, executablePath: `/opt/runtime-test/${kindId}`, version: "1.0.0", observedAt: "2026-08-20T00:00:00.000Z" }));
  try {
    const prompt = `Use probe\n\n# Required Skills\n\nRead and follow every selected skill before doing the mission:\n\n- probe: ${path.join(parent, "shared", "probe", "SKILL.md")}`;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installations, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    for (const installation of installations) store.create({ schemaVersion: 2, instanceId: `${installation.kindId}-skills`, name: `${installation.kindId} skills`, kindId: installation.kindId, installationId: installation.installationId, providerId: installation.kindId, models: ["skill-model"], defaultModel: "skill-model", enabled: true, ...(installation.kindId === "codex" ? { codex: {} } : installation.kindId === "claude" ? { claude: {} } : { agy: {} }), auth: { mode: "subscription" } });
    const launches = await Promise.all(installations.map(async (installation) => ({ kindId: installation.kindId, launch: await store.prepareLaunch(`${installation.kindId}-skills`, { cwd: rootDir, prompt }) })));
    for (const { launch } of launches) {
      assert.equal(launch.prompt, prompt);
      assert.equal(launch.args.includes("--plugin-dir"), false);
      assert.equal(launch.args.includes("--add-dir"), false);
    }
    const codex = launches.find(({ kindId }) => kindId === "codex")!.launch;
    assert.equal(existsSync(path.join(codex.env.CODEX_HOME!, "skills")), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("API-key launch fails closed on a missing key or installation without checking subscription auth", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-fail-closed-"));
  try {
    let installationPresent = true, subscriptionChecks = 0;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installationPresent ? [observed] : [], resolveCredential: () => { throw new Error("missing key"); }, subscriptionReady: () => { subscriptionChecks += 1; return { status: "ready", code: null, hint: null }; } });
    store.create({ schemaVersion: 1, instanceId: "codex-closed", name: "Codex Closed", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/missing" } });
    await assert.rejects(store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_credential_unavailable")); assert.equal(subscriptionChecks, 0);
    installationPresent = false; await assert.rejects(store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_installation_not_found")); assert.equal(subscriptionChecks, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription launch fails closed without provider-native readiness and never falls back to an API key", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-isolation-")), claude: RuntimeInstallationWitness = { ...observed, installationId: "claude-installation-test", kindId: "claude", executablePath: "/opt/runtime-test/claude" };
  try {
    let ready = false, credentialCalls = 0, readinessEnvironment: NodeJS.ProcessEnv | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude], env: { PATH: "/runtime/tools", HOME: "/host/home", ANTHROPIC_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-oauth" }, resolveCredential: () => { credentialCalls += 1; return "fallback-secret"; }, subscriptionReady: ({ env }) => { readinessEnvironment = env; return ready ? { status: "ready", code: null, hint: null } : { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." }; } });
    store.create({ schemaVersion: 2, instanceId: "claude-subscription", name: "Claude Subscription", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "subscription" } });
    await assert.rejects(store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_subscription_required"));
    assert.equal(credentialCalls, 0);
    ready = true; const launch = await store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), stateRoot = path.join(userRoot, "runtime-instances", "claude-subscription");
    assert.deepEqual(launch.args, ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--model", "claude-fable-5"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude") });
    assert.deepEqual(readinessEnvironment, launch.env);
    assert.equal(credentialCalls, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription probes distinguish a rejected status command from an unspawnable executable", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-probe-")), rejectedPath = path.join(userRoot, "rejected-status.mjs"), rejected = { ...observed, installationId: "codex-rejected-status", executablePath: writeProviderExecutable(rejectedPath, "process.exit(7);\n") }, unspawnable = { ...observed, installationId: "codex-unspawnable-status", executablePath: path.join(userRoot, "missing-status") };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [rejected, unspawnable] });
    for (const installation of [rejected, unspawnable]) store.create({ schemaVersion: 1, instanceId: installation.installationId, name: installation.installationId, kindId: "codex", installationId: installation.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    assert.equal((await store.authStatus(rejected.installationId)).code, "runtime_subscription_required");
    assert.equal((await store.authStatus(unspawnable.installationId)).code, "runtime_auth_probe_failed");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance CRUD is a closed defineCliCommand surface", async () => {
  const ids = ["runtime-instance-create", "runtime-instance-list", "runtime-instance-show", "runtime-instance-update", "runtime-instance-delete"];
  for (const id of ids) { const command = daemonProtocolCommands.find((entry) => entry.id === id); assert.ok(command, id); assert.deepEqual(command.inputs, command.flags, id); }
  assert.equal(daemonProtocolCommands.find((entry) => entry.id === "runtime-instance-update")?.inputs.some(({ name }) => name === "--installation"), true);
  const created = parseThinCommand(["runtime", "instance", "create", "--id", "codex-review", "--name", "Codex Review", "--kind", "codex", "--installation", observed.installationId, "--provider", "codex_local_access", "--model", "gpt-5.6-sol", "--model", "gpt-5.6-terra", "--default-model", "gpt-5.6-terra", "--permission-mode", "workspace-write", "--effort", "xhigh", "--base-url", "http://127.0.0.1:1/v1", "--wire-api", "responses", "--requires-openai-auth", "--http-header", "X-Harness-Probe=present", "--auth", "api-key", "--credential-ref", "keychain:harness/codex-review"]);
  assert.equal(created.ok, true); if (created.ok) assert.deepEqual({ method: created.command.method, action: created.command.action }, { method: "daemon.runtimeInstance.create", action: { kind: "runtime-instance-create", instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: observed.installationId, providerId: "codex_local_access", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", permissionMode: "workspace-write", codex: { reasoningEffort: "xhigh", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Harness-Probe": "present" } }, authMode: "api-key", credentialRef: "keychain:harness/codex-review" } });
  for (const [argv, method, instanceId] of [["list", "daemon.runtimeInstance.list", undefined], ["show", "daemon.runtimeInstance.show", "codex-review"], ["update", "daemon.runtimeInstance.update", "codex-review"], ["delete", "daemon.runtimeInstance.delete", "codex-review"]] as const) { const parsed = parseThinCommand(["runtime", "instance", argv, ...(instanceId ? [instanceId] : [])]); assert.equal(parsed.ok, argv === "update" ? false : true, JSON.stringify(parsed)); if (parsed.ok) assert.deepEqual({ method: parsed.command.method, action: parsed.command.action }, { method, action: { kind: `runtime-instance-${argv}`, ...(instanceId ? { instanceId } : {}) } }); }
  const update = parseThinCommand(["runtime", "instance", "update", "codex-review", "--name", "Updated", "--installation", "codex-new", "--model", "gpt-5.6-sol", "--model", "gpt-5.6-terra", "--default-model", "gpt-5.6-terra", "--permission-mode", "read-only", "--disable"]); assert.equal(update.ok, true); if (update.ok) assert.deepEqual(update.command.action, { kind: "runtime-instance-update", instanceId: "codex-review", name: "Updated", installationId: "codex-new", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", permissionMode: "read-only", enabled: false });
  assert.deepEqual(validateDaemonRpcCall({ method: "daemon.runtimeInstance.update", params: { payload: { instanceId: "codex-review", installationId: "codex-new" } } }), []);
  const run = parseThinCommand(["runtime", "run", "codex-review", "--model", "gpt-5.6-terra", "--effort", "xhigh", "--permission-mode", "workspace-write", "--prompt", "Inspect"]); assert.equal(run.ok, true); if (run.ok) { assert.equal(run.command.action.model, "gpt-5.6-terra"); assert.equal(run.command.action.effort, "xhigh"); assert.equal(run.command.action.permissionMode, "workspace-write"); }
  assert.deepEqual(parseThinCommand(["runtime", "run", "codex-review", "--effort", "turbo", "--prompt", "Inspect"]), { ok: false, code: "invalid_runtime_effort", nextAction: "Use minimal, low, medium, high, or xhigh with a Codex instance.", json: false });
  const probed = parseThinCommand(["runtime", "instance", "show", "codex-review", "--probe"]); assert.equal(probed.ok, true); if (probed.ok) assert.deepEqual({ method: probed.command.method, action: probed.command.action }, { method: "daemon.runtimeInstance.show", action: { kind: "runtime-instance-show", instanceId: "codex-review", probe: true } });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "api-key"]), { ok: false, code: "missing_field", nextAction: "API-key instances require --credential-ref <opaque-ref>.", json: false });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", "--credential-ref", "keychain:harness/bad"]), { ok: false, code: "invalid_field", nextAction: "Subscription instances cannot accept a credential reference.", json: false });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "claude", "--installation", observed.installationId, "--provider", "anthropic", "--model", "claude", "--wire-api", "responses", "--auth", "subscription"]), { ok: false, code: "invalid_field", nextAction: "Claude runtime instances cannot accept Codex options: --effort, --wire-api, --requires-openai-auth, or --http-header.", json: false });
  for (const flag of ["--env", "--argv", "--isolation-profile"]) { const parsed = parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", flag, "open"]); assert.equal(parsed.ok ? "ok" : parsed.code, "unknown_field", flag); }
});

test("runtime instance command receipts expose readiness metadata without credential refs or host paths", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const created = store.command({ kind: "runtime-instance-create", instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], authMode: "api-key", credentialRef: "keychain:harness/codex-safe" });
    assert.deepEqual(created.instance, { schemaVersion: 2, instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, permissionMode: "bypass", codex: { reasoningEffort: null, baseUrl: null, baseUrlConfigured: false, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: "api-key", authState: "configured", authReadiness: { status: "not-ready", code: "runtime_auth_not_checked", hint: "Authentication has not been verified in this daemon generation." }, isolationState: "enforced" });
    const listed = store.command({ kind: "runtime-instance-list" }), shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-safe" });
    assert.deepEqual(listed.installations, [{ installationId: observed.installationId, kindId: "codex", version: observed.version, observedAt: observed.observedAt }]); assert.equal(listed.summary, `ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS\ncodex-safe\tCodex Safe\tcodex\tgpt-5.6-sol\tenabled\tapi-key\tnot-checked\n\nINSTALLATION\tKIND\tVERSION\tOBSERVED AT\n${observed.installationId}\tcodex\t${observed.version}\t${observed.observedAt}`);
    assert.deepEqual(shown.instance, created.instance);
    for (const receipt of [created, listed, shown]) { assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|instance-secret|executablePath|\/opt\/runtime-test/u); assert.equal(receipt.schema, "command-receipt/v2"); assert.equal(receipt.ok, true); }
    assert.equal(store.command({ kind: "runtime-instance-delete", instanceId: "codex-safe" }).deletedInstanceId, "codex-safe");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance create filters auto-resolution by kind and rejects same-kind ambiguity", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-resolution-")), ambiguousRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-ambiguous-")), claude = { ...observed, installationId: "claude-first", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude", version: "claude 1.0.0" }, codex = { ...observed, installationId: "codex-first", version: "codex 1.0.0" }, secondClaude = { ...claude, installationId: "claude-second", version: "claude 2.0.0" };
  try {
    const automatic = openRuntimeInstanceStore({ userRoot, discover: () => [claude, codex] }), created = automatic.command({ kind: "runtime-instance-create", instanceId: "claude-auto", name: "Claude Auto", kindId: "claude", providerId: "anthropic", models: ["claude-fable-5"], authMode: "subscription" });
    assert.equal((created.instance as Record<string, unknown>).installationId, claude.installationId);
    const ambiguous = openRuntimeInstanceStore({ userRoot: ambiguousRoot, discover: () => [claude, codex, secondClaude] });
    assert.throws(() => ambiguous.command({ kind: "runtime-instance-create", instanceId: "claude-ambiguous", name: "Claude Ambiguous", kindId: "claude", providerId: "anthropic", models: ["claude-fable-5"], authMode: "subscription" }), (error: unknown) => codedAs(error, "runtime_installation_ambiguous") && error instanceof Error && error.message.includes(claude.installationId) && error.message.includes(secondClaude.installationId));
  } finally { rmSync(userRoot, { recursive: true, force: true }); rmSync(ambiguousRoot, { recursive: true, force: true }); }
});

test("runtime instance command adapter rejects ambiguous or unknown auth modes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-auth-command-")), store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), base = { kind: "runtime-instance-create", instanceId: "codex-auth", name: "Codex Auth", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"] };
  try { assert.throws(() => store.command({ ...base, authMode: "oauth", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); assert.throws(() => store.command({ ...base, authMode: "subscription", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); }
  finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("public instance projections keep provider options in the matching kind section", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-public-projection-")), claude = { ...observed, installationId: "claude-projection", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" }, store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    store.create({ schemaVersion: 2, instanceId: "codex-projection", name: "Codex Projection", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Probe": "present" } }, auth: { mode: "subscription" } });
    store.create({ schemaVersion: 2, instanceId: "claude-projection", name: "Claude Projection", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude"], defaultModel: "claude", enabled: true, claude: { baseUrl: "https://gateway.example.test/v1" }, auth: { mode: "subscription" } });
    const codex = store.command({ kind: "runtime-instance-show", instanceId: "codex-projection" }).instance as Record<string, unknown>, claudeDto = store.command({ kind: "runtime-instance-show", instanceId: "claude-projection" }).instance as Record<string, unknown>, listed = store.command({ kind: "runtime-instance-list" }).instances as Array<Record<string, unknown>>;
    assert.deepEqual(codex.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", baseUrlConfigured: true, wire_api: "responses", requires_openai_auth: true, http_headers: { "X-Probe": "present" } }); assert.equal("reasoningEffort" in codex, false); assert.equal("baseUrl" in codex, false); assert.equal("codex" in claudeDto, false); assert.deepEqual(claudeDto.claude, { baseUrl: "https://gateway.example.test/v1", baseUrlConfigured: true }); assert.equal(listed.every((item) => item.kindId === "codex" ? "codex" in item : "claude" in item), true);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("kind-specific runtime config fails closed across adapters and rejects secret-like persisted headers", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-kind-config-")), claude = { ...observed, installationId: "claude-installation-test", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" }, store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    const common = { schemaVersion: 2 as const, instanceId: "claude-closed", name: "Claude Closed", kindId: "claude" as const, installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, auth: { mode: "subscription" as const } };
    assert.throws(() => store.create({ ...common, claude: {}, codex: { wireApi: "responses" } } as never), (error: unknown) => codedAs(error, "invalid_runtime_kind_config") && error.message.includes("claude runtime instance cannot include codex"));
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "claude-command", name: "Claude Command", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], claude: {}, codex: { wireApi: "responses" }, authMode: "subscription" }), (error: unknown) => codedAs(error, "invalid_runtime_kind_config"));
    assert.throws(() => store.create({ schemaVersion: 2, instanceId: "codex-secret-header", name: "Codex Secret Header", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { baseUrl: "http://127.0.0.1:1/v1", httpHeaders: { Authorization: "Bearer forbidden" } }, auth: { mode: "subscription" } }), (error: unknown) => codedAs(error, "invalid_runtime_http_headers"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance update changes metadata and models without touching credentials or state root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-update-")), replacement = { ...observed, installationId: "codex-installation-replacement", executablePath: "/opt/runtime-test/codex-replacement", version: "0.147.0" }, wrongKind = { ...observed, installationId: "claude-installation-replacement", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude-replacement", version: "2.1.240" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, replacement, wrongKind], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-update", name: "Before", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, auth: { mode: "api-key", credentialRef: "credential:v1:codex-update" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-update"), stateMarker = path.join(stateRoot, "state-marker"), auth = store.read("codex-update")!.auth; writeFileSync(stateMarker, "preserved");
    const updated = store.command({ kind: "runtime-instance-update", instanceId: "codex-update", name: "After", installationId: replacement.installationId, models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: false });
    assert.equal((updated.instance as { readonly name: string }).name, "After"); assert.deepEqual((updated.instance as { readonly models: readonly string[] }).models, ["gpt-5.6-sol", "gpt-5.6-terra"]); assert.equal((updated.instance as { readonly defaultModel: string }).defaultModel, "gpt-5.6-terra"); assert.equal((updated.instance as { readonly enabled: boolean }).enabled, false);
    assert.equal(store.read("codex-update")!.installationId, replacement.installationId); assert.equal(store.read("codex-update")!.installationIdentity, "path-entry/v1"); assert.deepEqual(store.read("codex-update")!.auth, auth); assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.deepEqual(store.command({ kind: "runtime-instance-list" }).instances, []);
    assert.equal((store.command({ kind: "runtime-instance-list", all: true }).instances as Array<{ readonly enabled: boolean }>)[0]!.enabled, false);
    await assert.rejects(store.prepareLaunch("codex-update", { cwd: "/workspace/repo", prompt: "Inspect", model: "gpt-5.6-sol" }), (error: unknown) => codedAs(error, "runtime_instance_disabled"));
    assert.throws(() => store.command({ kind: "runtime-instance-update", instanceId: "codex-update", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-terra" }), (error: unknown) => codedAs(error, "invalid_runtime_model"));
    assert.throws(() => store.command({ kind: "runtime-instance-update", instanceId: "codex-update", installationId: wrongKind.installationId }), (error: unknown) => codedAs(error, "runtime_installation_not_found"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("legacy runtime instance records migrate once to schema v2 on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-migration-"));
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 1, instanceId: "codex-legacy", name: "Legacy", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    assert.deepEqual(store.read("codex-legacy"), { schemaVersion: 2, instanceId: "codex-legacy", name: "Legacy", installationId: observed.installationId, installationIdentity: "path-entry/v1", providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, permissionMode: "bypass", isolationState: "enforced", auth: { mode: "subscription" }, kindId: "codex", codex: {} });
    assert.equal(JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0].schemaVersion, 2);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("one same-kind witness automatically migrates a legacy installation binding once without moving instance state", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-migration-")), target = path.join(userRoot, "runtime-instances.json"), stateRoot = path.join(userRoot, "runtime-instances", "claude-upgrade"), stateMarker = path.join(stateRoot, "state-marker"), current = { installationId: "claude_stable_entry", kindId: "claude" as const, executablePath: "/opt/runtime-test/versions/2.1.240", version: "2.1.240 (Claude Code)", observedAt: "2026-08-23T00:00:00.000Z" };
  try {
    mkdirSync(stateRoot, { recursive: true }); writeFileSync(stateMarker, "preserved");
    writeFileSync(target, `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-upgrade", name: "Claude Upgrade", kindId: "claude", installationId: "claude_version_2_1_237", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [current], subscriptionReady: () => ({ status: "ready", code: null, hint: null }) }), migrated = store.read("claude-upgrade")!;
    assert.equal(migrated.installationId, current.installationId); assert.equal(migrated.installationIdentity, "path-entry/v1"); assert.deepEqual(migrated.auth, { mode: "subscription" }); assert.equal(readFileSync(stateMarker, "utf8"), "preserved");
    assert.equal((await store.prepareLaunch("claude-upgrade", { cwd: "/workspace/repo", prompt: "Continue" })).installation.installationId, current.installationId);
    const firstMtime = statSync(target).mtimeMs, firstContents = readFileSync(target, "utf8"); await new Promise((resolve) => setTimeout(resolve, 20)); store.read("claude-upgrade");
    assert.equal(readFileSync(target, "utf8"), firstContents); assert.equal(statSync(target).mtimeMs, firstMtime);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("legacy installation migration refuses zero or multiple same-kind witnesses and gives executable repair commands", async () => {
  const candidates = [
    { installationId: "claude_candidate_one", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude-one", version: "2.1.240", observedAt: "2026-08-23T00:00:00.000Z" },
    { installationId: "claude_candidate_two", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude-two", version: "2.1.240", observedAt: "2026-08-23T00:00:00.000Z" }
  ];
  for (const [name, witnessed] of [["zero", []], ["multiple", candidates]] as const) {
    const userRoot = mkdtempSync(path.join(tmpdir(), `ha-runtime-installation-${name}-`)), target = path.join(userRoot, "runtime-instances.json");
    try {
      writeFileSync(target, `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: `claude-${name}`, name: `Claude ${name}`, kindId: "claude", installationId: "claude_old_version", providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } }] })}\n`);
      const store = openRuntimeInstanceStore({ userRoot, discover: () => witnessed, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) }), config = store.read(`claude-${name}`)!;
      assert.equal(config.installationId, "claude_old_version"); assert.equal(config.installationIdentity, undefined);
      const readiness = await store.authStatus(`claude-${name}`); assert.equal(readiness.code, "runtime_installation_not_found");
      await assert.rejects(store.prepareLaunch(`claude-${name}`, { cwd: "/workspace/repo", prompt: "Continue" }), (error: unknown) => codedAs(error, "runtime_installation_not_found") && error instanceof Error && error.message === readiness.hint);
      if (name === "zero") assert.match(readiness.hint!, /ha runtime instance list.*ha runtime instance update claude-zero --installation <installation-id>/u);
      else { for (const candidate of candidates) { assert.match(readiness.hint!, new RegExp(`${candidate.installationId} \\(${candidate.version}\\)`, "u")); assert.ok(readiness.hint!.includes(`ha runtime instance update claude-multiple --installation ${candidate.installationId}`)); } store.command({ kind: "runtime-instance-update", instanceId: "claude-multiple", installationId: candidates[0]!.installationId }); assert.equal(store.read("claude-multiple")!.installationIdentity, "path-entry/v1"); assert.equal((await store.prepareLaunch("claude-multiple", { cwd: "/workspace/repo", prompt: "Continue" })).installation.installationId, candidates[0]!.installationId); }
    } finally { rmSync(userRoot, { recursive: true, force: true }); }
  }
});

test("flat schema v2 runtime config normalizes into its kind section on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-v2-migration-"));
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "codex-flat", name: "Flat", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), config = store.read("codex-flat"); assert.deepEqual(config?.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1" }); const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0]; assert.deepEqual(persisted.codex, config?.codex); assert.equal("reasoningEffort" in persisted, false); assert.equal("baseUrl" in persisted, false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("flat Claude effort from schema v2 migrates away without granting Claude Codex configuration", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-v2-migration-")), claude = { ...observed, installationId: "claude-installation-test", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-flat", name: "Claude Flat", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, reasoningEffort: "high", baseUrl: "https://gateway.example.test/v1", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude] }); assert.deepEqual(store.read("claude-flat")?.claude, { baseUrl: "https://gateway.example.test/v1" }); const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0]; assert.deepEqual(persisted.claude, { baseUrl: "https://gateway.example.test/v1" }); assert.equal("reasoningEffort" in persisted, false); assert.equal("codex" in persisted, false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("one enabled instance dispatches two supported models without reauth", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-choice-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-models", name: "Models", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol", enabled: true, auth: { mode: "api-key", credentialRef: "credential:v1:codex-models" } });
    const first = await store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "First", model: "gpt-5.6-sol" }), second = await store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "Second", model: "gpt-5.6-terra" });
    assert.equal(first.args[first.args.indexOf("--model") + 1], "gpt-5.6-sol"); assert.equal(second.args[second.args.indexOf("--model") + 1], "gpt-5.6-terra"); assert.deepEqual(first.definition.model, "gpt-5.6-sol"); assert.deepEqual(second.definition.model, "gpt-5.6-terra"); await assert.rejects(store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "Rejected", model: "gpt-unknown" }), (error: unknown) => codedAs(error, "invalid_runtime_model") && error.message.includes("gpt-5.6-sol, gpt-5.6-terra"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("Codex effort is a per-launch override and never mutates the instance", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-effort-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-effort", name: "Effort", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "medium" }, auth: { mode: "api-key", credentialRef: "credential:v1:codex-effort" } });
    const low = await store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Low", effort: "low" }), xhigh = await store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Hard", effort: "xhigh" });
    assert.notEqual(low.args.join("\0"), xhigh.args.join("\0")); assert.match(low.args.join(" "), /model_reasoning_effort="low"/u); assert.match(xhigh.args.join(" "), /model_reasoning_effort="xhigh"/u); assert.equal(store.read("codex-effort")?.kindId, "codex"); assert.equal(store.read("codex-effort")?.codex.reasoningEffort, "medium");
    await assert.rejects(store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "turbo" }), (error: unknown) => codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("turbo"));
    await assert.rejects(store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "" }), (error: unknown) => codedAs(error, "invalid_runtime_effort"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("permission defaults open and tightens through the instance record or a single dispatch", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-permission-")), claude = { ...observed, installationId: "claude-permission", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-open", name: "Codex Open", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "api-key", credentialRef: "credential:v1:codex-open" } });
    store.create({ schemaVersion: 2, instanceId: "claude-open", name: "Claude Open", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "api-key", credentialRef: "credential:v1:claude-open" } });
    const codexDefault = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Default" }), claudeDefault = await store.prepareLaunch("claude-open", { cwd: "/workspace/repo", prompt: "Default" });
    assert.deepEqual(codexDefault.args, ["exec", "--json", "--sandbox", "danger-full-access", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(claudeDefault.args, ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "bypassPermissions", "--model", "claude-fable-5", "--bare"]);
    store.command({ kind: "runtime-instance-update", instanceId: "codex-open", permissionMode: "workspace-write" });
    const tightened = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Tightened" });
    assert.deepEqual(tightened.args, ["exec", "--json", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--config", "sandbox_workspace_write.exclude_slash_tmp=true", "--model", "gpt-5.6-sol", "-"]);
    assert.equal(store.read("codex-open")?.permissionMode, "workspace-write");
    const dispatched = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Dispatch", permissionMode: "read-only" }), claudeDispatched = await store.prepareLaunch("claude-open", { cwd: "/workspace/repo", prompt: "Dispatch", permissionMode: "read-only" });
    assert.deepEqual(dispatched.args, ["exec", "--json", "--sandbox", "read-only", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(claudeDispatched.args, ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "plan", "--model", "claude-fable-5", "--bare"]);
    const resumedBypass = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Resume open", providerSessionId: "session-bypass", permissionMode: "bypass" }), resumedWorkspace = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Resume workspace", providerSessionId: "session-workspace" }), resumedReadOnly = await store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Resume read-only", providerSessionId: "session-read-only", permissionMode: "read-only" });
    assert.deepEqual(resumedBypass.args, ["exec", "resume", "--json", "--dangerously-bypass-approvals-and-sandbox", "--model", "gpt-5.6-sol", "session-bypass", "-"]);
    assert.deepEqual(resumedWorkspace.args, ["exec", "resume", "--json", "--config", 'sandbox_mode="workspace-write"', "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--config", "sandbox_workspace_write.exclude_slash_tmp=true", "--model", "gpt-5.6-sol", "session-workspace", "-"]);
    assert.deepEqual(resumedReadOnly.args, ["exec", "resume", "--json", "--config", 'sandbox_mode="read-only"', "--model", "gpt-5.6-sol", "session-read-only", "-"]);
    for (const resumed of [resumedBypass, resumedWorkspace, resumedReadOnly]) assert.equal(resumed.args.includes("--sandbox"), false);
    assert.equal(store.read("codex-open")?.permissionMode, "workspace-write");
    await assert.rejects(store.prepareLaunch("codex-open", { cwd: "/workspace/repo", prompt: "Bad", permissionMode: "turbo" }), (error: unknown) => codedAs(error, "invalid_runtime_permission"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("agy owns its access policy and rejects harness permission declarations", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-permission-")), agy = { installationId: "agy-permission", kindId: "agy" as const, executablePath: "/opt/runtime-test/agy", version: "1.1.15", observedAt: "2026-08-20T00:00:00.000Z" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [agy], subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "agy-locked", name: "AGY Locked", kindId: "agy", providerId: "google", models: ["gemini-3.1-pro-low"], permissionMode: "read-only", authMode: "subscription" }), (error: unknown) => codedAs(error, "invalid_runtime_permission"));
    store.command({ kind: "runtime-instance-create", instanceId: "agy-open", name: "AGY Open", kindId: "agy", providerId: "google", models: ["gemini-3.1-pro-low"], authMode: "subscription" });
    assert.equal((store.command({ kind: "runtime-instance-show", instanceId: "agy-open" }).instance as { readonly permissionMode: string | null }).permissionMode, null);
    await assert.rejects(store.prepareLaunch("agy-open", { cwd: "/workspace/repo", prompt: "Bad", permissionMode: "bypass" }), (error: unknown) => codedAs(error, "invalid_runtime_permission"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("claude isolation defaults to the operator environment and stays enforced on request", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-isolation-")), claude = { ...observed, installationId: "claude-isolation", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" }, agy = { installationId: "agy-isolation", kindId: "agy" as const, executablePath: "/opt/runtime-test/agy", version: "1.1.15", observedAt: "2026-08-20T00:00:00.000Z" }, operatorEnv = { PATH: "/runtime/tools", HOME: "/operator/home", TMPDIR: "/operator/tmp", ANTHROPIC_AUTH_TOKEN: "operator-oauth" };
  try {
    const claudeOperatorEnv = process.platform === "darwin" ? { ...operatorEnv, USER: userInfo().username } : operatorEnv;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude, observed, agy], env: operatorEnv, resolveCredential: () => "instance-secret", subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "claude-operator", name: "Claude Operator", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, claude: {}, auth: { mode: "subscription" } });
    store.create({ schemaVersion: 2, instanceId: "claude-operator-key", name: "Claude Operator Key", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, claude: {}, auth: { mode: "api-key", credentialRef: "credential:v1:claude-operator-key" } });
    const launch = await store.prepareLaunch("claude-operator", { cwd: "/workspace/repo", prompt: "Reuse the operator login" }), login = store.prepareAuthCommand("claude-operator", "login"), keyLaunch = await store.prepareLaunch("claude-operator-key", { cwd: "/workspace/repo", prompt: "Key in operator env" });
    assert.equal((store.command({ kind: "runtime-instance-show", instanceId: "claude-operator" }).instance as { readonly isolationState: string }).isolationState, "operator-environment");
    assert.deepEqual(launch.env, claudeOperatorEnv);
    assert.deepEqual(keyLaunch.env, { ...claudeOperatorEnv, ANTHROPIC_API_KEY: "instance-secret" });
    assert.deepEqual(login.env, claudeOperatorEnv);
    assert.deepEqual(login.args, ["auth", "login"]);
    assert.equal(statSync(login.cwd).isDirectory(), true);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "claude-operator", "home")), false);
    store.create({ schemaVersion: 2, instanceId: "claude-enforced", name: "Claude Enforced", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "api-key", credentialRef: "credential:v1:claude-enforced" } });
    const isolated = await store.prepareLaunch("claude-enforced", { cwd: "/workspace/repo", prompt: "Isolate" }), stateRoot = path.join(userRoot, "runtime-instances", "claude-enforced");
    assert.deepEqual(isolated.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude"), ANTHROPIC_API_KEY: "instance-secret" });
    const codexOperator = store.command({ kind: "runtime-instance-create", instanceId: "codex-operator", name: "Codex Operator", kindId: "codex", providerId: "openai", models: ["gpt-5.6-sol"], isolationState: "operator-environment", authMode: "subscription" }).instance as { readonly isolationState: string };
    assert.equal(codexOperator.isolationState, "operator-environment");
    assert.deepEqual((await store.prepareLaunch("codex-operator", { cwd: "/workspace/repo", prompt: "Reuse the operator ChatGPT login" })).env, operatorEnv);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-operator", "home")), false);
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "codex-operator-key", name: "Codex Operator Key", kindId: "codex", providerId: "openai", models: ["gpt-5.6-sol"], isolationState: "operator-environment", authMode: "api-key", credentialRef: "credential:v1:codex-operator-key" }), (error: unknown) => codedAs(error, "invalid_runtime_isolation"));
    store.create({ schemaVersion: 2, instanceId: "codex-keyed-enforced", name: "Codex Keyed Enforced", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "api-key", credentialRef: "credential:v1:codex-keyed-enforced" } });
    assert.throws(() => store.command({ kind: "runtime-instance-update", instanceId: "codex-keyed-enforced", isolationState: "operator-environment" }), (error: unknown) => codedAs(error, "invalid_runtime_isolation"));
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "agy-enforced", name: "AGY Enforced", kindId: "agy", providerId: "google", models: ["gemini-3.1-pro-low"], isolationState: "enforced", authMode: "subscription" }), (error: unknown) => codedAs(error, "invalid_runtime_isolation"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("macOS Claude operator probes use the OS username and report the probed environment", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-operator-probe-")), userRoot = path.join(root, "user"), bin = path.join(root, "bin"), readyPath = path.join(bin, "claude-ready"), rejectedPath = path.join(bin, "claude-rejected"), username = userInfo().username;
  try {
    mkdirSync(bin);
    const ready = writeProviderExecutable(readyPath, `if (process.env.USER !== ${JSON.stringify(username)}) process.exit(7);\n`), rejected = writeProviderExecutable(rejectedPath, "process.exit(7);\n"), readyInstallation: RuntimeInstallationWitness = { installationId: "claude-operator-ready", kindId: "claude", executablePath: ready, version: "2.1.240", observedAt: "2026-08-23T00:00:00.000Z" }, rejectedInstallation: RuntimeInstallationWitness = { installationId: "claude-operator-rejected", kindId: "claude", executablePath: rejected, version: "2.1.240", observedAt: "2026-08-23T00:00:00.000Z" }, env = { PATH: bin, HOME: "/operator/home", LANG: "C" };
    const store = openRuntimeInstanceStore({ userRoot, platform: "darwin", env, discover: () => [readyInstallation, rejectedInstallation] });
    store.create({ schemaVersion: 2, instanceId: "claude-operator-ready", name: "Claude Operator Ready", kindId: "claude", installationId: readyInstallation.installationId, providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("claude-operator-ready"), { status: "ready", code: null, hint: null });
    store.create({ schemaVersion: 2, instanceId: "claude-operator-rejected", name: "Claude Operator Rejected", kindId: "claude", installationId: rejectedInstallation.installationId, providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, isolationState: "operator-environment", claude: {}, auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("claude-operator-rejected"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in the operator environment." });
    store.create({ schemaVersion: 2, instanceId: "claude-enforced-rejected", name: "Claude Enforced Rejected", kindId: "claude", installationId: rejectedInstallation.installationId, providerId: "anthropic", models: ["sonnet"], defaultModel: "sonnet", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("claude-enforced-rejected"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforced instances link the operator's shared provider auth while generated config stays in the state root", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-shared-auth-")), operatorHome = path.join(parent, "operator"), userRoot = path.join(parent, "user"), claude = { ...observed, installationId: "claude-shared-auth", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    mkdirSync(path.join(operatorHome, ".codex"), { recursive: true }); writeFileSync(path.join(operatorHome, ".codex", "auth.json"), `{"tokens":"operator-login"}`, { mode: 0o600 });
    mkdirSync(path.join(operatorHome, ".claude"), { recursive: true }); writeFileSync(path.join(operatorHome, ".claude", ".credentials.json"), `{"oauth":"operator-login"}`, { mode: 0o600 });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude], env: { HOME: operatorHome, PATH: "/runtime/tools" }, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "codex-shared-auth", name: "Codex Shared Auth", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "subscription" } });
    const launch = await store.prepareLaunch("codex-shared-auth", { cwd: "/workspace/repo", prompt: "Reuse the operator login" }), stateRoot = path.join(userRoot, "runtime-instances", "codex-shared-auth"), linkedAuth = path.join(stateRoot, "home", ".codex", "auth.json");
    assert.equal(lstatSync(linkedAuth).isSymbolicLink(), true); assert.equal(readlinkSync(linkedAuth), path.join(operatorHome, ".codex", "auth.json"));
    assert.equal(existsSync(path.join(stateRoot, "home", ".codex", "config.toml")), true); assert.equal(existsSync(path.join(operatorHome, ".codex", "config.toml")), false);
    assert.equal(existsSync(path.join(operatorHome, ".codex", "skills")), false);
    writeFileSync(linkedAuth, `{"tokens":"refreshed-through-the-instance"}`, { mode: 0o600 }); assert.equal(readFileSync(path.join(operatorHome, ".codex", "auth.json"), "utf8"), `{"tokens":"refreshed-through-the-instance"}`);
    store.create({ schemaVersion: 2, instanceId: "claude-shared-auth", name: "Claude Shared Auth", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "subscription" } });
    const login = store.prepareAuthCommand("claude-shared-auth", "login"), claudeCredentials = path.join(userRoot, "runtime-instances", "claude-shared-auth", "home", ".claude", ".credentials.json");
    assert.equal(lstatSync(claudeCredentials).isSymbolicLink(), true); assert.equal(readlinkSync(claudeCredentials), path.join(operatorHome, ".claude", ".credentials.json"));
    for (const receipt of [launch, login]) assert.doesNotMatch(JSON.stringify(receipt), /operator-login/u);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("api-key instances never receive the operator's shared provider credentials", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-key-no-shared-auth-")), operatorHome = path.join(parent, "operator"), userRoot = path.join(parent, "user"), claude = { ...observed, installationId: "claude-api-key-no-shared-auth", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    mkdirSync(path.join(operatorHome, ".codex"), { recursive: true }); writeFileSync(path.join(operatorHome, ".codex", "auth.json"), `{"tokens":"operator-login"}`, { mode: 0o600 });
    mkdirSync(path.join(operatorHome, ".claude"), { recursive: true }); writeFileSync(path.join(operatorHome, ".claude", ".credentials.json"), `{"oauth":"operator-login"}`, { mode: 0o600 });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude], env: { HOME: operatorHome, PATH: "/runtime/tools" }, resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-api-key-isolated", name: "Codex API Key Isolated", kindId: "codex", installationId: observed.installationId, providerId: "codex_local_access", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { baseUrl: "http://127.0.0.1:1/v1" }, auth: { mode: "api-key", credentialRef: "credential:v1:codex-api-key-isolated" } });
    const codexLaunch = await store.prepareLaunch("codex-api-key-isolated", { cwd: "/workspace/repo", prompt: "Route through the broker key only" });
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-api-key-isolated", "home", ".codex", "auth.json")), false);
    assert.match(readFileSync(path.join(codexLaunch.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "instance-secret"/u);
    assert.equal(existsSync(path.join(operatorHome, ".codex", "config.toml")), false);
    store.create({ schemaVersion: 2, instanceId: "claude-api-key-isolated", name: "Claude API Key Isolated", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "api-key", credentialRef: "credential:v1:claude-api-key-isolated" } });
    const claudeLaunch = await store.prepareLaunch("claude-api-key-isolated", { cwd: "/workspace/repo", prompt: "Route through the broker key only" });
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "claude-api-key-isolated", "home", ".claude", ".credentials.json")), false);
    assert.equal(claudeLaunch.env.ANTHROPIC_API_KEY, "instance-secret");
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a stale auth copy or wrong-target link is dropped and re-linked on the next ensure", { skip: process.platform === "win32" ? "requires POSIX file-symbolic-link semantics" : false }, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-refresh-")), operatorHome = path.join(parent, "operator"), userRoot = path.join(parent, "user");
  try {
    const operatorAuth = path.join(operatorHome, ".codex", "auth.json"); mkdirSync(path.dirname(operatorAuth), { recursive: true }); writeFileSync(operatorAuth, `{"tokens":"v1"}`, { mode: 0o600 });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { HOME: operatorHome, PATH: "/runtime/tools" }, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "codex-auth-refresh", name: "Codex Auth Refresh", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "subscription" } });
    const instanceAuth = path.join(userRoot, "runtime-instances", "codex-auth-refresh", "home", ".codex", "auth.json");
    rmSync(instanceAuth); writeFileSync(instanceAuth, `{"tokens":"stale-copy"}`, { mode: 0o600 });
    writeFileSync(operatorAuth, `{"tokens":"v2"}`, { mode: 0o600 });
    await store.authStatus("codex-auth-refresh");
    assert.equal(lstatSync(instanceAuth).isSymbolicLink(), true); assert.equal(readFileSync(instanceAuth, "utf8"), `{"tokens":"v2"}`);
    rmSync(instanceAuth); symlinkSync(`${operatorAuth}.bak`, instanceAuth);
    await store.authStatus("codex-auth-refresh");
    assert.equal(readlinkSync(instanceAuth), operatorAuth);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("a missing operator auth file links nothing and leaves an instance-local login in place", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-absent-")), operatorHome = path.join(parent, "operator"), userRoot = path.join(parent, "user");
  try {
    mkdirSync(operatorHome, { recursive: true });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { HOME: operatorHome, PATH: "/runtime/tools" }, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "codex-auth-absent", name: "Codex Auth Absent", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "subscription" } });
    const instanceAuth = path.join(userRoot, "runtime-instances", "codex-auth-absent", "home", ".codex", "auth.json");
    assert.equal(existsSync(instanceAuth), false);
    writeFileSync(instanceAuth, `{"tokens":"instance-local-login"}`, { mode: 0o600 });
    await store.authStatus("codex-auth-absent");
    assert.equal(lstatSync(instanceAuth).isSymbolicLink(), false); assert.equal(readFileSync(instanceAuth, "utf8"), `{"tokens":"instance-local-login"}`);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("operator-environment codex accepts prompt-injected skills without writing operator home", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-codex-operator-skills-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), operatorEnv = { HOME: path.join(parent, "operator"), PATH: "/runtime/tools" };
  try {
    const prompt = `Skilled dispatch\n\n# Required Skills\n\n- probe: ${path.join(parent, "shared", "probe", "SKILL.md")}`;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: operatorEnv, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "codex-operator-skills", name: "Codex Operator Skills", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, isolationState: "operator-environment", codex: {}, auth: { mode: "subscription" } });
    const launch = await store.prepareLaunch("codex-operator-skills", { cwd: rootDir, prompt });
    assert.deepEqual(launch.env, operatorEnv); assert.equal(launch.env.CODEX_HOME, undefined);
    assert.equal(existsSync(path.join(userRoot, "runtime-instances", "codex-operator-skills", "home")), false);
    assert.equal(launch.prompt, prompt);
    assert.equal(launch.args.includes("--plugin-dir"), false);
    assert.equal(launch.args.includes("--add-dir"), false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("create takes repeated models with an optional explicit default and dispatches any of them", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-create-models-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    const created = store.command({ kind: "runtime-instance-create", instanceId: "codex-multi", name: "Codex Multi", kindId: "codex", providerId: "openai", models: ["gpt-5.6-sol", "gpt-5.6-terra"], authMode: "api-key", credentialRef: "credential:v1:codex-multi" }).instance as { readonly models: readonly string[]; readonly defaultModel: string };
    assert.deepEqual(created.models, ["gpt-5.6-sol", "gpt-5.6-terra"]); assert.equal(created.defaultModel, "gpt-5.6-sol");
    const explicit = store.command({ kind: "runtime-instance-create", instanceId: "codex-explicit", name: "Codex Explicit", kindId: "codex", providerId: "openai", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", authMode: "api-key", credentialRef: "credential:v1:codex-explicit" }).instance as { readonly defaultModel: string };
    assert.equal(explicit.defaultModel, "gpt-5.6-terra");
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "codex-bad-default", name: "Codex Bad Default", kindId: "codex", providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-unknown", authMode: "api-key", credentialRef: "credential:v1:codex-bad-default" }), (error: unknown) => codedAs(error, "invalid_runtime_model"));
    const second = await store.prepareLaunch("codex-multi", { cwd: "/workspace/repo", prompt: "Second", model: "gpt-5.6-terra" });
    assert.equal(second.args[second.args.indexOf("--model") + 1], "gpt-5.6-terra");
    await assert.rejects(store.prepareLaunch("codex-multi", { cwd: "/workspace/repo", prompt: "Rejected", model: "gpt-unknown" }), (error: unknown) => codedAs(error, "invalid_runtime_model"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("persisted schema v2 records normalize permission and isolation fields once on read", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-field-migration-")), claude = { ...observed, installationId: "claude-field-migration", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [
      { schemaVersion: 2, instanceId: "codex-persisted", name: "Codex Persisted", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: {}, auth: { mode: "subscription" } },
      { schemaVersion: 2, instanceId: "claude-persisted", name: "Claude Persisted", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, claude: {}, auth: { mode: "subscription" } }
    ] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude], env: { HOME: "/operator/home", PATH: "/bin" }, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    assert.deepEqual({ ...store.read("codex-persisted"), codex: undefined }, { schemaVersion: 2, instanceId: "codex-persisted", name: "Codex Persisted", installationId: observed.installationId, installationIdentity: "path-entry/v1", providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, permissionMode: "bypass", isolationState: "enforced", kindId: "codex", auth: { mode: "subscription" }, codex: undefined });
    assert.deepEqual({ ...store.read("claude-persisted"), claude: undefined }, { schemaVersion: 2, instanceId: "claude-persisted", name: "Claude Persisted", installationId: claude.installationId, installationIdentity: "path-entry/v1", providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, permissionMode: "bypass", isolationState: "operator-environment", kindId: "claude", auth: { mode: "subscription" }, claude: undefined });
    const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances as Array<Record<string, unknown>>;
    assert.deepEqual(persisted.map(({ permissionMode, isolationState }) => ({ permissionMode, isolationState })), [{ permissionMode: "bypass", isolationState: "operator-environment" }, { permissionMode: "bypass", isolationState: "enforced" }]);
    const storeAgain = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] }), mtimeFirst = statSync(path.join(userRoot, "runtime-instances.json")).mtimeMs;
    storeAgain.read("codex-persisted");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mtimeMs, mtimeFirst);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("agy uses the operator environment, OAuth-only auth, and a closed effort enum", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-")), agy = { installationId: "agy-installation-test", kindId: "agy" as const, executablePath: "/opt/runtime-test/agy", version: "1.1.15", observedAt: "2026-08-19T00:00:00.000Z" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, env: { HOME: "/operator/home", PATH: "/bin" }, discover: () => [agy], subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "agy-review", name: "AGY Review", kindId: "agy", installationId: agy.installationId, providerId: "google", models: ["gemini-3.1-pro-low"], defaultModel: "gemini-3.1-pro-low", enabled: true, agy: { effort: "low" }, auth: { mode: "subscription" } });
    const launch = await store.prepareLaunch("agy-review", { cwd: "/workspace/repo", prompt: "Reply with exactly AGY-OK", effort: "medium", providerSessionId: "conversation-1" });
    assert.deepEqual(launch.args, ["-p", "Reply with exactly AGY-OK", "--output-format", "stream-json", "--model", "gemini-3.1-pro-low", "--effort", "medium", "--conversation", "conversation-1"]);
    assert.equal(launch.env.HOME, "/operator/home"); assert.equal(launch.env.CODEX_HOME, undefined); assert.equal(launch.env.CLAUDE_CONFIG_DIR, undefined);
    await assert.rejects(store.prepareLaunch("agy-review", { cwd: "/workspace/repo", prompt: "reject", effort: "xhigh" }), (error: unknown) => codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("low, medium, or high"));
    assert.equal(store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance && (store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance as { isolationState: string }).isolationState, "operator-environment");
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "agy-api", name: "AGY API", kindId: "agy", installationId: agy.installationId, providerId: "google", models: ["gemini"], authMode: "api-key", credentialRef: "credential:v1:agy-api" }), (error: unknown) => codedAs(error, "invalid_runtime_auth"));
    assert.throws(() => store.prepareAuthCommand("agy-review", "login"), (error: unknown) => codedAs(error, "runtime_auth_interactive_only"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("agy subscription probes report an unavailable operator environment", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-subscription-probe-")), agy: RuntimeInstallationWitness = { installationId: "agy-rejected-status", kindId: "agy", executablePath: writeProviderExecutable(path.join(userRoot, "agy-models.mjs"), "process.exit(7);\n"), version: "1.1.15", observedAt: "2026-08-19T00:00:00.000Z" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [agy] });
    store.create({ schemaVersion: 1, instanceId: "agy-subscription", name: "AGY Subscription", kindId: "agy", installationId: agy.installationId, providerId: "google", model: "gemini-3.1-pro-low", auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("agy-subscription"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in the operator environment." });
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime auth readiness is explicit, safe, and never falls back across modes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-readiness-"));
  try {
    let subscriptionReady = false, credentialCalls = 0, subscriptionCalls = 0;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => { credentialCalls += 1; throw new Error("missing"); }, subscriptionReady: () => { subscriptionCalls += 1; return subscriptionReady ? { status: "ready", code: null, hint: null } : { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." }; } });
    store.create({ schemaVersion: 1, instanceId: "codex-sub", name: "Codex Subscription", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("codex-sub"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." });
    assert.equal(credentialCalls, 0); assert.equal(subscriptionCalls, 1);
    subscriptionReady = true;
    assert.deepEqual(await store.authStatus("codex-sub"), { status: "ready", code: null, hint: null });
    assert.equal(credentialCalls, 0); assert.equal(subscriptionCalls, 2);
    store.create({ schemaVersion: 1, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/missing" } });
    assert.deepEqual(await store.authStatus("codex-api"), { status: "not-ready", code: "runtime_credential_unavailable", hint: "The configured runtime API credential is unavailable." });
    assert.equal(subscriptionCalls, 2);
    const receipt = await store.command({ kind: "runtime-instance-show", instanceId: "codex-api", probe: true });
    assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath|\/opt\/runtime-test/u);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription probes distinguish authenticated, unauthenticated, and inconclusive states", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-probe-state-"));
  try {
    let probe: RuntimeAuthReadiness = { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." };
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], subscriptionReady: () => probe });
    store.create({ schemaVersion: 1, instanceId: "codex-probe", name: "Codex Probe", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    const unchecked = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe" }).instance as Record<string, unknown>; assert.equal(unchecked.authState, "unknown"); assert.equal((unchecked.authReadiness as Record<string, unknown>).code, "runtime_auth_not_checked");
    const unauthenticated = (await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })).instance as Record<string, unknown>; assert.equal(unauthenticated.authState, "unauthenticated"); assert.equal((unauthenticated.authReadiness as Record<string, unknown>).code, "runtime_subscription_required");
    probe = { status: "not-ready", code: "runtime_auth_probe_failed", hint: "Provider authentication probe could not determine readiness." };
    const inconclusive = (await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })).instance as Record<string, unknown>; assert.equal(inconclusive.authState, "unknown"); assert.equal((inconclusive.authReadiness as Record<string, unknown>).code, "runtime_auth_probe_failed");
    probe = { status: "ready", code: null, hint: null };
    const authenticated = (await store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true })).instance as Record<string, unknown>; assert.equal(authenticated.authState, "authenticated");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription auth commands use the witnessed executable and instance-only state root", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { PATH: "/runtime/tools", HOME: "/host/home", TMPDIR: "/host/tmp", OPENAI_API_KEY: "host-secret", HTTPS_PROXY: "host-proxy" } });
    store.create({ schemaVersion: 1, instanceId: "codex-sub", name: "Codex Subscription", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-sub"), providerConfigDirectory = path.join(stateRoot, "home", ".codex");
    assert.equal(statSync(providerConfigDirectory).mode & 0o777, 0o700);
    assert.equal(existsSync(path.join(stateRoot, "home", ".claude")), false);
    const command = store.prepareAuthCommand("codex-sub", "login");
    assert.equal(command.executablePath, observed.executablePath); assert.deepEqual(command.args, ["login"]); assert.equal(command.cwd, stateRoot);
    assert.deepEqual(command.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CODEX_HOME: providerConfigDirectory });
    assert.deepEqual(store.prepareAuthCommand("codex-sub", "logout").args, ["logout"]);
    store.command({ kind: "runtime-instance-update", instanceId: "codex-sub", enabled: false });
    assert.deepEqual(store.prepareAuthCommand("codex-sub", "login").args, ["login"]); assert.deepEqual(store.prepareAuthCommand("codex-sub", "logout").args, ["logout"]);
    store.create({ schemaVersion: 1, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" } });
    assert.throws(() => store.prepareAuthCommand("codex-api", "login"), (error: unknown) => codedAs(error, "runtime_auth_mode_mismatch"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

function requireDirectory(directory: string): void { mkdirSync(directory); }
function codedAs(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }

test("win32 instances derive USERPROFILE/TEMP/APPDATA isolation without POSIX variables", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-isolation-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], platform: "win32", env: { PATH: "C:\\runtime\\tools", HOME: "C:\\host\\home", TMPDIR: "C:\\host\\tmp", SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", COMSPEC: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE;.CMD", OPENAI_API_KEY: "host-secret" }, resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 1, instanceId: "codex-win", name: "Codex Windows", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "credential:v1:codex-win" } });
    const launch = await store.prepareLaunch("codex-win", { cwd: "/workspace/repo", prompt: "Inspect" }), stateRoot = path.join(userRoot, "runtime-instances", "codex-win");
    assert.deepEqual(launch.env, { PATH: "C:\\runtime\\tools", PATHEXT: ".COM;.EXE;.CMD", SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", COMSPEC: "C:\\Windows\\system32\\cmd.exe", USERPROFILE: path.join(stateRoot, "home"), TEMP: path.join(stateRoot, "tmp"), TMP: path.join(stateRoot, "tmp"), APPDATA: path.join(stateRoot, "home", "AppData", "Roaming"), LOCALAPPDATA: path.join(stateRoot, "home", "AppData", "Local"), CODEX_HOME: path.join(stateRoot, "home", ".codex") });
    assert.match(readFileSync(path.join(launch.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "instance-secret"/u);
    assert.equal("HOME" in launch.env, false); assert.equal("TMPDIR" in launch.env, false); assert.equal("XDG_RUNTIME_DIR" in launch.env, false);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("linux instances keep the POSIX isolation shape distinct from the host", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-linux-isolation-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [{ ...observed, kindId: "claude", installationId: "claude-installation-test", executablePath: "/opt/runtime-test/claude" }], platform: "linux", env: { PATH: "/runtime/tools", HOME: "/host/home", USERPROFILE: "C:\\host\\home", XDG_RUNTIME_DIR: "/host/run/xdg", ANTHROPIC_API_KEY: "host-secret" } });
    store.create({ schemaVersion: 2, instanceId: "claude-linux", name: "Claude Linux", kindId: "claude", installationId: "claude-installation-test", providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, isolationState: "enforced", claude: {}, auth: { mode: "subscription" } });
    const command = store.prepareAuthCommand("claude-linux", "login"), stateRoot = path.join(userRoot, "runtime-instances", "claude-linux");
    assert.deepEqual(command.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude") });
    assert.equal("USERPROFILE" in command.env, false); assert.equal(Object.values(command.env).includes("host-secret"), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("two same-binary same-model instances never share state roots or credentials", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-pair-isolation-"));
  try {
    const vault = new Map<string, string>([["credential:v1:codex-a", "secret-a"], ["credential:v1:codex-b", "secret-b"]]), secrets: string[] = [];
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: (reference) => { if (!vault.has(reference)) throw new Error(`missing ${reference}`); const secret = vault.get(reference)!; secrets.push(secret); return secret; } });
    for (const [suffix, reference] of [["a", "credential:v1:codex-a"], ["b", "credential:v1:codex-b"]] as const) store.create({ schemaVersion: 1, instanceId: `codex-pair-${suffix}`, name: `Codex Pair ${suffix}`, kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: reference } });
    const launchA = await store.prepareLaunch("codex-pair-a", { cwd: "/workspace/repo", prompt: "A" }), launchB = await store.prepareLaunch("codex-pair-b", { cwd: "/workspace/repo", prompt: "B" }), rootA = path.join(userRoot, "runtime-instances", "codex-pair-a"), rootB = path.join(userRoot, "runtime-instances", "codex-pair-b");
    assert.notEqual(rootA, rootB); assert.notEqual(launchA.env.HOME, launchB.env.HOME); assert.notEqual(launchA.env.TMPDIR, launchB.env.TMPDIR);
    assert.match(readFileSync(path.join(launchA.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "secret-a"/u); assert.match(readFileSync(path.join(launchB.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "secret-b"/u);
    assert.equal(Object.values(launchA.env).includes("secret-b"), false); assert.equal(Object.values(launchB.env).includes("secret-a"), false);
    assert.equal(JSON.stringify(launchA).includes("secret-b"), false); assert.equal(JSON.stringify(launchB).includes("secret-a"), false);
    store.create({ schemaVersion: 1, instanceId: "codex-pair-c", name: "Codex Pair C", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "credential:v1:not-in-vault" } });
    await assert.rejects(store.prepareLaunch("codex-pair-c", { cwd: "/workspace/repo", prompt: "C" }), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
    assert.equal(secrets.includes("secret-a"), true); assert.equal(secrets.includes("secret-b"), true);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("credential references accept the backend-agnostic grammar and legacy keychain form", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-grammar-")), store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
  try {
    const base = { schemaVersion: 1 as const, kindId: "codex" as const, installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key" as const, credentialRef: "" } };
    for (const reference of ["credential:v1:codex-review", "credential:v1:openai-main-2", "keychain:harness/codex-review"]) { const config = { ...base, instanceId: "codex-grammar", name: "Codex Grammar", auth: { mode: "api-key" as const, credentialRef: reference } }, created = store.create(config); assert.deepEqual(created.models, ["gpt-5.6-sol"]); assert.equal(created.defaultModel, "gpt-5.6-sol"); assert.equal(created.enabled, true); store.delete("codex-grammar"); }
    for (const reference of ["credential:v1:-leading", "credential:v2:codex", "keychain:a/b/c", "plaintext-secret", "credential:v1:"]) assert.throws(() => store.create({ ...base, instanceId: "codex-grammar", name: "Codex Grammar", auth: { mode: "api-key", credentialRef: reference } }), (error: unknown) => codedAs(error, "invalid_credential_reference"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

// The PATHEXT suffix enumeration is observable from any host: a POSIX host
// witnesses the argv-direct `.exe`-suffixed probe directly, while a real
// Windows host witnesses the same enumeration through the `.cmd` shim the
// shared provider stub fixture produces.
test("win32 installation discovery probes PATHEXT suffixes and witnesses the shim", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-discovery-")), bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    const executablePath = writeProviderExecutable(process.platform === "win32" ? path.join(bin, "codex") : path.join(bin, "codex.exe"), "console.log(\"stub-runtime-1.0.0\");\n");
    const installations = discoverRuntimeInstallations({ env: { PATH: bin }, platform: "win32", now: () => "2026-08-15T01:00:00.000Z" });
    assert.equal(installations.length, 1);
    assert.deepEqual({ kindId: installations[0]!.kindId, version: installations[0]!.version, observedAt: installations[0]!.observedAt }, { kindId: "codex", version: "stub-runtime-1.0.0", observedAt: "2026-08-15T01:00:00.000Z" });
    assert.equal(installations[0]!.executablePath.endsWith(process.platform === "win32" ? "codex.cmd" : "codex.exe"), true);
    assert.equal(installations[0]!.executablePath, realpathSync(executablePath));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
// The shared stub fixture must forward the exact argv through the platform's
// real launch shape: the discovery version probe proves single-argument
// passthrough (`--version`), and the codex subscription probe proves
// multi-argument passthrough (`login status`) — the stub answers ready only
// when it receives that argv verbatim, so a shim that dropped or reordered
// arguments would surface as runtime_subscription_required, not readiness.
test("the shared provider stub fixture launches with the exact argv on every platform", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-stub-fixture-")), bin = path.join(root, "bin"), witness = path.join(root, "argv-witness.json"), userRoot = path.join(root, "user"), script = path.join(bin, "codex");
  try {
    requireDirectory(bin);
    const executablePath = writeProviderExecutable(script, `const fs = require("node:fs");\nconst argv = process.argv.slice(2), serialized = JSON.stringify(argv);\nfs.writeFileSync(${JSON.stringify(witness)}, serialized);\nconsole.log(serialized);\nif (serialized !== JSON.stringify(["--version"]) && serialized !== JSON.stringify(["login", "status"])) process.exit(9);\n`);
    assert.equal(readFileSync(script, "utf8").startsWith(`#!${process.execPath}\n`), true);
    if (process.platform === "win32") assert.equal(executablePath.endsWith(".cmd"), true); else assert.equal(statSync(script).mode & 0o777, 0o755);
    const installations = discoverRuntimeInstallations({ env: { PATH: bin } });
    assert.equal(installations.length, 1, JSON.stringify(installations));
    assert.equal(installations[0]!.executablePath, realpathSync(executablePath));
    assert.equal(installations[0]!.version, JSON.stringify(["--version"]));
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installations });
    store.create({ schemaVersion: 2, instanceId: "codex-stub-argv", name: "Codex Stub Argv", kindId: "codex", installationId: installations[0]!.installationId, providerId: "openai", models: ["argv-model"], defaultModel: "argv-model", enabled: true, codex: {}, auth: { mode: "subscription" } });
    assert.deepEqual(await store.authStatus("codex-stub-argv"), { status: "ready", code: null, hint: null });
    assert.equal(readFileSync(witness, "utf8"), JSON.stringify(["login", "status"]));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
