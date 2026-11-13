// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { runtimeInstanceConfig } from "../src/agent-runtime-instance-config.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { openDaemonRuntimePorts } from "../src/daemon-runtime-ports.ts";
import { codedAs } from "./agent-runtime-instance-environment.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const agyInstallation: RuntimeInstallationWitness = {
  installationId: "agy-installation",
  kindId: "agy",
  executablePath: "/opt/runtime-test/agy",
  version: "1.1.15",
  observedAt: "2026-11-13T00:00:00.000Z",
};

test("subscription credential sources default to operator and isolate instance credentials", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-credential-source-")),
    operatorHome = path.join(userRoot, "operator-home"),
    sharedGemini = path.join(operatorHome, ".gemini"),
    operatorCredential = path.join(sharedGemini, "antigravity-oauth-token");
  mkdirSync(sharedGemini, { recursive: true, mode: 0o700 });
  writeFileSync(operatorCredential, "test-operator-credential", { mode: 0o600 });
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: process.env.PATH, HOME: operatorHome },
      discover: () => [agyInstallation],
    });
    const operator = store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-operator",
      name: "AGY operator",
      kindId: "agy",
      installationId: agyInstallation.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
    }).instance as Record<string, unknown>;
    assert.equal(operator.credentialSource, "operator");

    assert.throws(
      () =>
        store.command({
          kind: "runtime-instance-create",
          instanceId: "agy-operator-two",
          name: "AGY operator two",
          kindId: "agy",
          installationId: agyInstallation.installationId,
          providerId: "google",
          models: ["gemini-4-hydrogen-low"],
          authMode: "subscription",
        }),
      (error: unknown) => codedAs(error, "runtime_operator_instance_exists"),
    );

    const isolated = store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-pro",
      name: "AGY Pro",
      kindId: "agy",
      installationId: agyInstallation.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
      credentialSource: "instance",
    }).instance as Record<string, unknown>;
    assert.equal(isolated.credentialSource, "instance");
    assert.equal(isolated.isolationState, "enforced");
    const instanceCredential = path.join(
      userRoot,
      "runtime-instances",
      "agy-pro",
      "home",
      ".gemini",
      "antigravity-oauth-token",
    );
    assert.throws(() => lstatSync(instanceCredential), { code: "ENOENT" });
    assert.equal(readFileSync(operatorCredential, "utf8"), "test-operator-credential");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("switching an enforced operator account to instance credentials detaches shared state and clears account observations", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-account-transition-")),
    operatorHome = path.join(userRoot, "operator-home"),
    sharedGemini = path.join(operatorHome, ".gemini"),
    operatorCredential = path.join(sharedGemini, "antigravity-oauth-token"),
    bin = path.join(userRoot, "bin"),
    agyPath = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy"),
    agy = { ...agyInstallation, executablePath: agyPath };
  mkdirSync(sharedGemini, { recursive: true, mode: 0o700 });
  mkdirSync(bin, { recursive: true });
  writeFileSync(operatorCredential, "operator-account", { mode: 0o600 });
  writeProviderExecutable(
    path.join(bin, "agy"),
    `const args = process.argv.slice(2); if (args[0] === "models") console.log("gemini-4-hydrogen-low\\tmodel"); else if (args[0] === "-p") console.log(JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 1, reset_time: "2026-11-15T12:00:00.000Z" }] }] } } }));`,
  );
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: operatorHome },
      discover: () => [agy],
    });
    store.create({
      schemaVersion: 2,
      instanceId: "agy-transition",
      name: "AGY transition",
      kindId: "agy",
      installationId: agy.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      defaultModel: "gemini-4-hydrogen-low",
      enabled: true,
      isolationState: "enforced",
      credentialSource: "operator",
      auth: { mode: "subscription" },
      agy: {},
    });
    const sharedLink = path.join(
      userRoot,
      "runtime-instances",
      "agy-transition",
      "home",
      ".gemini",
      "antigravity-oauth-token",
    );
    assert.equal(lstatSync(sharedLink).isSymbolicLink(), true);
    assert.equal((await store.authStatus("agy-transition")).status, "ready");
    assert.equal(store.list().find(({ instanceId }) => instanceId === "agy-transition")?.availableModels?.length, 1);
    store.runtimeProviderHealth.recordFailure({
      instanceId: "agy-transition",
      reason: "fixture",
      occurredAt: "2026-11-14T00:00:00.000Z",
      resetAt: "2026-11-15T12:00:00.000Z",
    });

    store.command({
      kind: "runtime-instance-update",
      instanceId: "agy-transition",
      credentialSource: "instance",
    });
    assert.equal(existsSync(sharedLink), false);
    assert.equal(readFileSync(operatorCredential, "utf8"), "operator-account");
    const transitioned = store.list().find(({ instanceId }) => instanceId === "agy-transition")!;
    assert.equal(transitioned.availableModels, undefined);
    assert.equal(transitioned.credentialSource, "instance");
    assert.equal(store.runtimeProviderHealth.get("agy-transition").failureStreak, 0);
    assert.equal(store.listPublic()[0]?.authReadiness.code, "runtime_auth_not_checked");
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("account login for a direct provider uses the instance-bound installation", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-bound-account-installation-")),
    first = {
      ...agyInstallation,
      kindId: "codex" as const,
      installationId: "codex-first",
      executablePath: "/opt/codex-first",
    },
    second = { ...first, installationId: "codex-second", executablePath: "/opt/codex-second" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, platform: "darwin", discover: () => [first, second] });
    store.create({
      schemaVersion: 2,
      instanceId: "codex-bound",
      name: "Codex bound",
      kindId: "codex",
      installationId: second.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      defaultModel: "gpt-5.6-sol",
      enabled: true,
      isolationState: "operator-environment",
      credentialSource: "operator",
      auth: { mode: "subscription" },
      codex: {},
    });
    assert.equal(store.prepareAuthCommand("codex-bound", "login").executablePath, second.executablePath);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("ACP credential-command account login fails closed when its CLI witness is ambiguous", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-acp-account-ambiguity-")),
    acp = {
      ...agyInstallation,
      kindId: "agy-acp" as const,
      installationId: "agy-acp-installation",
      executablePath: "/opt/agy-acp",
    },
    agyOne = { ...agyInstallation, installationId: "agy-one", executablePath: "/opt/agy-one" },
    agyTwo = { ...agyInstallation, installationId: "agy-two", executablePath: "/opt/agy-two" };
  try {
    const store = openRuntimeInstanceStore({ userRoot, platform: "darwin", discover: () => [acp, agyOne, agyTwo] });
    store.create({
      schemaVersion: 2,
      instanceId: "agy-acp-ambiguous",
      name: "AGY ACP ambiguous",
      kindId: "agy-acp",
      installationId: acp.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      defaultModel: "gemini-4-hydrogen-low",
      enabled: true,
      isolationState: "enforced",
      credentialSource: "instance",
      auth: { mode: "subscription" },
      "agy-acp": {},
    });
    assert.throws(
      () => store.prepareAuthCommand("agy-acp-ambiguous", "login"),
      (error: unknown) => codedAs(error, "runtime_installation_ambiguous"),
    );
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("a delayed AGY quota result cannot update health after the account cut changes", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-stale-quota-")),
    bin = path.join(userRoot, "bin"),
    quotaStarted = path.join(userRoot, "quota-started"),
    quotaRelease = path.join(userRoot, "quota-release"),
    agyPath = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy"),
    agy = { ...agyInstallation, executablePath: agyPath };
  mkdirSync(bin, { recursive: true });
  writeProviderExecutable(
    path.join(bin, "agy"),
    `const fs = require("node:fs"); const args = process.argv.slice(2); if (args[0] === "models") console.log("gemini-4-hydrogen-low\\tmodel"); else if (args[0] === "-p") { fs.writeFileSync(${JSON.stringify(quotaStarted)}, "started"); while (!fs.existsSync(${JSON.stringify(quotaRelease)})) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } console.log(JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: 0, reset_time: "2026-11-15T12:00:00.000Z" }] }] } } })); }`,
  );
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      platform: "darwin",
      env: { PATH: bin, HOME: path.join(userRoot, "operator-home") },
      discover: () => [agy],
    });
    store.create({
      schemaVersion: 2,
      instanceId: "agy-stale-quota",
      name: "AGY stale quota",
      kindId: "agy",
      installationId: agy.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      defaultModel: "gemini-4-hydrogen-low",
      enabled: true,
      isolationState: "enforced",
      credentialSource: "instance",
      auth: { mode: "subscription" },
      agy: {},
    });
    const probing = store.authStatus("agy-stale-quota");
    for (let attempt = 0; attempt < 100 && !existsSync(quotaStarted); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(existsSync(quotaStarted), true);
    store.command({ kind: "runtime-instance-update", instanceId: "agy-stale-quota", credentialSource: "operator" });
    writeFileSync(quotaRelease, "release");
    await assert.rejects(probing, (error: unknown) => codedAs(error, "runtime_instance_probe_stale"));
    const health = store.runtimeProviderHealth.get("agy-stale-quota");
    assert.equal(health.failureStreak, 0);
    assert.equal(store.listPublic()[0]?.authReadiness.code, "runtime_auth_not_checked");
  } finally {
    writeFileSync(quotaRelease, "release");
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("cold reads reject duplicate legacy operator subscriptions while valid disabled and instance rows remain readable", () => {
  const duplicateRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-legacy-operator-duplicate-")),
    validRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-legacy-operator-valid-"));
  const legacy = (instanceId: string, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    instanceId,
    name: instanceId,
    kindId: "codex",
    installationId: "codex-legacy",
    providerId: "openai",
    model: "gpt-5.6-sol",
    auth: { mode: "subscription" },
    ...overrides,
  });
  try {
    writeFileSync(
      path.join(duplicateRoot, "runtime-instances.json"),
      JSON.stringify({ schema: "runtime-instances/v1", instances: [legacy("legacy-one"), legacy("legacy-two")] }),
    );
    const duplicate = openRuntimeInstanceStore({
      userRoot: duplicateRoot,
      discover: () => [{ ...agyInstallation, kindId: "codex", installationId: "codex-legacy" }],
    });
    assert.throws(
      () => duplicate.list(),
      (error: unknown) => codedAs(error, "runtime_operator_instance_exists"),
    );

    writeFileSync(
      path.join(validRoot, "runtime-instances.json"),
      JSON.stringify({
        schema: "runtime-instances/v1",
        instances: [
          {
            schemaVersion: 2,
            instanceId: "legacy-disabled",
            name: "legacy-disabled",
            kindId: "agy",
            installationId: agyInstallation.installationId,
            installationIdentity: "path-entry/v1",
            providerId: "google",
            models: ["gemini-4-hydrogen-low"],
            defaultModel: "gemini-4-hydrogen-low",
            enabled: false,
            credentialSource: "operator",
            permissionMode: "bypass",
            isolationState: "operator-environment",
            auth: { mode: "subscription" },
            agy: {},
          },
          {
            schemaVersion: 2,
            instanceId: "legacy-instance",
            name: "legacy-instance",
            kindId: "agy",
            installationId: agyInstallation.installationId,
            installationIdentity: "path-entry/v1",
            providerId: "google",
            models: ["gemini-4-hydrogen-low"],
            defaultModel: "gemini-4-hydrogen-low",
            enabled: true,
            credentialSource: "instance",
            permissionMode: "bypass",
            isolationState: "enforced",
            auth: { mode: "subscription" },
            agy: {},
          },
        ],
      }),
    );
    const valid = openRuntimeInstanceStore({
      userRoot: validRoot,
      platform: "darwin",
      discover: () => [agyInstallation],
    });
    assert.equal(valid.list().length, 2);
  } finally {
    rmSync(duplicateRoot, { recursive: true, force: true });
    rmSync(validRoot, { recursive: true, force: true });
  }
});

test("AGY account probes persist separate model catalogs and quota cooldowns per instance", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-agy-accounts-")),
    bin = path.join(userRoot, "bin"),
    trace = path.join(userRoot, "probe-trace.jsonl"),
    agyPath = path.join(bin, process.platform === "win32" ? "agy.cmd" : "agy"),
    agy: RuntimeInstallationWitness = {
      ...agyInstallation,
      executablePath: agyPath,
    },
    agyAcp: RuntimeInstallationWitness = {
      installationId: "agy-acp-installation",
      kindId: "agy-acp",
      executablePath: "/opt/runtime-test/agy_acp_server",
      version: "1.1.15",
      observedAt: agyInstallation.observedAt,
    },
    resetAt = new Date(Date.UTC(2026, 10, 15, 12)).toISOString();
  mkdirSync(bin, { recursive: true });
  writeFileSync(trace, "");
  writeProviderExecutable(
    path.join(bin, "agy"),
    `const fs = require("node:fs"); const args = process.argv.slice(2); const home = process.env.HOME ?? ""; const ultra = home.includes("agy-ultra"); const geminiDir = args[args.indexOf("--gemini-dir") + 1]; const appDataDir = args[args.indexOf("--app-data-dir") + 1]; if (geminiDir !== home + "/.gemini" || appDataDir !== geminiDir + "/antigravity-cli") process.exit(31); fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ home, args }) + "\\n"); if (args[0] === "models") { const prefix = ultra ? "carbon" : "hydrogen"; const count = ultra ? 22 : 18; console.log(Array.from({ length: count }, (_, i) => (i === 0 ? "gemini-4-" + prefix + "-low" : "gemini-4-" + prefix + "-fixture-" + i) + "\\tmodel").join("\\n")); } else if (args[0] === "-p" && args[1] === "/quota") { console.log(JSON.stringify({ command: { data: { groups: [{ buckets: [{ remaining_fraction: ultra ? 0 : 0.35, reset_time: ${JSON.stringify(resetAt)} }] }] } } })); } else if (args[0] !== "acp") process.exit(32);\n`,
  );
  try {
    const store = openRuntimeInstanceStore({
        userRoot,
        platform: "darwin",
        env: { PATH: bin, HOME: path.join(userRoot, "operator-home"), PROBE_TRACE: trace },
        discover: () => [agy, agyAcp],
        now: () => "2026-11-14T00:00:00.000Z",
      }),
      ports = openDaemonRuntimePorts({ instances: store });
    for (const [instanceId, model] of [
      ["agy-ultra", "gemini-4-carbon-low"],
      ["agy-pro", "gemini-4-hydrogen-low"],
    ] as const)
      store.command({
        kind: "runtime-instance-create",
        instanceId,
        name: instanceId,
        kindId: "agy",
        installationId: agy.installationId,
        providerId: "google",
        models: [model],
        authMode: "subscription",
        credentialSource: "instance",
      });

    const [ultraStatus, proStatus] = await Promise.all([store.authStatus("agy-ultra"), store.authStatus("agy-pro")]);
    assert.equal(ultraStatus.status, "ready");
    assert.equal(proStatus.status, "ready");
    const instances = store.listPublic(),
      ultra = instances.find(({ instanceId }) => instanceId === "agy-ultra")!,
      pro = instances.find(({ instanceId }) => instanceId === "agy-pro")!;
    assert.equal(ultra.models[0], "gemini-4-carbon-low");
    assert.equal(pro.models[0], "gemini-4-hydrogen-low");
    assert.equal(ultra.availableModels?.length, 22);
    assert.equal(pro.availableModels?.length, 18);
    assert.ok(ultra.availableModels?.every((model) => model.includes("carbon")));
    assert.ok(pro.availableModels?.every((model) => model.includes("hydrogen")));
    assert.equal(store.runtimeProviderHealth, ports.runtimeProviderHealth);
    assert.equal(ports.runtimeProviderHealth.get("agy-ultra").cooldownUntil, resetAt);
    assert.equal(ports.runtimeProviderHealth.get("agy-ultra").reason, "quota_exhausted");
    assert.equal(ports.runtimeProviderHealth.get("agy-pro").cooldownUntil, null);

    store.command({
      kind: "runtime-instance-create",
      instanceId: "agy-acp-pro",
      name: "AGY ACP Pro",
      kindId: "agy-acp",
      installationId: agyAcp.installationId,
      providerId: "google",
      models: ["gemini-4-hydrogen-low"],
      authMode: "subscription",
      credentialSource: "instance",
    });
    const login = store.prepareAuthCommand("agy-acp-pro", "login");
    assert.equal(login.executablePath, agy.executablePath);
    assert.deepEqual(login.args, [
      "acp",
      "--login",
      "--gemini-dir",
      path.join(userRoot, "runtime-instances", "agy-acp-pro", "home", ".gemini"),
      "--app-data-dir",
      path.join(userRoot, "runtime-instances", "agy-acp-pro", "home", ".gemini", "antigravity-cli"),
    ]);
    assert.equal(login.env.HOME, path.join(userRoot, "runtime-instances", "agy-acp-pro", "home"));
    assert.throws(
      () => store.prepareAuthCommand("agy-acp-pro", "logout"),
      (error: unknown) => codedAs(error, "runtime_auth_unsupported"),
    );
    const traceRows = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { readonly home: string; readonly args: readonly string[] });
    assert.equal(traceRows.length, 4);
    assert.ok(traceRows.every(({ home, args }) => args.includes("--gemini-dir") && home.includes("runtime-instances")));
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("legacy subscription configs normalize to operator credentials", () => {
  const normalized = runtimeInstanceConfig({
    schemaVersion: 2,
    instanceId: "agy-legacy",
    name: "AGY legacy",
    kindId: "agy",
    installationId: agyInstallation.installationId,
    providerId: "google",
    models: ["gemini-4-hydrogen-low"],
    defaultModel: "gemini-4-hydrogen-low",
    enabled: true,
    isolationState: "operator-environment",
    auth: { mode: "subscription" },
    agy: {},
  });
  assert.equal(normalized.credentialSource, "operator");
});

test("instance credentials fail closed for undeclared kind and platform pairs", () => {
  assert.throws(
    () =>
      runtimeInstanceConfig(
        {
          schemaVersion: 2,
          instanceId: "claude-private",
          name: "Claude private",
          kindId: "claude",
          installationId: "claude-installation",
          providerId: "anthropic",
          models: ["claude-fable-5"],
          defaultModel: "claude-fable-5",
          enabled: true,
          credentialSource: "instance",
          auth: { mode: "subscription" },
          claude: {},
        },
        "aix",
      ),
    (error: unknown) => codedAs(error, "runtime_instance_isolation_unsupported"),
  );

  assert.throws(
    () =>
      runtimeInstanceConfig(
        {
          schemaVersion: 2,
          instanceId: "agy-private-aix",
          name: "AGY private",
          kindId: "agy",
          installationId: agyInstallation.installationId,
          providerId: "google",
          models: ["gemini-4-hydrogen-low"],
          defaultModel: "gemini-4-hydrogen-low",
          enabled: true,
          credentialSource: "instance",
          auth: { mode: "subscription" },
          agy: {},
        },
        "aix",
      ),
    (error: unknown) => codedAs(error, "runtime_instance_isolation_unsupported"),
  );
});
