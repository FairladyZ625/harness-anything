// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { RuntimeInstallationWitness } from "../../daemon/src/agent-runtime-instances.ts";
import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";
import { openDaemonHost } from "../../daemon/src/daemon-host.ts";
import { createJsonRpcProtocolServer } from "../../daemon/src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../../daemon/src/transport/unix-socket.ts";
import { writeProviderExecutable } from "../../daemon/test/fixtures/runtime-stub.ts";
import { createLocalGuiServiceBridge } from "../src/main/local-composition-root.ts";
import { addLocalMainControls } from "../src/main/local-main-controls.ts";

test("GUI registry bridge lists, creates, updates, deletes, and probes a runtime instance", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-gui-runtime-instance-")), rootDir = path.join(parent, "repo"), userRoot = path.join(parent, "user"), daemonId = "gui-runtime-instance";
  mkdirSync(rootDir, { recursive: true });
  const executablePath = writeProviderExecutable(path.join(parent, "codex-runtime-stub"), `const args = process.argv.slice(2);\nif (args[0] === "login" && args[1] === "status") process.exit(0);\nprocess.exit(args[0] === "--version" ? 0 : 9);\n`);
  const installation: RuntimeInstallationWitness = { installationId: "installation-gui-runtime-a", kindId: "codex", executablePath, version: "1.0.0", observedAt: "2026-08-23T00:00:00.000Z" }, replacementInstallation: RuntimeInstallationWitness = { ...installation, installationId: "installation-gui-runtime-b", version: "1.1.0" };
  const endpoint = localUserDaemonEndpoint(userRoot, daemonId), host = await openDaemonHost({ daemonId, userRoot, endpoint, runtimeDiscover: () => [installation, replacementInstallation], runtimeEnv: { HOME: path.join(parent, "operator-home"), PATH: process.env.PATH ?? "" } });
  const transport = createUnixSocketTransportServer({ daemonId, socketPath: endpoint, createProtocolServer: (authContext, emit) => createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }) });
  const previous = { userRoot: process.env.HARNESS_DAEMON_USER_ROOT, daemonId: process.env.HARNESS_DAEMON_ID };
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot; process.env.HARNESS_DAEMON_ID = daemonId;
  await transport.start();
  try {
    const base = createLocalGuiServiceBridge(rootDir), bridge = addLocalMainControls({ bridge: base, target: async () => ({ repoId: "unused", socketPath: endpoint, userRoot, daemonId }), clientBuildCommit: null });
    const before = await bridge.invoke("listRuntimeInstances", { all: true }) as RuntimeReceipt;
    assert.deepEqual(before.instances, []);
    const created = await bridge.invoke("createRuntimeInstance", { instanceId: "codex-gui", name: "Codex GUI", kindId: "codex", installationId: installation.installationId, providerId: "openai", models: ["model-a", "model-b"], defaultModel: "model-a", codex: {}, authMode: "subscription" }) as RuntimeReceipt;
    assert.equal(created.instance?.instanceId, "codex-gui", JSON.stringify(created));
    const listed = await bridge.invoke("listRuntimeInstances", { all: true }) as RuntimeReceipt;
    assert.deepEqual(listed.instances?.map(({ instanceId }) => instanceId), ["codex-gui"]);
    const shown = await bridge.invoke("showRuntimeInstance", { instanceId: "codex-gui" }) as RuntimeReceipt;
    assert.equal(shown.instance?.enabled, true, JSON.stringify(shown));
    const updated = await bridge.invoke("updateRuntimeInstance", { instanceId: "codex-gui", name: "Codex GUI edited", installationId: replacementInstallation.installationId, models: ["model-b", "model-c"], defaultModel: "model-c" }) as RuntimeReceipt;
    assert.deepEqual(updated.instance && { name: updated.instance.name, installationId: updated.instance.installationId, models: updated.instance.models, defaultModel: updated.instance.defaultModel }, { name: "Codex GUI edited", installationId: replacementInstallation.installationId, models: ["model-b", "model-c"], defaultModel: "model-c" }, JSON.stringify(updated));
    const relisted = await bridge.invoke("listRuntimeInstances", { all: true }) as RuntimeReceipt;
    assert.deepEqual(relisted.instances?.map((entry) => ({ name: entry.name, installationId: entry.installationId, models: entry.models, defaultModel: entry.defaultModel })), [{ name: "Codex GUI edited", installationId: replacementInstallation.installationId, models: ["model-b", "model-c"], defaultModel: "model-c" }], JSON.stringify(relisted));
    const probed = await bridge.invoke("showRuntimeInstance", { instanceId: "codex-gui", probe: true }) as RuntimeReceipt;
    assert.equal(probed.instance?.authReadiness?.status, "ready", JSON.stringify(probed));
    const deleted = await bridge.invoke("deleteRuntimeInstance", { instanceId: "codex-gui" }) as RuntimeReceipt;
    assert.equal(deleted.deletedInstanceId, "codex-gui", JSON.stringify(deleted));
    const after = await bridge.invoke("listRuntimeInstances", { all: true }) as RuntimeReceipt;
    assert.deepEqual(after.instances, []);
    console.info(`GUI_RUNTIME_INSTANCE_BEHAVIOR ${JSON.stringify({ listed: true, created: created.instance?.instanceId, shown: shown.instance?.instanceId, updatedName: updated.instance?.name, updatedInstallation: updated.instance?.installationId, updatedModels: updated.instance?.models, updatedDefaultModel: updated.instance?.defaultModel, relisted: relisted.instances?.[0]?.name, probed: probed.instance?.authReadiness?.status, deleted: deleted.deletedInstanceId })}`);
  } finally {
    await transport.stop(); await host.close();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot); restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    rmSync(parent, { recursive: true, force: true });
  }
});

interface RuntimeReceipt { readonly instances?: ReadonlyArray<{ readonly instanceId: string; readonly name?: string; readonly installationId?: string; readonly models?: readonly string[]; readonly defaultModel?: string }>; readonly instance?: { readonly instanceId: string; readonly enabled: boolean; readonly name?: string; readonly installationId?: string; readonly models?: readonly string[]; readonly defaultModel?: string; readonly authReadiness?: { readonly status: string } }; readonly deletedInstanceId?: string }
function restoreEnv(name: string, value: string | undefined): void { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
