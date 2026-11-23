// harness-test-tier: contract
// dec_DA1602487428A58E8B446ECE38/CH2: account observations never author dispatch intent.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeInstanceStore } from "../src/daemon-host/agent-runtime-instance-store.ts";
import { resolveRuntimeInstanceCandidates } from "../src/daemon-host/runtime-spawn-mission.ts";
import { compatibleRuntimeInstances, runtimeInstanceModel } from "../src/daemon-host/runtime-instance-selection.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import type { RuntimeInstanceSummary } from "../src/daemon-host/agent-runtime-instance-types.ts";
import { runtimeInstanceDispatchModels } from "@harness-anything/kernel/internal/domain/runtime-instance-contract.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

const hydrogen = "gemini-4-hydrogen-low",
  carbon = "gemini-4-carbon-high";

test("account model admission preserves operator defaults, folds observed spelling and closes unobserved independent accounts", () => {
  assert.deepEqual(runtimeInstanceDispatchModels({ models: [hydrogen] }), [hydrogen]);
  assert.deepEqual(
    runtimeInstanceDispatchModels({ models: [hydrogen, carbon], availableModels: [hydrogen.toUpperCase()] }),
    [hydrogen],
  );
  const unobserved = {
    instanceId: "pro",
    kindId: "agy",
    enabled: true,
    credentialSource: "instance" as const,
    models: [hydrogen],
  };
  assert.deepEqual(runtimeInstanceDispatchModels(unobserved), []);
  assert.deepEqual(compatibleRuntimeInstances({ agent: { runtimes: [] }, runtimeInstances: [unobserved] }), []);
});
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-account-eligibility-")),
    catalog = path.join(root, "catalog.json");
  writeFileSync(catalog, JSON.stringify([hydrogen]));
  const executablePath = writeProviderExecutable(
      path.join(root, "agy"),
      `
    const fs = require("node:fs"), args = process.argv.slice(2);
    if (args[0] === "models") console.log(JSON.parse(fs.readFileSync(${JSON.stringify(catalog)})).map(m=>m+"\\tmodel").join("\\n"));
    else if (args[0] === "-p") console.log(JSON.stringify({command:{data:{groups:[{buckets:[{remaining_fraction:1,reset_time:"2099-01-01T00:00:00Z"}]}]}}}));
  `,
    ),
    store = openRuntimeInstanceStore({
      userRoot: root,
      platform: "darwin",
      env: {},
      discover: () => [
        {
          kindId: "agy",
          installationId: "agy",
          executablePath,
          version: "1.1.15",
          observedAt: "2026-11-14T00:00:00Z",
          models: [hydrogen, carbon],
          defaultModel: carbon,
        },
      ],
    });
  const create = (extra: Record<string, unknown> = {}) =>
    store.command({
      kind: "runtime-instance-create",
      instanceId: "pro",
      name: "Pro",
      kindId: "agy",
      installationId: "agy",
      providerId: "google",
      authMode: "subscription",
      credentialSource: "instance",
      models: [],
      enabled: false,
      ...extra,
    });
  const rows = () =>
    (store.command({ kind: "runtime-instance-list", all: true }) as { instances: RuntimeInstanceSummary[] }).instances;
  const candidates = (model?: string) =>
    resolveRuntimeInstanceCandidates({
      agent: null,
      instances: rows(),
      allowedInstanceIds: ["pro"],
      sessions: [],
      model,
    });
  return {
    root,
    catalog,
    store,
    create,
    rows,
    candidates,
    close: () => removeTempRepository(root),
  };
}

test("empty independent account stays closed until probed, then quick-enable autofills observed models and defaultModel", async () => {
  const f = fixture();
  try {
    await f.create();
    assert.equal(f.store.read("pro")?.enabled, false);
    assert.deepEqual(f.store.read("pro")?.models, []);
    assert.equal(f.store.read("pro")?.defaultModel, "");
    assert.throws(() => f.candidates());
    // Negative control: unprobed independent account with empty availableModels still refuses enablement.
    assert.throws(() => f.store.command({ kind: "runtime-instance-update", instanceId: "pro", enabled: true }), {
      code: "invalid_runtime_model",
    });
    assert.equal(f.store.read("pro")?.enabled, false);
    assert.ok(f.store.prepareAuthCommand("pro", "login").args.includes("--login"));
    const flash = "gemini-3.8-flash";
    writeFileSync(f.catalog, JSON.stringify([hydrogen, flash]));
    await f.store.refreshAccount("pro");
    assert.deepEqual(f.store.read("pro")?.availableModels, [hydrogen, flash]);
    assert.deepEqual(f.store.read("pro")?.models, []);
    assert.equal(f.store.read("pro")?.defaultModel, "");
    assert.equal(f.store.read("pro")?.enabled, false);
    assert.throws(
      () =>
        f.store.command({
          kind: "runtime-instance-update",
          instanceId: "pro",
          models: [carbon],
          defaultModel: carbon,
          enabled: true,
        }),
      { code: "invalid_runtime_model" },
    );
    await f.store.command({ kind: "runtime-instance-update", instanceId: "pro", enabled: true });
    assert.equal(f.store.read("pro")?.enabled, true);
    assert.deepEqual(f.store.read("pro")?.models, [hydrogen, flash]);
    assert.equal(f.store.read("pro")?.defaultModel, hydrogen);
    assert.deepEqual(f.candidates(hydrogen), ["pro"]);
    assert.throws(() => f.candidates(carbon));
    assert.ok(
      (await f.store.prepareLaunch("pro", { cwd: f.root, prompt: "test", model: hydrogen })).args.includes(hydrogen),
    );
  } finally {
    f.close();
  }
});

test("empty independent account with explicit models and no defaultModel autofills defaultModel without breaking non-empty default checks", async () => {
  const f = fixture();
  try {
    const flash = "gemini-3.8-flash";
    writeFileSync(f.catalog, JSON.stringify([hydrogen, flash]));
    await f.create();
    await f.store.refreshAccount("pro");
    await f.store.command({
      kind: "runtime-instance-update",
      instanceId: "pro",
      models: [flash],
      enabled: true,
    });
    assert.equal(f.store.read("pro")?.enabled, true);
    assert.deepEqual(f.store.read("pro")?.models, [flash]);
    assert.equal(f.store.read("pro")?.defaultModel, flash);
    // Existing non-empty defaultModel contract remains strict when omitted from a model-set update that drops it.
    assert.throws(
      () =>
        f.store.command({
          kind: "runtime-instance-update",
          instanceId: "pro",
          models: [hydrogen],
        }),
      { code: "invalid_runtime_model" },
    );
    assert.deepEqual(f.store.read("pro")?.models, [flash]);
    assert.equal(f.store.read("pro")?.defaultModel, flash);
  } finally {
    f.close();
  }
});

test("account refresh preserves authored models while all dispatch consumers exclude unavailable models, including a stale default", async () => {
  const f = fixture();
  try {
    await f.create({ models: [hydrogen, carbon], defaultModel: carbon, enabled: true });
    assert.throws(() => f.candidates(carbon), "unobserved independent catalog is not an installation catalog");
    await f.store.refreshAccount("pro");
    assert.deepEqual(f.store.read("pro")?.models, [hydrogen, carbon]);
    assert.equal(f.store.read("pro")?.defaultModel, carbon);
    assert.deepEqual(f.candidates(hydrogen), ["pro"]);
    assert.throws(() => f.candidates(carbon));
    assert.throws(() => f.candidates(), "an unavailable default cannot supply an unspecified model");
    assert.equal(runtimeInstanceModel(f.rows(), "pro", carbon), null);
    assert.equal(runtimeInstanceModel(f.rows(), "pro", undefined), null);
    assert.deepEqual(
      compatibleRuntimeInstances({ agent: { runtimes: [{ type: "agy", model: carbon }] }, runtimeInstances: f.rows() }),
      [],
    );
    await assert.rejects(f.store.prepareLaunch("pro", { cwd: f.root, prompt: "test", model: carbon }), {
      code: "invalid_runtime_model",
    });
    writeFileSync(f.catalog, JSON.stringify([carbon]));
    await f.store.refreshAccount("pro");
    assert.deepEqual(f.store.read("pro")?.models, [hydrogen, carbon]);
    assert.throws(() => f.candidates(hydrogen));
    assert.deepEqual(f.candidates(carbon), ["pro"]);
  } finally {
    f.close();
  }
});

test("empty model sets are refused for enabled, operator and API-key instances", () => {
  for (const extra of [
    { enabled: true },
    { credentialSource: "operator" },
    { authMode: "api-key", credentialSource: "operator", credentialRef: "test-reference" },
  ]) {
    const f = fixture();
    try {
      assert.throws(() => f.create(extra));
      assert.equal(f.store.read("pro"), null);
    } finally {
      f.close();
    }
  }
});

test("empty Codex bootstrap refreshes native account models without inventing a model or sending a paid prompt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-codex-bootstrap-")),
    trace = path.join(root, "calls.jsonl");
  try {
    const executablePath = writeProviderExecutable(
        path.join(root, "codex"),
        `
      const fs = require("node:fs"), args = process.argv.slice(2);
      fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args)+"\\n");
      if (args[0] === "login") process.exit(0);
      if (args[0] !== "app-server") process.exit(99);
      require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
        const m=JSON.parse(line); if(m.method==="initialized") return;
        const result=m.method==="initialize"?{}:{data:[{model:"account-model"}],nextCursor:null};
        console.log(JSON.stringify({id:m.id,result}));
      });
    `,
      ),
      store = openRuntimeInstanceStore({
        userRoot: root,
        platform: "darwin",
        env: {},
        discover: () => [
          {
            installationId: "codex",
            kindId: "codex",
            executablePath,
            version: "9999.1.0",
            observedAt: "2026-11-14T00:00:00Z",
          },
        ],
      });
    await store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-pro",
      name: "Codex Pro",
      kindId: "codex",
      installationId: "codex",
      providerId: "openai",
      authMode: "subscription",
      credentialSource: "instance",
      models: [],
      enabled: false,
    });
    await store.refreshAccount("codex-pro");
    const account = store.read("codex-pro")!;
    assert.deepEqual(account.availableModels, ["account-model"]);
    assert.deepEqual(account.models, []);
    assert.equal(account.defaultModel, "");
    assert.equal(account.enabled, false);
    const calls = readFileSync(trace, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    assert.ok(calls.some((args) => args[0] === "login"));
    assert.ok(calls.some((args) => args[0] === "app-server"));
    assert.equal(
      calls.some((args) => args.includes("exec")),
      false,
    );
  } finally {
    removeTempRepository(root);
  }
});
