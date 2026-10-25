// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonHost } from "@harness-anything/daemon/client";
import { discoverRuntimeInstallations } from "../src/agent-runtime-installation-discovery.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import type { RuntimeInstallationWitness } from "../src/agent-runtime-instance-types.ts";
import { auth } from "./daemon-host-recovery.fixture.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";

const codexWitness: RuntimeInstallationWitness = {
  installationId: "codex_read_path",
  kindId: "codex",
  executablePath: "/opt/not-a-real/codex",
  executableEntryPath: "/opt/not-a-real/codex",
  version: "codex 1.2.3",
  observedAt: "2026-10-25T00:00:00.000Z",
};

async function listed(host: Awaited<ReturnType<typeof openDaemonHost>>, payload: Record<string, unknown>) {
  const receipt = (await host.runtimeInstance("daemon.runtimeInstance.list", payload, auth)) as Record<string, unknown>;
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  return receipt as {
    readonly installations: readonly Record<string, unknown>[];
    readonly instances: readonly { readonly authReadiness: { readonly code: string | null } }[];
  };
}

test("runtime instance list serves the recorded observations instead of re-witnessing the machine", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-list-read-path-")),
    userRoot = path.join(parent, "user");
  let discoveries = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-list-read-path",
    userRoot,
    runtimeDiscover: () => {
      discoveries += 1;
      return [codexWitness];
    },
  });
  try {
    // A machine that has never recorded an installation observes it exactly once, so the first
    // catalog is not a lie. That bootstrap is the only list call allowed to witness.
    assert.deepEqual((await listed(host, { all: true })).installations, [
      {
        installationId: codexWitness.installationId,
        kindId: codexWitness.kindId,
        version: codexWitness.version,
        observedAt: codexWitness.observedAt,
      },
    ]);
    assert.equal(discoveries, 1, "the first list records the machine's installations");
    discoveries = 0;
    for (let round = 0; round < 5; round += 1) {
      const receipt = await listed(host, { all: true });
      assert.equal(receipt.installations.length, 1);
      assert.equal(receipt.installations[0]!.installationId, codexWitness.installationId);
      // The record never carries host paths; the receipt contract keeps them out of every reply.
      assert.equal(JSON.stringify(receipt.installations).includes("executablePath"), false);
    }
    assert.equal(discoveries, 0, "a recorded catalog is read, never re-witnessed");

    const created = (await host.runtimeInstance(
      "daemon.runtimeInstance.create",
      {
        instanceId: "codex-read-path",
        name: "Codex read path",
        kindId: "codex",
        installationId: codexWitness.installationId,
        providerId: "openai",
        models: ["gpt-5.6-sol"],
        authMode: "subscription",
      },
      auth,
    )) as Record<string, unknown>;
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal(discoveries, 1, "create binds an installation id, so it witnesses");

    discoveries = 0;
    const read = await listed(host, { all: true });
    assert.equal(discoveries, 0);
    // A list that is not asked to probe reports the cached readiness; probing would have replaced
    // this code with the process-backed result.
    assert.equal(read.instances[0]!.authReadiness.code, "runtime_auth_not_checked");

    // --probe keeps its meaning: observe the machine, then verify authentication against it.
    await listed(host, { all: true, probe: true });
    assert.equal(discoveries, 1, "--probe still refreshes the witness snapshot");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a steady-state list starts no provider process, and a probe still does", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-runtime-list-no-spawn-")),
    userRoot = path.join(parent, "user"),
    binRoot = path.join(parent, "bin"),
    marker = path.join(parent, "spawned");
  mkdirSync(binRoot, { recursive: true });
  writeProviderExecutable(
    path.join(binRoot, "codex"),
    `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "x"); console.log("codex 1.2.3");\n`,
  );
  let discoveries = 0;
  const host = await openDaemonHost({
    daemonId: "runtime-list-no-spawn",
    userRoot,
    // Discovery is the only spawn site on this path, so a real PATH scan plus a real stub
    // executable makes "no subprocess" observable instead of inferred.
    runtimeDiscover: () => {
      discoveries += 1;
      return discoverRuntimeInstallations({
        env: { PATH: `${binRoot}${path.delimiter}${path.dirname(process.execPath)}` },
      });
    },
  });
  try {
    const bootstrapped = await listed(host, { all: true });
    assert.equal(bootstrapped.installations.length, 1);
    assert.equal(discoveries, 1);
    assert.ok(existsSync(marker), "the bootstrap witness runs the provider CLI");
    rmSync(marker, { force: true });
    discoveries = 0;

    for (let round = 0; round < 3; round += 1) await listed(host, { all: true });
    assert.equal(discoveries, 0);
    assert.equal(existsSync(marker), false, "a recorded list must not start a provider process");
    assert.equal(existsSync(path.join(userRoot, "runtime-installations.json")), true);

    await listed(host, { all: true, probe: true });
    assert.equal(discoveries, 1);
    assert.ok(existsSync(marker), "--probe still observes the machine");
  } finally {
    await host.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the store reads recorded installations without discovering or probing", async () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-runtime-list-store-"));
  let discoveries = 0,
    refreshes = 0,
    probes = 0;
  try {
    const store = openRuntimeInstanceStore({
      userRoot,
      discover: () => {
        discoveries += 1;
        return [codexWitness];
      },
      refreshDiscovery: async () => {
        refreshes += 1;
        return [codexWitness];
      },
      subscriptionReady: () => {
        probes += 1;
        return { status: "ready", code: null, hint: null };
      },
    });
    store.command({
      kind: "runtime-instance-create",
      instanceId: "codex-recorded",
      name: "Codex recorded",
      kindId: "codex",
      installationId: codexWitness.installationId,
      providerId: "openai",
      models: ["gpt-5.6-sol"],
      authMode: "subscription",
    });
    await store.refreshInstallations();
    const record = JSON.parse(readFileSync(path.join(userRoot, "runtime-installations.json"), "utf8")) as {
      readonly schema: string;
      readonly installations: readonly Record<string, unknown>[];
    };
    assert.equal(record.schema, "runtime-installations/v1");
    assert.deepEqual(record.installations, [
      {
        installationId: codexWitness.installationId,
        kindId: codexWitness.kindId,
        version: codexWitness.version,
        observedAt: codexWitness.observedAt,
      },
    ]);
    assert.equal(JSON.stringify(record).includes("executablePath"), false, "the record holds no host paths");

    discoveries = 0;
    refreshes = 0;
    probes = 0;
    const listed = store.command({ kind: "runtime-instance-list", all: true }) as {
      readonly installations: readonly Record<string, unknown>[];
      readonly instances: readonly { readonly authReadiness: { readonly code: string | null } }[];
    };
    assert.deepEqual(listed.installations, record.installations);
    assert.deepEqual([discoveries, refreshes, probes], [0, 0, 0], "list discovers nothing and probes nothing");
    assert.equal(listed.instances[0]!.authReadiness.code, "runtime_auth_not_checked");

    const probed = (await store.command({ kind: "runtime-instance-list", all: true, probe: true })) as {
      readonly instances: readonly { readonly authReadiness: { readonly code: string | null } }[];
    };
    assert.equal(refreshes, 0, "the store's probe reads the snapshot the host refreshed");
    assert.equal(probes, 1, "--probe still verifies authentication");
    assert.equal(probed.instances[0]!.authReadiness.code, null);
  } finally {
    rmSync(userRoot, { recursive: true, force: true });
  }
});
