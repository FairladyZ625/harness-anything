// harness-test-tier: contract
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseThinCommand } from "../../cli/src/cli/thin-command.ts";
import { discoverRuntimeInstallations, openRuntimeInstanceStore, type RuntimeAuthReadiness, type RuntimeInstallationWitness } from "../src/agent-runtime-instances.ts";
import { resolveAgentSkills } from "../src/agent-skills.ts";
import { daemonProtocolCommands } from "../src/protocol/daemon-protocol.contract.ts";

const observed: RuntimeInstallationWitness = { installationId: "codex-installation-test", kindId: "codex", executablePath: "/opt/runtime-test/codex", version: "0.146.1", observedAt: "2026-08-15T00:00:00.000Z" };

test("machine runtime instance CRUD binds a witnessed installation and enforces private storage", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-store-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), config = { schemaVersion: 1 as const, instanceId: "codex-review", name: "Codex Review", kindId: "codex" as const, installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", reasoningEffort: "high", baseUrl: "https://api.openai.com/v1", auth: { mode: "api-key" as const, credentialRef: "keychain:harness/codex-review" } };
    const normalized = { schemaVersion: 2 as const, instanceId: config.instanceId, name: config.name, installationId: config.installationId, providerId: config.providerId, models: [config.model], defaultModel: config.model, enabled: true, auth: config.auth, kindId: config.kindId, codex: { reasoningEffort: config.reasoningEffort, baseUrl: config.baseUrl } };
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

test("Codex sidecar launch materializes the complete non-secret provider config in isolated CODEX_HOME", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-isolation-"));
  try {
    let resolvedReference: string | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], env: { PATH: "/runtime/tools", HOME: "/host/home", TMPDIR: "/host/tmp", OPENAI_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-token", HTTPS_PROXY: "http://host-proxy" }, resolveCredential: (reference) => { resolvedReference = reference; return "instance-secret"; } });
    store.create({ schemaVersion: 2, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "codex_local_access", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "xhigh", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Harness-Probe": "present", "X-Static-Route": "sidecar" } }, auth: { mode: "api-key", credentialRef: "keychain:harness/codex-api" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-api"); chmodSync(path.join(userRoot, "runtime-instances.json"), 0o644); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) chmodSync(directory, 0o755);
    const launch = store.prepareLaunch("codex-api", { cwd: "/workspace/repo", prompt: "Inspect" });
    assert.equal(resolvedReference, "keychain:harness/codex-api");
    assert.deepEqual(launch.installation, observed);
    assert.equal(launch.executablePath, observed.executablePath);
    assert.deepEqual(launch.args, ["exec", "--json", "--sandbox", "workspace-write", "--config", "sandbox_workspace_write.exclude_tmpdir_env_var=true", "--config", "sandbox_workspace_write.exclude_slash_tmp=true", "--model", "gpt-5.6-sol", "-"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CODEX_HOME: path.join(stateRoot, "home", ".codex") });
    const codexConfig = path.join(launch.env.CODEX_HOME!, "config.toml"), text = readFileSync(codexConfig, "utf8"); assert.equal(statSync(codexConfig).mode & 0o777, 0o600); assert.equal(text, `model_provider = "codex_local_access"\nmodel_reasoning_effort = "xhigh"\n\n[model_providers."codex_local_access"]\nname = "codex_local_access"\nbase_url = "http://127.0.0.1:1/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nhttp_headers = { "X-Harness-Probe" = "present", "X-Static-Route" = "sidecar" }\nexperimental_bearer_token = "instance-secret"\n`); assert.match(text, /experimental_bearer_token = "instance-secret"/u); assert.doesNotMatch(JSON.stringify(launch), /instance-secret/u);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
    assert.equal(Object.values(launch.env).includes("host-token"), false);
    assert.equal(Object.values(launch.env).includes("http://host-proxy"), false);
    assert.equal(launch.prompt, "Inspect"); assert.equal(launch.cwd, "/workspace/repo");
    assert.equal(statSync(path.join(userRoot, "runtime-instances.json")).mode & 0o777, 0o600); for (const directory of [stateRoot, ...["home", "tmp", "run"].map((name) => path.join(stateRoot, name))]) assert.equal(statSync(directory).mode & 0o777, 0o700, directory);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime kinds receive the same declared skill through their distinct native discovery mounts", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-skill-mounts-")), rootDir = path.join(parent, "repo"), skillDir = path.join(rootDir, "harness", "skills", "probe"), userRoot = path.join(parent, "user"), installations = (["codex", "claude", "agy"] as const).map((kindId) => ({ installationId: `${kindId}-skills`, kindId, executablePath: `/opt/runtime-test/${kindId}`, version: "1.0.0", observedAt: "2026-08-20T00:00:00.000Z" }));
  try { mkdirSync(skillDir, { recursive: true }); writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: probe\ndescription: Probe\n---\nPROVIDER_SKILL\n"); const skills = resolveAgentSkills({ rootDir, skills: [{ id: "probe", path: "skills/probe" }] }), store = openRuntimeInstanceStore({ userRoot, discover: () => installations, subscriptionReady: () => ({ status: "ready", code: null, hint: null }) }); for (const installation of installations) store.create({ schemaVersion: 2, instanceId: `${installation.kindId}-skills`, name: `${installation.kindId} skills`, kindId: installation.kindId, installationId: installation.installationId, providerId: installation.kindId, models: ["skill-model"], defaultModel: "skill-model", enabled: true, ...(installation.kindId === "codex" ? { codex: {} } : installation.kindId === "claude" ? { claude: {} } : { agy: {} }), auth: { mode: "subscription" } }); const launches = installations.map((installation) => ({ kindId: installation.kindId, launch: store.prepareLaunch(`${installation.kindId}-skills`, { cwd: rootDir, prompt: "Use probe", skillRoot: skills[0]!.rootDir, skills }) })); const codex = launches.find(({ kindId }) => kindId === "codex")!.launch, claude = launches.find(({ kindId }) => kindId === "claude")!.launch, agy = launches.find(({ kindId }) => kindId === "agy")!.launch, claudePlugin = claude.args[claude.args.indexOf("--plugin-dir") + 1]!, agyWorkspace = agy.args[agy.args.indexOf("--add-dir") + 1]!; assert.equal(readFileSync(path.join(codex.env.CODEX_HOME!, "skills", "probe", "SKILL.md"), "utf8").includes("PROVIDER_SKILL"), true); assert.equal(readFileSync(path.join(claudePlugin, "skills", "probe", "SKILL.md"), "utf8").includes("PROVIDER_SKILL"), true); assert.deepEqual(JSON.parse(readFileSync(path.join(claudePlugin, ".claude-plugin", "plugin.json"), "utf8")), { name: `harness-agent-skills-${path.basename(claudePlugin)}`, version: "1.0.0", description: "Agent-declared skills" }); assert.equal(readFileSync(path.join(agyWorkspace, ".agents", "skills", "probe", "SKILL.md"), "utf8").includes("PROVIDER_SKILL"), true); assert.equal(claude.args[claude.args.indexOf("--plugin-dir")], "--plugin-dir"); assert.equal(agy.args[agy.args.indexOf("--add-dir")], "--add-dir"); const clearedCodex = store.prepareLaunch("codex-skills", { cwd: rootDir, prompt: "Use no skills" }); assert.equal(clearedCodex.definition.kindId, "codex"); assert.deepEqual(readdirSync(path.join(codex.env.CODEX_HOME!, "skills")), []); } finally { rmSync(parent, { recursive: true, force: true }); }
});

test("API-key launch fails closed on a missing key or installation without checking subscription auth", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-api-fail-closed-"));
  try {
    let installationPresent = true, subscriptionChecks = 0;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => installationPresent ? [observed] : [], resolveCredential: () => { throw new Error("missing key"); }, subscriptionReady: () => { subscriptionChecks += 1; return { status: "ready", code: null, hint: null }; } });
    store.create({ schemaVersion: 1, instanceId: "codex-closed", name: "Codex Closed", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/missing" } });
    assert.throws(() => store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_credential_unavailable")); assert.equal(subscriptionChecks, 0);
    installationPresent = false; assert.throws(() => store.prepareLaunch("codex-closed", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_installation_not_found")); assert.equal(subscriptionChecks, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription launch fails closed without provider-native readiness and never falls back to an API key", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-isolation-")), claude: RuntimeInstallationWitness = { ...observed, installationId: "claude-installation-test", kindId: "claude", executablePath: "/opt/runtime-test/claude" };
  try {
    let ready = false, credentialCalls = 0, readinessEnvironment: NodeJS.ProcessEnv | undefined;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude], env: { PATH: "/runtime/tools", HOME: "/host/home", ANTHROPIC_API_KEY: "host-secret", ANTHROPIC_AUTH_TOKEN: "host-oauth" }, resolveCredential: () => { credentialCalls += 1; return "fallback-secret"; }, subscriptionReady: ({ env }) => { readinessEnvironment = env; return ready ? { status: "ready", code: null, hint: null } : { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." }; } });
    store.create({ schemaVersion: 2, instanceId: "claude-subscription", name: "Claude Subscription", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, claude: {}, auth: { mode: "subscription" } });
    assert.throws(() => store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), (error: unknown) => codedAs(error, "runtime_subscription_required"));
    assert.equal(credentialCalls, 0);
    ready = true; const launch = store.prepareLaunch("claude-subscription", { cwd: "/workspace/repo", prompt: "Inspect" }), stateRoot = path.join(userRoot, "runtime-instances", "claude-subscription");
    assert.deepEqual(launch.args, ["-p", "--verbose", "--output-format", "stream-json", "--permission-mode", "acceptEdits", "--model", "claude-fable-5"]);
    assert.deepEqual(launch.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude") });
    assert.deepEqual(readinessEnvironment, launch.env);
    assert.equal(credentialCalls, 0);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription probes distinguish a rejected status command from an unspawnable executable", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-subscription-probe-")), rejectedPath = path.join(userRoot, "rejected-status.mjs"), rejected = { ...observed, installationId: "codex-rejected-status", executablePath: rejectedPath }, unspawnable = { ...observed, installationId: "codex-unspawnable-status", executablePath: path.join(userRoot, "missing-status") };
  try {
    writeFileSync(rejectedPath, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [rejected, unspawnable] });
    for (const installation of [rejected, unspawnable]) store.create({ schemaVersion: 1, instanceId: installation.installationId, name: installation.installationId, kindId: "codex", installationId: installation.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    assert.equal(store.authStatus(rejected.installationId).code, "runtime_subscription_required");
    assert.equal(store.authStatus(unspawnable.installationId).code, "runtime_auth_probe_failed");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance CRUD is a closed defineCliCommand surface", () => {
  const ids = ["runtime-instance-create", "runtime-instance-list", "runtime-instance-show", "runtime-instance-update", "runtime-instance-delete"];
  for (const id of ids) { const command = daemonProtocolCommands.find((entry) => entry.id === id); assert.ok(command, id); assert.deepEqual(command.inputs, command.flags, id); }
  const created = parseThinCommand(["runtime", "instance", "create", "--id", "codex-review", "--name", "Codex Review", "--kind", "codex", "--installation", observed.installationId, "--provider", "codex_local_access", "--model", "gpt-5.6-sol", "--effort", "xhigh", "--base-url", "http://127.0.0.1:1/v1", "--wire-api", "responses", "--requires-openai-auth", "--http-header", "X-Harness-Probe=present", "--auth", "api-key", "--credential-ref", "keychain:harness/codex-review"]);
  assert.equal(created.ok, true); if (created.ok) assert.deepEqual({ method: created.command.method, action: created.command.action }, { method: "daemon.runtimeInstance.create", action: { kind: "runtime-instance-create", instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: observed.installationId, providerId: "codex_local_access", model: "gpt-5.6-sol", codex: { reasoningEffort: "xhigh", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Harness-Probe": "present" } }, authMode: "api-key", credentialRef: "keychain:harness/codex-review" } });
  for (const [argv, method, instanceId] of [["list", "daemon.runtimeInstance.list", undefined], ["show", "daemon.runtimeInstance.show", "codex-review"], ["update", "daemon.runtimeInstance.update", "codex-review"], ["delete", "daemon.runtimeInstance.delete", "codex-review"]] as const) { const parsed = parseThinCommand(["runtime", "instance", argv, ...(instanceId ? [instanceId] : [])]); assert.equal(parsed.ok, argv === "update" ? false : true, JSON.stringify(parsed)); if (parsed.ok) assert.deepEqual({ method: parsed.command.method, action: parsed.command.action }, { method, action: { kind: `runtime-instance-${argv}`, ...(instanceId ? { instanceId } : {}) } }); }
  const update = parseThinCommand(["runtime", "instance", "update", "codex-review", "--name", "Updated", "--model", "gpt-5.6-sol", "--model", "gpt-5.6-terra", "--default-model", "gpt-5.6-terra", "--disable"]); assert.equal(update.ok, true); if (update.ok) assert.deepEqual(update.command.action, { kind: "runtime-instance-update", instanceId: "codex-review", name: "Updated", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: false });
  const run = parseThinCommand(["runtime", "run", "codex-review", "--model", "gpt-5.6-terra", "--effort", "xhigh", "--prompt", "Inspect"]); assert.equal(run.ok, true); if (run.ok) { assert.equal(run.command.action.model, "gpt-5.6-terra"); assert.equal(run.command.action.effort, "xhigh"); }
  assert.deepEqual(parseThinCommand(["runtime", "run", "codex-review", "--effort", "turbo", "--prompt", "Inspect"]), { ok: false, code: "invalid_runtime_effort", nextAction: "Use minimal, low, medium, high, or xhigh with a Codex instance.", json: false });
  const probed = parseThinCommand(["runtime", "instance", "show", "codex-review", "--probe"]); assert.equal(probed.ok, true); if (probed.ok) assert.deepEqual({ method: probed.command.method, action: probed.command.action }, { method: "daemon.runtimeInstance.show", action: { kind: "runtime-instance-show", instanceId: "codex-review", probe: true } });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "api-key"]), { ok: false, code: "missing_field", nextAction: "API-key instances require --credential-ref <opaque-ref>.", json: false });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", "--credential-ref", "keychain:harness/bad"]), { ok: false, code: "invalid_field", nextAction: "Subscription instances cannot accept a credential reference.", json: false });
  assert.deepEqual(parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "claude", "--installation", observed.installationId, "--provider", "anthropic", "--model", "claude", "--wire-api", "responses", "--auth", "subscription"]), { ok: false, code: "invalid_field", nextAction: "Claude runtime instances cannot accept Codex options: --effort, --wire-api, --requires-openai-auth, or --http-header.", json: false });
  for (const flag of ["--env", "--argv", "--isolation-profile"]) { const parsed = parseThinCommand(["runtime", "instance", "create", "--id", "bad", "--name", "Bad", "--kind", "codex", "--installation", observed.installationId, "--provider", "openai", "--model", "gpt", "--auth", "subscription", flag, "open"]); assert.equal(parsed.ok ? "ok" : parsed.code, "unknown_field", flag); }
});

test("runtime instance command receipts expose readiness metadata without credential refs or host paths", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-command-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    const created = store.command({ kind: "runtime-instance-create", instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", authMode: "api-key", credentialRef: "keychain:harness/codex-safe" });
    assert.deepEqual(created.instance, { schemaVersion: 2, instanceId: "codex-safe", name: "Codex Safe", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: null, baseUrl: null, baseUrlConfigured: false, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: "api-key", authState: "configured", authReadiness: { status: "not-ready", code: "runtime_auth_not_checked", hint: "Authentication has not been verified in this daemon generation." }, isolationState: "enforced" });
    const listed = store.command({ kind: "runtime-instance-list" }), shown = store.command({ kind: "runtime-instance-show", instanceId: "codex-safe" });
    assert.deepEqual(listed.installations, [{ installationId: observed.installationId, kindId: "codex", version: observed.version, observedAt: observed.observedAt }]); assert.equal(listed.summary, `ID\tNAME\tKIND\tMODEL\tENABLED\tAUTH MODE\tLOGIN STATUS\ncodex-safe\tCodex Safe\tcodex\tgpt-5.6-sol\tenabled\tapi-key\tnot-checked\n\nINSTALLATION\tKIND\tVERSION\tOBSERVED AT\n${observed.installationId}\tcodex\t${observed.version}\t${observed.observedAt}`);
    assert.deepEqual(shown.instance, created.instance);
    for (const receipt of [created, listed, shown]) { assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|instance-secret|executablePath|\/opt\/runtime-test/u); assert.equal(receipt.schema, "command-receipt/v2"); assert.equal(receipt.ok, true); }
    assert.equal(store.command({ kind: "runtime-instance-delete", instanceId: "codex-safe" }).deletedInstanceId, "codex-safe");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance create filters auto-resolution by kind and rejects same-kind ambiguity", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-resolution-")), ambiguousRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-installation-ambiguous-")), claude = { ...observed, installationId: "claude-first", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude", version: "claude 1.0.0" }, codex = { ...observed, installationId: "codex-first", version: "codex 1.0.0" }, secondClaude = { ...claude, installationId: "claude-second", version: "claude 2.0.0" };
  try {
    const automatic = openRuntimeInstanceStore({ userRoot, discover: () => [claude, codex] }), created = automatic.command({ kind: "runtime-instance-create", instanceId: "claude-auto", name: "Claude Auto", kindId: "claude", providerId: "anthropic", model: "claude-fable-5", authMode: "subscription" });
    assert.equal((created.instance as Record<string, unknown>).installationId, claude.installationId);
    const ambiguous = openRuntimeInstanceStore({ userRoot: ambiguousRoot, discover: () => [claude, codex, secondClaude] });
    assert.throws(() => ambiguous.command({ kind: "runtime-instance-create", instanceId: "claude-ambiguous", name: "Claude Ambiguous", kindId: "claude", providerId: "anthropic", model: "claude-fable-5", authMode: "subscription" }), (error: unknown) => codedAs(error, "runtime_installation_ambiguous") && error instanceof Error && error.message.includes(claude.installationId) && error.message.includes(secondClaude.installationId));
  } finally { rmSync(userRoot, { recursive: true, force: true }); rmSync(ambiguousRoot, { recursive: true, force: true }); }
});

test("runtime instance command adapter rejects ambiguous or unknown auth modes", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-auth-command-")), store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), base = { kind: "runtime-instance-create", instanceId: "codex-auth", name: "Codex Auth", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol" };
  try { assert.throws(() => store.command({ ...base, authMode: "oauth", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); assert.throws(() => store.command({ ...base, authMode: "subscription", credentialRef: "keychain:harness/codex-auth" }), (error: unknown) => codedAs(error, "invalid_runtime_auth")); }
  finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("public instance projections keep provider options in the matching kind section", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-public-projection-")), claude = { ...observed, installationId: "claude-projection", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" }, store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    store.create({ schemaVersion: 2, instanceId: "codex-projection", name: "Codex Projection", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", wireApi: "responses", requiresOpenAiAuth: true, httpHeaders: { "X-Probe": "present" } }, auth: { mode: "subscription" } });
    store.create({ schemaVersion: 2, instanceId: "claude-projection", name: "Claude Projection", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude"], defaultModel: "claude", enabled: true, claude: { baseUrl: "https://gateway.example.test/v1" }, auth: { mode: "subscription" } });
    const codex = store.command({ kind: "runtime-instance-show", instanceId: "codex-projection" }).instance as Record<string, unknown>, claudeDto = store.command({ kind: "runtime-instance-show", instanceId: "claude-projection" }).instance as Record<string, unknown>, listed = store.command({ kind: "runtime-instance-list" }).instances as Array<Record<string, unknown>>;
    assert.deepEqual(codex.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", baseUrlConfigured: true, wire_api: "responses", requires_openai_auth: true, http_headers: { "X-Probe": "present" } }); assert.equal("reasoningEffort" in codex, false); assert.equal("baseUrl" in codex, false); assert.equal("codex" in claudeDto, false); assert.deepEqual(claudeDto.claude, { baseUrl: "https://gateway.example.test/v1", baseUrlConfigured: true }); assert.equal(listed.every((item) => item.kindId === "codex" ? "codex" in item : "claude" in item), true);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("kind-specific runtime config fails closed across adapters and rejects secret-like persisted headers", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-kind-config-")), claude = { ...observed, installationId: "claude-installation-test", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" }, store = openRuntimeInstanceStore({ userRoot, discover: () => [observed, claude] });
  try {
    const common = { schemaVersion: 2 as const, instanceId: "claude-closed", name: "Claude Closed", kindId: "claude" as const, installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, auth: { mode: "subscription" as const } };
    assert.throws(() => store.create({ ...common, claude: {}, codex: { wireApi: "responses" } } as never), (error: unknown) => codedAs(error, "invalid_runtime_kind_config") && error.message.includes("claude runtime instance cannot include codex"));
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "claude-command", name: "Claude Command", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", model: "claude-fable-5", claude: {}, codex: { wireApi: "responses" }, authMode: "subscription" }), (error: unknown) => codedAs(error, "invalid_runtime_kind_config"));
    assert.throws(() => store.create({ schemaVersion: 2, instanceId: "codex-secret-header", name: "Codex Secret Header", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { baseUrl: "http://127.0.0.1:1/v1", httpHeaders: { Authorization: "Bearer forbidden" } }, auth: { mode: "subscription" } }), (error: unknown) => codedAs(error, "invalid_runtime_http_headers"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime instance update changes metadata and models without touching credentials or state root", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-update-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-update", name: "Before", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, auth: { mode: "api-key", credentialRef: "credential:v1:codex-update" } });
    const stateRoot = path.join(userRoot, "runtime-instances", "codex-update"), auth = store.read("codex-update")!.auth, updated = store.command({ kind: "runtime-instance-update", instanceId: "codex-update", name: "After", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: false });
    assert.equal((updated.instance as { readonly name: string }).name, "After"); assert.deepEqual((updated.instance as { readonly models: readonly string[] }).models, ["gpt-5.6-sol", "gpt-5.6-terra"]); assert.equal((updated.instance as { readonly defaultModel: string }).defaultModel, "gpt-5.6-terra"); assert.equal((updated.instance as { readonly enabled: boolean }).enabled, false);
    assert.deepEqual(store.read("codex-update")!.auth, auth); assert.equal(existsSync(stateRoot), true);
    assert.deepEqual(store.command({ kind: "runtime-instance-list" }).instances, []);
    assert.equal((store.command({ kind: "runtime-instance-list", all: true }).instances as Array<{ readonly enabled: boolean }>)[0]!.enabled, false);
    assert.throws(() => store.prepareLaunch("codex-update", { cwd: "/workspace/repo", prompt: "Inspect", model: "gpt-5.6-sol" }), (error: unknown) => codedAs(error, "runtime_instance_disabled"));
    assert.throws(() => store.command({ kind: "runtime-instance-update", instanceId: "codex-update", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-terra" }), (error: unknown) => codedAs(error, "invalid_runtime_model"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("legacy runtime instance records migrate once to schema v2 on read", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-migration-"));
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 1, instanceId: "codex-legacy", name: "Legacy", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
    assert.deepEqual(store.read("codex-legacy"), { schemaVersion: 2, instanceId: "codex-legacy", name: "Legacy", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, auth: { mode: "subscription" }, kindId: "codex", codex: {} });
    assert.equal(JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0].schemaVersion, 2);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("flat schema v2 runtime config normalizes into its kind section on read", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-instance-v2-migration-"));
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "codex-flat", name: "Flat", kindId: "codex", installationId: observed.installationId, providerId: "sidecar", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] }), config = store.read("codex-flat"); assert.deepEqual(config?.codex, { reasoningEffort: "high", baseUrl: "http://127.0.0.1:1/v1" }); const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0]; assert.deepEqual(persisted.codex, config?.codex); assert.equal("reasoningEffort" in persisted, false); assert.equal("baseUrl" in persisted, false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("flat Claude effort from schema v2 migrates away without granting Claude Codex configuration", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-claude-v2-migration-")), claude = { ...observed, installationId: "claude-installation-test", kindId: "claude" as const, executablePath: "/opt/runtime-test/claude" };
  try {
    writeFileSync(path.join(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "claude-flat", name: "Claude Flat", kindId: "claude", installationId: claude.installationId, providerId: "anthropic", models: ["claude-fable-5"], defaultModel: "claude-fable-5", enabled: true, reasoningEffort: "high", baseUrl: "https://gateway.example.test/v1", auth: { mode: "subscription" } }] })}\n`);
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [claude] }); assert.deepEqual(store.read("claude-flat")?.claude, { baseUrl: "https://gateway.example.test/v1" }); const persisted = JSON.parse(readFileSync(path.join(userRoot, "runtime-instances.json"), "utf8")).instances[0]; assert.deepEqual(persisted.claude, { baseUrl: "https://gateway.example.test/v1" }); assert.equal("reasoningEffort" in persisted, false); assert.equal("codex" in persisted, false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("one enabled instance dispatches two supported models without reauth", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-model-choice-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-models", name: "Models", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol", "gpt-5.6-terra"], defaultModel: "gpt-5.6-sol", enabled: true, auth: { mode: "api-key", credentialRef: "credential:v1:codex-models" } });
    const first = store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "First", model: "gpt-5.6-sol" }), second = store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "Second", model: "gpt-5.6-terra" });
    assert.equal(first.args[first.args.indexOf("--model") + 1], "gpt-5.6-sol"); assert.equal(second.args[second.args.indexOf("--model") + 1], "gpt-5.6-terra"); assert.deepEqual(first.definition.model, "gpt-5.6-sol"); assert.deepEqual(second.definition.model, "gpt-5.6-terra"); assert.throws(() => store.prepareLaunch("codex-models", { cwd: "/workspace/repo", prompt: "Rejected", model: "gpt-unknown" }), (error: unknown) => codedAs(error, "invalid_runtime_model") && error.message.includes("gpt-5.6-sol, gpt-5.6-terra"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("Codex effort is a per-launch override and never mutates the instance", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-effort-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 2, instanceId: "codex-effort", name: "Effort", kindId: "codex", installationId: observed.installationId, providerId: "openai", models: ["gpt-5.6-sol"], defaultModel: "gpt-5.6-sol", enabled: true, codex: { reasoningEffort: "medium" }, auth: { mode: "api-key", credentialRef: "credential:v1:codex-effort" } });
    const low = store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Low", effort: "low" }), xhigh = store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Hard", effort: "xhigh" });
    assert.notEqual(low.args.join("\0"), xhigh.args.join("\0")); assert.match(low.args.join(" "), /model_reasoning_effort="low"/u); assert.match(xhigh.args.join(" "), /model_reasoning_effort="xhigh"/u); assert.equal(store.read("codex-effort")?.kindId, "codex"); assert.equal(store.read("codex-effort")?.codex.reasoningEffort, "medium");
    assert.throws(() => store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "turbo" }), (error: unknown) => codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("turbo"));
    assert.throws(() => store.prepareLaunch("codex-effort", { cwd: "/workspace/repo", prompt: "Bad", effort: "" }), (error: unknown) => codedAs(error, "invalid_runtime_effort"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("agy uses the operator environment, OAuth-only auth, and a closed effort enum", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-")), agy = { installationId: "agy-installation-test", kindId: "agy" as const, executablePath: "/opt/runtime-test/agy", version: "1.1.15", observedAt: "2026-08-19T00:00:00.000Z" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, env: { HOME: "/operator/home", PATH: "/bin" }, discover: () => [agy], subscriptionReady: () => ({ status: "ready", code: null, hint: null }) });
    store.create({ schemaVersion: 2, instanceId: "agy-review", name: "AGY Review", kindId: "agy", installationId: agy.installationId, providerId: "google", models: ["gemini-3.1-pro-low"], defaultModel: "gemini-3.1-pro-low", enabled: true, agy: { effort: "low" }, auth: { mode: "subscription" } });
    const launch = store.prepareLaunch("agy-review", { cwd: "/workspace/repo", prompt: "Reply with exactly AGY-OK", effort: "medium", providerSessionId: "conversation-1" });
    assert.deepEqual(launch.args, ["-p", "Reply with exactly AGY-OK", "--output-format", "stream-json", "--model", "gemini-3.1-pro-low", "--effort", "medium", "--conversation", "conversation-1"]);
    assert.equal(launch.env.HOME, "/operator/home"); assert.equal(launch.env.CODEX_HOME, undefined); assert.equal(launch.env.CLAUDE_CONFIG_DIR, undefined);
    assert.throws(() => store.prepareLaunch("agy-review", { cwd: "/workspace/repo", prompt: "reject", effort: "xhigh" }), (error: unknown) => codedAs(error, "invalid_runtime_effort") && error instanceof Error && error.message.includes("low, medium, or high"));
    assert.equal(store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance && (store.command({ kind: "runtime-instance-show", instanceId: "agy-review" }).instance as { isolationState: string }).isolationState, "operator-environment");
    assert.throws(() => store.command({ kind: "runtime-instance-create", instanceId: "agy-api", name: "AGY API", kindId: "agy", installationId: agy.installationId, providerId: "google", model: "gemini", authMode: "api-key", credentialRef: "credential:v1:agy-api" }), (error: unknown) => codedAs(error, "invalid_runtime_auth"));
    assert.throws(() => store.prepareAuthCommand("agy-review", "login"), (error: unknown) => codedAs(error, "runtime_auth_interactive_only"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("agy subscription probes report an unavailable operator environment", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-subscription-probe-")), executablePath = path.join(userRoot, "agy-models.mjs"), agy: RuntimeInstallationWitness = { installationId: "agy-rejected-status", kindId: "agy", executablePath, version: "1.1.15", observedAt: "2026-08-19T00:00:00.000Z" };
  try {
    writeFileSync(executablePath, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o755 });
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [agy] });
    store.create({ schemaVersion: 1, instanceId: "agy-subscription", name: "AGY Subscription", kindId: "agy", installationId: agy.installationId, providerId: "google", model: "gemini-3.1-pro-low", auth: { mode: "subscription" } });
    assert.deepEqual(store.authStatus("agy-subscription"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in the operator environment." });
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("runtime auth readiness is explicit, safe, and never falls back across modes", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-readiness-"));
  try {
    let subscriptionReady = false, credentialCalls = 0, subscriptionCalls = 0;
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: () => { credentialCalls += 1; throw new Error("missing"); }, subscriptionReady: () => { subscriptionCalls += 1; return subscriptionReady ? { status: "ready", code: null, hint: null } : { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." }; } });
    store.create({ schemaVersion: 1, instanceId: "codex-sub", name: "Codex Subscription", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    assert.deepEqual(store.authStatus("codex-sub"), { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." });
    assert.equal(credentialCalls, 0); assert.equal(subscriptionCalls, 1);
    subscriptionReady = true;
    assert.deepEqual(store.authStatus("codex-sub"), { status: "ready", code: null, hint: null });
    assert.equal(credentialCalls, 0); assert.equal(subscriptionCalls, 2);
    store.create({ schemaVersion: 1, instanceId: "codex-api", name: "Codex API", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "keychain:harness/missing" } });
    assert.deepEqual(store.authStatus("codex-api"), { status: "not-ready", code: "runtime_credential_unavailable", hint: "The configured runtime API credential is unavailable." });
    assert.equal(subscriptionCalls, 2);
    const receipt = store.command({ kind: "runtime-instance-show", instanceId: "codex-api", probe: true });
    assert.doesNotMatch(JSON.stringify(receipt), /credentialRef|keychain:|executablePath|\/opt\/runtime-test/u);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription probes distinguish authenticated, unauthenticated, and inconclusive states", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-auth-probe-state-"));
  try {
    let probe: RuntimeAuthReadiness = { status: "not-ready", code: "runtime_subscription_required", hint: "Provider subscription authentication is unavailable in this instance state root." };
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], subscriptionReady: () => probe });
    store.create({ schemaVersion: 1, instanceId: "codex-probe", name: "Codex Probe", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "subscription" } });
    const unchecked = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe" }).instance as Record<string, unknown>; assert.equal(unchecked.authState, "unknown"); assert.equal((unchecked.authReadiness as Record<string, unknown>).code, "runtime_auth_not_checked");
    const unauthenticated = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true }).instance as Record<string, unknown>; assert.equal(unauthenticated.authState, "unauthenticated"); assert.equal((unauthenticated.authReadiness as Record<string, unknown>).code, "runtime_subscription_required");
    probe = { status: "not-ready", code: "runtime_auth_probe_failed", hint: "Provider authentication probe could not determine readiness." };
    const inconclusive = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true }).instance as Record<string, unknown>; assert.equal(inconclusive.authState, "unknown"); assert.equal((inconclusive.authReadiness as Record<string, unknown>).code, "runtime_auth_probe_failed");
    probe = { status: "ready", code: null, hint: null };
    const authenticated = store.command({ kind: "runtime-instance-show", instanceId: "codex-probe", probe: true }).instance as Record<string, unknown>; assert.equal(authenticated.authState, "authenticated");
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("subscription auth commands use the witnessed executable and instance-only state root", () => {
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

test("win32 instances derive USERPROFILE/TEMP/APPDATA isolation without POSIX variables", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-isolation-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], platform: "win32", env: { PATH: "C:\\runtime\\tools", HOME: "C:\\host\\home", TMPDIR: "C:\\host\\tmp", SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", COMSPEC: "C:\\Windows\\system32\\cmd.exe", PATHEXT: ".COM;.EXE;.CMD", OPENAI_API_KEY: "host-secret" }, resolveCredential: () => "instance-secret" });
    store.create({ schemaVersion: 1, instanceId: "codex-win", name: "Codex Windows", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "credential:v1:codex-win" } });
    const launch = store.prepareLaunch("codex-win", { cwd: "/workspace/repo", prompt: "Inspect" }), stateRoot = path.join(userRoot, "runtime-instances", "codex-win");
    assert.deepEqual(launch.env, { PATH: "C:\\runtime\\tools", PATHEXT: ".COM;.EXE;.CMD", SYSTEMROOT: "C:\\Windows", SYSTEMDRIVE: "C:", COMSPEC: "C:\\Windows\\system32\\cmd.exe", USERPROFILE: path.join(stateRoot, "home"), TEMP: path.join(stateRoot, "tmp"), TMP: path.join(stateRoot, "tmp"), APPDATA: path.join(stateRoot, "home", "AppData", "Roaming"), LOCALAPPDATA: path.join(stateRoot, "home", "AppData", "Local"), CODEX_HOME: path.join(stateRoot, "home", ".codex") });
    assert.match(readFileSync(path.join(launch.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "instance-secret"/u);
    assert.equal("HOME" in launch.env, false); assert.equal("TMPDIR" in launch.env, false); assert.equal("XDG_RUNTIME_DIR" in launch.env, false);
    assert.equal(Object.values(launch.env).includes("host-secret"), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("linux instances keep the POSIX isolation shape distinct from the host", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-linux-isolation-"));
  try {
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [{ ...observed, kindId: "claude", installationId: "claude-installation-test", executablePath: "/opt/runtime-test/claude" }], platform: "linux", env: { PATH: "/runtime/tools", HOME: "/host/home", USERPROFILE: "C:\\host\\home", XDG_RUNTIME_DIR: "/host/run/xdg", ANTHROPIC_API_KEY: "host-secret" } });
    store.create({ schemaVersion: 1, instanceId: "claude-linux", name: "Claude Linux", kindId: "claude", installationId: "claude-installation-test", providerId: "anthropic", model: "claude-fable-5", auth: { mode: "subscription" } });
    const command = store.prepareAuthCommand("claude-linux", "login"), stateRoot = path.join(userRoot, "runtime-instances", "claude-linux");
    assert.deepEqual(command.env, { PATH: "/runtime/tools", HOME: path.join(stateRoot, "home"), TMPDIR: path.join(stateRoot, "tmp"), XDG_RUNTIME_DIR: path.join(stateRoot, "run"), CLAUDE_CONFIG_DIR: path.join(stateRoot, "home", ".claude") });
    assert.equal("USERPROFILE" in command.env, false); assert.equal(Object.values(command.env).includes("host-secret"), false);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("two same-binary same-model instances never share state roots or credentials", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-pair-isolation-"));
  try {
    const vault = new Map<string, string>([["credential:v1:codex-a", "secret-a"], ["credential:v1:codex-b", "secret-b"]]), secrets: string[] = [];
    const store = openRuntimeInstanceStore({ userRoot, discover: () => [observed], resolveCredential: (reference) => { if (!vault.has(reference)) throw new Error(`missing ${reference}`); const secret = vault.get(reference)!; secrets.push(secret); return secret; } });
    for (const [suffix, reference] of [["a", "credential:v1:codex-a"], ["b", "credential:v1:codex-b"]] as const) store.create({ schemaVersion: 1, instanceId: `codex-pair-${suffix}`, name: `Codex Pair ${suffix}`, kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: reference } });
    const launchA = store.prepareLaunch("codex-pair-a", { cwd: "/workspace/repo", prompt: "A" }), launchB = store.prepareLaunch("codex-pair-b", { cwd: "/workspace/repo", prompt: "B" }), rootA = path.join(userRoot, "runtime-instances", "codex-pair-a"), rootB = path.join(userRoot, "runtime-instances", "codex-pair-b");
    assert.notEqual(rootA, rootB); assert.notEqual(launchA.env.HOME, launchB.env.HOME); assert.notEqual(launchA.env.TMPDIR, launchB.env.TMPDIR);
    assert.match(readFileSync(path.join(launchA.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "secret-a"/u); assert.match(readFileSync(path.join(launchB.env.CODEX_HOME!, "config.toml"), "utf8"), /experimental_bearer_token = "secret-b"/u);
    assert.equal(Object.values(launchA.env).includes("secret-b"), false); assert.equal(Object.values(launchB.env).includes("secret-a"), false);
    assert.equal(JSON.stringify(launchA).includes("secret-b"), false); assert.equal(JSON.stringify(launchB).includes("secret-a"), false);
    store.create({ schemaVersion: 1, instanceId: "codex-pair-c", name: "Codex Pair C", kindId: "codex", installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key", credentialRef: "credential:v1:not-in-vault" } });
    assert.throws(() => store.prepareLaunch("codex-pair-c", { cwd: "/workspace/repo", prompt: "C" }), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
    assert.equal(secrets.includes("secret-a"), true); assert.equal(secrets.includes("secret-b"), true);
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

test("credential references accept the backend-agnostic grammar and legacy keychain form", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-grammar-")), store = openRuntimeInstanceStore({ userRoot, discover: () => [observed] });
  try {
    const base = { schemaVersion: 1 as const, kindId: "codex" as const, installationId: observed.installationId, providerId: "openai", model: "gpt-5.6-sol", auth: { mode: "api-key" as const, credentialRef: "" } };
    for (const reference of ["credential:v1:codex-review", "credential:v1:openai-main-2", "keychain:harness/codex-review"]) { const config = { ...base, instanceId: "codex-grammar", name: "Codex Grammar", auth: { mode: "api-key" as const, credentialRef: reference } }, created = store.create(config); assert.deepEqual(created.models, ["gpt-5.6-sol"]); assert.equal(created.defaultModel, "gpt-5.6-sol"); assert.equal(created.enabled, true); store.delete("codex-grammar"); }
    for (const reference of ["credential:v1:-leading", "credential:v2:codex", "keychain:a/b/c", "plaintext-secret", "credential:v1:"]) assert.throws(() => store.create({ ...base, instanceId: "codex-grammar", name: "Codex Grammar", auth: { mode: "api-key", credentialRef: reference } }), (error: unknown) => codedAs(error, "invalid_credential_reference"));
  } finally { rmSync(userRoot, { recursive: true, force: true }); }
});

// The PATHEXT suffix enumeration and argv-direct spawn are observable from any
// host (the `.exe`-named probe is a shell script here); routing `.cmd` shims
// through the explicit cmd.exe argv needs a real Windows host and is covered by
// the manual cross-platform regression checklist instead.
test("win32 installation discovery probes PATHEXT suffixes and witnesses the shim", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-runtime-win32-discovery-")), bin = path.join(root, "bin");
  try {
    mkdirSync(bin);
    writeFileSync(path.join(bin, "codex.exe"), "#!/bin/sh\necho stub-runtime-1.0.0\n", { mode: 0o755 });
    const installations = discoverRuntimeInstallations({ env: { PATH: bin }, platform: "win32", now: () => "2026-08-15T01:00:00.000Z" });
    assert.equal(installations.length, 1);
    assert.deepEqual({ kindId: installations[0]!.kindId, version: installations[0]!.version, observedAt: installations[0]!.observedAt }, { kindId: "codex", version: "stub-runtime-1.0.0", observedAt: "2026-08-15T01:00:00.000Z" });
    assert.equal(installations[0]!.executablePath.endsWith("codex.exe"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
