// harness-test-tier: contract
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
