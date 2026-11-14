// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createRuntimeInstanceAccountProbe } from "../src/runtime-instance-account-probe.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { runtimeKindForId } from "../src/runtime-inventory.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const providers = ["claude", "codex", "claude-acp", "codex-acp", "devin", "opencode", "minimax-code"] as const;
// Help/bundled catalogs are deliberately identical. Only each isolated account's
// authenticated session can report these distinct models. No prompt may be sent.
const provider = `
  const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
  const home = process.env.HOME, models = JSON.parse(fs.readFileSync(path.join(home, "catalog.json"))), args = process.argv.slice(2);
  if (args[0] === "--help") { console.log('Use a model alias (e.g. "sonnet" or "opus")'); process.exit(0); }
  if (args[0] === "debug") { console.log(JSON.stringify({models:[{slug:"bundled-only"}]})); process.exit(0); }
  if (args[0] === "models") { console.log(JSON.stringify({families:models.map(slug=>({slug}))})); process.exit(0); }
  if (args[0] === "auth" || args[0] === "login" || args[0] === "--version") process.exit(0);
  readline.createInterface({input:process.stdin}).on("line", line => {
    const m = JSON.parse(line), reply = result => console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
    fs.appendFileSync(path.join(home,"requests.jsonl"),JSON.stringify(m)+"\\n");
    if (m.type === "control_request") return console.log(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:m.request_id,response:{models:models.map(value=>({value}))}}}));
    if (m.method === "initialized") return;
    if (m.method === "initialize") return reply({authMethods:[]});
    if (m.method === "model/list") {
      if (m.params.includeHidden !== false) process.exit(91);
      if (m.params.cursor === null) return reply({data:[{model:models[0]}, {model:"hidden-only", hidden:true}],nextCursor:"last"});
      if (m.params.cursor === "last") return reply({data:[{model:models[1],isDefault:true}],nextCursor:null});
      process.exit(92);
    }
    if (m.method === "session/new") return reply({sessionId:"account-session",configOptions:[{id:"model",category:"model",currentValue:models[1],options:[{group:"account",options:models.map(value=>({value,name:value}))}]}]});
    process.exit(93);
  });
`;

for (const kindId of providers)
  test(`${kindId} account catalog follows two isolated homes rather than installation metadata`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-account-catalog-"));
    try {
      const executablePath = writeProviderExecutable(path.join(root, "provider"), provider),
        probe = createRuntimeInstanceAccountProbe(process.platform);
      for (const name of ["pro", "ultra"]) {
        const home = path.join(root, name),
          models = [`${name}-one`, `${name}-two`];
        mkdirSync(home);
        writeFileSync(path.join(home, "catalog.json"), JSON.stringify(models));
        const result = await probe.probeModels({ kindId, executablePath, env: { HOME: home, USERPROFILE: home } });
        assert.deepEqual(result?.models, models);
        if (kindId === "codex") {
          assert.equal(result?.defaultModel, models[1]);
          const requests = readFileSync(path.join(home, "requests.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.deepEqual(
            requests.filter((m) => m.method === "model/list").map((m) => m.params.cursor),
            [null, "last"],
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const failure of ["nonzero", "timeout"] as const)
  test(`successful Claude authentication survives a ${failure} account model refresh`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-model-auth-separation-"));
    try {
      const executablePath = writeProviderExecutable(
          path.join(root, "claude"),
          `
        const args=process.argv.slice(2);
        if (args[0] === "auth") process.exit(0);
        if (${JSON.stringify(failure)} === "nonzero") process.exit(29);
        setInterval(()=>{},1000);
      `,
        ),
        installation: RuntimeInstallationWitness = {
          kindId: "claude",
          installationId: "claude",
          executablePath,
          version: "9999.1.0",
          observedAt: "2026-11-14T00:00:00Z",
        },
        store = openRuntimeInstanceStore({
          userRoot: root,
          platform: "darwin",
          env: {},
          discover: () => [installation],
        });
      store.command({
        kind: "runtime-instance-create",
        instanceId: "account",
        name: "Account",
        kindId: "claude",
        installationId: "claude",
        providerId: "anthropic",
        models: ["configured-model"],
        authMode: "subscription",
        credentialSource: "instance",
      });
      const result =
        failure === "nonzero"
          ? await store.command({ kind: "runtime-instance-show", instanceId: "account", probe: true })
          : await store.refreshAccount("account", undefined, AbortSignal.timeout(100));
      assert.equal(store.listPublic()[0]?.authReadiness.status, "ready");
      assert.equal((result.modelCatalogReadiness as { code: string }).code, "runtime_model_catalog_probe_failed");
      assert.equal(store.read("account")?.availableModels, undefined);
      assert.deepEqual(store.read("account")?.models, ["configured-model"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("list --probe persists each provider account catalog independently of its configured models", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-catalog-persistence-"));
  try {
    const executablePath = writeProviderExecutable(path.join(root, "provider"), provider),
      installations: RuntimeInstallationWitness[] = providers.map((kindId) => ({
        kindId,
        installationId: kindId,
        executablePath,
        version: "9999.1.0",
        observedAt: "2026-11-14T00:00:00Z",
      })),
      store = openRuntimeInstanceStore({
        userRoot: root,
        platform: "darwin",
        env: {},
        discover: () => installations,
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
    for (const kindId of providers)
      for (const name of ["pro", "ultra"]) {
        const instanceId = `${kindId}-${name}`;
        store.command({
          kind: "runtime-instance-create",
          instanceId,
          name: instanceId,
          kindId,
          installationId: kindId,
          providerId: runtimeKindForId(kindId).defaultProviderId,
          models: ["configured-model"],
          authMode: "subscription",
          credentialSource: "instance",
        });
        writeFileSync(
          path.join(root, "runtime-instances", instanceId, "home", "catalog.json"),
          JSON.stringify([`${name}-one`, `${name}-two`]),
        );
      }
    const result = await store.command({ kind: "runtime-instance-list", all: true, probe: true });
    for (const kindId of providers)
      for (const name of ["pro", "ultra"]) {
        const instanceId = `${kindId}-${name}`;
        assert.deepEqual(store.read(instanceId)?.availableModels, [`${name}-one`, `${name}-two`]);
        assert.deepEqual(store.read(instanceId)?.models, ["configured-model"]);
        assert.equal((result.modelCatalogReadiness as Record<string, { status: string }>)[instanceId]?.status, "ready");
      }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex catalog rejects a repeated continuation cursor rather than looping", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-catalog-cursor-"));
  try {
    const executablePath = writeProviderExecutable(
      path.join(root, "codex"),
      `
      require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
        const m=JSON.parse(line);
        if(m.method==="initialized") return;
        const result=m.method==="initialize"?{}:{data:[{model:"account-model"}],nextCursor:"repeated"};
        console.log(JSON.stringify({id:m.id,result}));
      });
    `,
    );
    await assert.rejects(
      createRuntimeInstanceAccountProbe(process.platform).probeModels({
        kindId: "codex",
        executablePath,
        env: { HOME: root },
        signal: AbortSignal.timeout(2000),
      }),
      (error) => error instanceof Error && "code" in error && error.code === "runtime_model_catalog_invalid",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undeclared account catalog is explicitly unsupported after successful authentication", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-unsupported-catalog-"));
  try {
    assert.equal(runtimeKindForId("cursor").auth.accountModelProbe, undefined);
    const installation: RuntimeInstallationWitness = {
        kindId: "cursor",
        installationId: "cursor",
        executablePath: "/test/cursor",
        version: "9999.1.0",
        observedAt: "2026-11-14T00:00:00Z",
      },
      store = openRuntimeInstanceStore({
        userRoot: root,
        platform: "darwin",
        discover: () => [installation],
        subscriptionReady: () => ({ status: "ready", code: null, hint: null }),
      });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "account",
      name: "Account",
      kindId: "cursor",
      installationId: "cursor",
      providerId: "cursor",
      models: ["configured-model"],
      authMode: "subscription",
    });
    const result = await store.command({ kind: "runtime-instance-show", instanceId: "account", probe: true });
    assert.equal(store.listPublic()[0]?.authReadiness.status, "ready");
    assert.equal((result.modelCatalogReadiness as { code: string }).code, "runtime_model_catalog_unsupported");
    assert.equal(store.read("account")?.availableModels, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// F3: stored credentials are metadata; ACP authentication refusals outrank that metadata.
for (const scenario of [
  { name: "empty HOME", credentials: undefined, authCode: "runtime_subscription_required" },
  { name: "empty credential map", credentials: {}, authCode: "runtime_subscription_required" },
  {
    name: "empty API credential",
    credentials: { openai: { type: "api", key: "" } },
    authCode: "runtime_subscription_required",
  },
  {
    name: "refreshable OAuth credential",
    credentials: { openai: { type: "oauth", refresh: "test-refresh", access: "expired-test-access", expires: 0 } },
    authCode: null,
  },
  {
    name: "wellknown credential",
    credentials: { openai: { type: "wellknown", key: "test-key", token: "test-token" } },
    authCode: null,
  },
  { name: "malformed credential file", credentials: "invalid-json", authCode: "runtime_auth_probe_failed" },
  {
    name: "authenticate refuses login",
    method: "authenticate",
    code: -32000,
    authCode: "runtime_subscription_required",
  },
  { name: "session refuses login", method: "session/new", code: -32000, authCode: "runtime_subscription_required" },
  { name: "initialization unavailable", method: "initialize", code: -32603, authCode: "runtime_auth_probe_failed" },
  { name: "authentication unavailable", method: "authenticate", code: -32603, authCode: "runtime_auth_probe_failed" },
  { name: "authentication times out", method: "authenticate", timeout: true, authCode: "runtime_auth_probe_failed" },
  { name: "model catalog fails after authentication", method: "session/new", code: -32603, authCode: null },
  { name: "authenticated account catalog", authCode: null },
] as const)
  test(`OpenCode ${scenario.name} is reported independently of executable availability`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-opencode-auth-evidence-"));
    try {
      const executablePath = writeProviderExecutable(
          path.join(root, "opencode"),
          `
        const fs=require("node:fs"), path=require("node:path");
        const scenario=${JSON.stringify(scenario)};
        if (process.argv[2] === "--version") {console.log("9999.1.0"); process.exit(0);}
        require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
          const m=JSON.parse(line);
          if(m.method===scenario.method) {
            if(scenario.timeout) return;
            console.log(JSON.stringify({id:m.id,error:{code:scenario.code,message:scenario.code===-32000?"Authentication required":"temporary service failure"}}));
            return;
          }
          const result=m.method==="initialize"?{authMethods:[{id:"opencode-login"}]}:m.method==="authenticate"?{}:{sessionId:"signed-in",models:{availableModels:[{modelId:"openai/account-model"}]}};
          console.log(JSON.stringify({id:m.id,result}));
        });
      `,
        ),
        installation: RuntimeInstallationWitness = {
          kindId: "opencode",
          installationId: "opencode",
          executablePath,
          version: "9999.1.0",
          observedAt: "2026-11-14T00:00:00Z",
        },
        store = openRuntimeInstanceStore({
          userRoot: root,
          platform: "darwin",
          env: {},
          discover: () => [installation],
        });
      store.command({
        kind: "runtime-instance-create",
        instanceId: "account",
        name: "Account",
        kindId: "opencode",
        installationId: "opencode",
        providerId: "opencode",
        models: ["openai/account-model"],
        authMode: "subscription",
        credentialSource: "instance",
      });
      const file = path.join(root, "runtime-instances", "account", "home", ".local/share/opencode/auth.json"),
        credentials =
          "credentials" in scenario ? scenario.credentials : { openai: { type: "api", key: "test-f3-key" } };
      if (credentials !== undefined) {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, typeof credentials === "string" ? credentials : JSON.stringify(credentials));
      }
      const result =
        "timeout" in scenario
          ? await store.refreshAccount("account", undefined, AbortSignal.timeout(150))
          : await store.command({ kind: "runtime-instance-show", instanceId: "account", probe: true });
      const readiness = store.listPublic()[0]!.authReadiness;
      assert.equal(readiness.code, scenario.authCode);
      assert.equal(readiness.status, scenario.authCode === null ? "ready" : "not-ready");
      const models = result.modelCatalogReadiness as { code: string | null };
      if (scenario.authCode !== null) {
        assert.equal(models.code, "runtime_model_catalog_not_probed");
        assert.equal(store.read("account")?.availableModels, undefined);
      } else if ("code" in scenario) {
        assert.equal(models.code, "runtime_model_catalog_probe_failed");
        assert.equal(readiness.basis, "metadata");
      } else {
        assert.equal(models.code, null);
        assert.deepEqual(store.read("account")?.availableModels, ["openai/account-model"]);
      }
      assert.deepEqual(store.read("account")?.models, ["openai/account-model"]);
      if (!("timeout" in scenario)) {
        assert.equal(
          (await store.authStatus("account")).code,
          scenario.authCode,
          "plain auth status uses the same authority",
        );
        if (scenario.authCode !== null)
          await assert.rejects(
            store.prepareLaunch("account", { cwd: root, prompt: "must not launch" }),
            (error) => error instanceof Error && "code" in error && error.code === scenario.authCode,
          );
      }
      if (scenario.name === "empty HOME") {
        const list = await store.command({ kind: "runtime-instance-list", all: true, probe: true });
        assert.equal(
          (list.instances as { authReadiness: { code: string } }[])[0]?.authReadiness.code,
          "runtime_subscription_required",
        );
        await assert.rejects(
          store.prepareLaunch("account", { cwd: root, prompt: "must not launch" }),
          (error) => error instanceof Error && "code" in error && error.code === "runtime_subscription_required",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const kindId of ["claude-acp", "codex-acp"] as const)
  test(`${kindId} ACP auth_required overrides successful native login metadata`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-acp-auth-authority-"));
    try {
      const executablePath = writeProviderExecutable(
          path.join(root, "provider"),
          `
        if(["auth","login"].includes(process.argv[2])) process.exit(0);
        require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
          const m=JSON.parse(line);
          console.log(JSON.stringify(m.method==="initialize"?{id:m.id,result:{authMethods:[{id:${JSON.stringify(kindId === "codex-acp" ? "chat-gpt" : "native")}}]}}:{id:m.id,error:{code:-32000,message:"Authentication required"}}));
        });
      `,
        ),
        nativeKind = kindId === "codex-acp" ? "codex" : "claude",
        installations: RuntimeInstallationWitness[] = [kindId, nativeKind].map((kind) => ({
          kindId: kind as RuntimeInstallationWitness["kindId"],
          installationId: kind,
          executablePath,
          version: "9999.1.0",
          observedAt: "2026-11-14T00:00:00Z",
        })),
        store = openRuntimeInstanceStore({
          userRoot: root,
          platform: "darwin",
          env: {},
          discover: () => installations,
        });
      store.command({
        kind: "runtime-instance-create",
        instanceId: "account",
        name: "Account",
        kindId,
        installationId: kindId,
        providerId: runtimeKindForId(kindId).defaultProviderId,
        models: ["configured-model"],
        authMode: "subscription",
        credentialSource: "instance",
      });
      assert.equal((await store.authStatus("account")).code, "runtime_subscription_required");
      await assert.rejects(
        store.prepareLaunch("account", { cwd: root, prompt: "must not launch" }),
        (error) => error instanceof Error && "code" in error && error.code === "runtime_subscription_required",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

for (const credentialEnvironment of ["OPENCODE_AUTH_CONTENT", "XDG_DATA_HOME"] as const)
  for (const credentialSource of ["operator", "instance"] as const)
    test(`OpenCode ${credentialSource} credentials respect ${credentialEnvironment}`, async () => {
      const root = mkdtempSync(path.join(tmpdir(), "ha-opencode-auth-env-"));
      try {
        const operatorHome = path.join(root, "operator");
        mkdirSync(operatorHome);
        const dataHome = path.join(root, "data");
        mkdirSync(path.join(dataHome, "opencode"), { recursive: true });
        writeFileSync(
          path.join(dataHome, "opencode", "auth.json"),
          JSON.stringify({ openai: { type: "api", key: "test-operator-key" } }),
        );
        const executablePath = writeProviderExecutable(
            path.join(root, "opencode"),
            `
        require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
          const m=JSON.parse(line);
          console.log(JSON.stringify({id:m.id,result:m.method==="initialize"?{authMethods:[{id:"opencode-login"}]}:m.method==="authenticate"?{}:{sessionId:"operator",models:{availableModels:[{modelId:"account-model"}]}}}));
        });
      `,
          ),
          installation: RuntimeInstallationWitness = {
            kindId: "opencode",
            installationId: "opencode",
            executablePath,
            version: "9999.1.0",
            observedAt: "2026-11-14T00:00:00Z",
          },
          store = openRuntimeInstanceStore({
            userRoot: root,
            platform: "darwin",
            env: {
              HOME: operatorHome,
              [credentialEnvironment]:
                credentialEnvironment === "OPENCODE_AUTH_CONTENT"
                  ? JSON.stringify({ openai: { type: "api", key: "test-operator-key" } })
                  : dataHome,
            },
            discover: () => [installation],
          });
        store.command({
          kind: "runtime-instance-create",
          instanceId: "account",
          name: "Account",
          kindId: "opencode",
          installationId: "opencode",
          providerId: "opencode",
          models: ["account-model"],
          authMode: "subscription",
          credentialSource,
        });
        assert.equal(
          (await store.authStatus("account")).status,
          credentialSource === "operator" ? "ready" : "not-ready",
        );
        assert.deepEqual(
          store.read("account")?.availableModels,
          credentialSource === "operator" ? ["account-model"] : undefined,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
