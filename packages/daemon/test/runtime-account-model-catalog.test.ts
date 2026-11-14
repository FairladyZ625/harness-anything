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
