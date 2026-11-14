// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import type { CredentialPort } from "../src/agent-runtime-credential-port.ts";
import { runtimeInstanceCredentialService } from "../src/runtime-instance-credentials.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function independent<T>(operation: Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(5_000);
  return new Promise<T>((resolve, reject) => {
    const blocked = () => reject(new Error("Independent operation waited for the held account observation."));
    deadline.addEventListener("abort", blocked, { once: true });
    void operation.then(
      (value) => {
        deadline.removeEventListener("abort", blocked);
        resolve(value);
      },
      (error: unknown) => {
        deadline.removeEventListener("abort", blocked);
        reject(error);
      },
    );
  });
}

function writeAccountAuth(root: string, instanceId: string) {
  const directory = path.join(root, "runtime-instances", instanceId, "home", ".local", "share", "opencode");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ fixture: { type: "api", key: "test-key" } }));
}

async function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-account-fifo-")),
    entered = deferred<void>(),
    peers = new Set<Socket>(),
    server = createServer((peer) => {
      peers.add(peer);
      peer.once("data", () => entered.resolve());
      peer.once("close", () => peers.delete(peer));
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const release = () => {
    for (const peer of peers) if (!peer.destroyed && !peer.writableEnded) peer.end("release");
  };
  t.after(() => {
    release();
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const executablePath = writeProviderExecutable(
    path.join(root, "provider"),
    `
const readline = require("node:readline"), net = require("node:net");
readline.createInterface({input:process.stdin}).on("line", line => {
  const m=JSON.parse(line), reply=result=>console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}));
  if(m.method === "initialize") return reply({authMethods:[]});
  if(m.method === "session/new") {
    const control=net.connect(${address.port},"127.0.0.1",()=>control.write("entered"));
    control.once("data",()=>{
      reply({sessionId:"held-session",configOptions:[{id:"model",category:"model",currentValue:"account-model",options:[{value:"account-model",name:"Account model"}]}]});
      control.destroy();
    });
  }
});
`,
  );
  const secrets = new Map<string, string>();
  let serial = 0;
  const vault: CredentialPort = {
      issue: () => `credential:v1:fifo-fixture-${++serial}`,
      store: async (reference, value) => {
        secrets.set(reference, value);
      },
      resolve: async (reference) => {
        const value = secrets.get(reference);
        if (!value) throw new Error("Fixture credential has retired.");
        return value;
      },
      remove: async (reference) => {
        secrets.delete(reference);
      },
    },
    installations = (["opencode", "claude"] as const).map((kindId) => ({
      kindId,
      installationId: kindId,
      executablePath,
      version: "9999.1.0",
      observedAt: "2026-11-14T00:00:00Z",
    })),
    store = openRuntimeInstanceStore({
      userRoot: root,
      platform: "darwin",
      env: { HOME: path.join(root, "operator"), PATH: process.env.PATH },
      discover: () => installations,
      resolveCredential: vault.resolve,
    }),
    service = runtimeInstanceCredentialService(store, vault),
    subscription = {
      kind: "runtime-instance-create",
      instanceId: "slow",
      name: "Slow account",
      kindId: "opencode",
      installationId: "opencode",
      providerId: "fixture",
      models: ["account-model"],
      authMode: "subscription",
      credentialSource: "instance",
    };
  await service.command(subscription);
  writeAccountAuth(root, "slow");
  await service.command({
    ...subscription,
    instanceId: "other",
    name: "Other account",
    kindId: "claude",
    installationId: "claude",
    authMode: "api-key",
    credentialSource: "operator",
    apiKey: "fixture-key-before",
  });
  const observe = (operation: "launch" | "show" | "list") =>
    operation === "launch"
      ? service.prepareLaunch("slow", { cwd: root, prompt: "fixture" })
      : service.command({
          kind: operation === "show" ? "runtime-instance-show" : "runtime-instance-list",
          instanceId: "slow",
          probe: true,
        });
  return { root, store, service, vault, subscription, installations, entered: entered.promise, release, observe };
}

for (const operation of ["launch", "show", "list"] as const)
  test(`held ACP ${operation} does not occupy the credential FIFO for another instance`, async (t) => {
    const f = await fixture(t),
      observing = f.observe(operation);
    try {
      await f.entered;
      await independent(f.service.command({ kind: "runtime-instance-update", instanceId: "other", name: "Edited" }));
      const launch = await independent(f.service.prepareLaunch("other", { cwd: f.root, prompt: "fixture" }));
      assert.equal(launch.env.ANTHROPIC_API_KEY, "fixture-key-before");
      assert.equal(f.store.read("other")?.name, "Edited");
    } finally {
      f.release();
      await observing;
    }
    assert.equal(
      f.store.listPublic().find((instance) => instance.instanceId === "slow")?.authReadiness.status,
      "ready",
    );
  });

for (const operation of ["launch", "show", "list"] as const)
  for (const mutation of ["credential-source", "delete-recreate"] as const)
    test(`held ACP ${operation} rejects its old account cut after ${mutation}`, async (t) => {
      const f = await fixture(t),
        observing = assert.rejects(f.observe(operation), { code: "runtime_instance_probe_stale" });
      try {
        await f.entered;
        if (mutation === "credential-source")
          await independent(
            f.service.command({ kind: "runtime-instance-update", instanceId: "slow", credentialSource: "operator" }),
          );
        else {
          await independent(f.service.command({ kind: "runtime-instance-delete", instanceId: "slow" }));
          await independent(f.service.command(f.subscription));
        }
      } finally {
        f.release();
        await observing;
      }
      assert.equal(f.store.read("slow")?.availableModels, undefined);
      assert.notEqual(
        f.store.listPublic().find((instance) => instance.instanceId === "slow")?.authReadiness.status,
        "ready",
      );
    });

for (const outcome of ["success", "failure"] as const)
  test(`API-key query rejects a retired account after ${outcome} resolving the old reference`, async (t) => {
    const f = await fixture(t),
      entered = deferred<void>(),
      released = deferred<void>(),
      store = openRuntimeInstanceStore({
        userRoot: f.root,
        platform: "darwin",
        env: { HOME: path.join(f.root, "operator"), PATH: process.env.PATH },
        discover: () => f.installations,
        resolveCredential: async (reference) => {
          const secret = await f.vault.resolve(reference);
          entered.resolve();
          await released.promise;
          if (outcome === "failure") throw new Error("Fixture old credential became unavailable.");
          return secret;
        },
      }),
      service = runtimeInstanceCredentialService(store, f.vault),
      querying = assert.rejects(service.command({ kind: "runtime-instance-show", instanceId: "other", probe: true }), {
        code: "runtime_instance_probe_stale",
      });
    try {
      await entered.promise;
      await independent(
        service.command({ kind: "runtime-instance-update", instanceId: "other", apiKey: "fixture-key-after" }),
      );
    } finally {
      released.resolve();
      await querying;
    }
    assert.notEqual(
      store.listPublic().find((instance) => instance.instanceId === "other")?.authReadiness.status,
      "ready",
    );
  });

test("a queued API-key launch rebound to subscription starts its ACP observation outside the FIFO", async (t) => {
  const f = await fixture(t),
    entered = deferred<void>(),
    released = deferred<void>(),
    service = runtimeInstanceCredentialService(f.store, {
      ...f.vault,
      store: async (reference, value) => {
        entered.resolve();
        await released.promise;
        await f.vault.store(reference, value);
      },
    }),
    writing = service.command({ kind: "runtime-instance-update", instanceId: "other", apiKey: "fixture-key-after" });
  await entered.promise;
  const deleting = service.command({ kind: "runtime-instance-delete", instanceId: "other" }),
    creating = service
      .command({ ...f.subscription, instanceId: "other" })
      .then(() => writeAccountAuth(f.root, "other")),
    preparing = service.prepareLaunch("other", { cwd: f.root, prompt: "fixture" });
  released.resolve();
  try {
    await Promise.all([writing, deleting, creating]);
    await f.entered;
    await independent(service.command({ kind: "runtime-instance-update", instanceId: "slow", name: "Not blocked" }));
  } finally {
    f.release();
    const launch = await preparing;
    assert.equal(launch.authMode, "subscription");
  }
});

test("an aborted ACP model observation preserves authentication and releases its bounded probe", async (t) => {
  const f = await fixture(t),
    abort = new AbortController(),
    observing = f.store.refreshAccount("slow", undefined, abort.signal);
  try {
    await f.entered;
    abort.abort(new Error("Fixture cancelled account observation."));
    const result = await independent(observing);
    assert.equal(result.readiness.status, "ready");
    assert.equal(result.modelCatalogReadiness.code, "runtime_model_catalog_probe_failed");
    await independent(f.service.command({ kind: "runtime-instance-update", instanceId: "other", name: "After abort" }));
  } finally {
    f.release();
  }
});
