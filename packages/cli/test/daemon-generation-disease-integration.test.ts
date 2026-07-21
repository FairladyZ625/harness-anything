// harness-test-tier: integration
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createCompoundReceiptServiceV2 } from "../../application/src/index.ts";
import {
  createDurableCompoundReceiptStoreV2,
  daemonGenerationFencedCode,
  localUserDaemonEndpoint,
  requestLocalDaemonJsonRpc
} from "../../daemon/src/index.ts";
import {
  defaultDaemonUserRoot,
  pollUntil,
  runDaemonCommand,
  stopDaemon
} from "./helpers/daemon-cli.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

test("kill -9 replacement fences stale terminal residue across launch status control and receipt", {
  skip: process.platform === "win32" ? "SIGKILL and durable generation publication are unavailable on Windows" : false,
  timeout: 60_000
}, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const endpointIdentity = localUserDaemonEndpoint(userRoot);
  const receiptDirectory = path.join(fixture.root, "disease-receipts");
  const children: ChildProcess[] = [];
  const env = {
    HARNESS_DAEMON_MODE: "local",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    HARNESS_DAEMON_IDLE_MS: "60000",
    HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "20000"
  };
  try {
    const registered = runDaemonCommand(fixture.repoRoot, [
      "daemon", "repo", "register",
      "--repo-id", "canonical",
      "--canonical-root", fixture.repoRoot,
      "--user-root", userRoot,
      "--no-link",
      "--json"
    ], env);
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const started = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service",
      "--authority-manifest", fixture.manifestPath,
      "--json"
    ], env);
    assert.equal(started.started, true, JSON.stringify(started));
    assert.equal(typeof started.pid, "number", JSON.stringify(started));

    const firstLaunch = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      { includeGenerationAxes: true },
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const firstLaunchData = diseaseReceiptData(firstLaunch);
    const machineId = String(firstLaunchData.machineId ?? "");
    const firstGeneration = Number(firstLaunchData.daemonGeneration);
    assert.notEqual(machineId, "", JSON.stringify(firstLaunch));
    assert.equal(Number.isSafeInteger(firstGeneration), true, JSON.stringify(firstLaunch));

    const firstStatus = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "repo.daemon.status",
      { repo: { repoId: "canonical" }, includeGenerationAxes: true },
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const firstStatusData = diseaseReceiptData(firstStatus);
    const firstService = firstStatusData.service as Record<string, unknown>;
    assert.equal(firstService.machineId, machineId, JSON.stringify(firstStatus));
    assert.equal(firstService.daemonGeneration, firstGeneration, JSON.stringify(firstStatus));
    assert.equal(typeof firstStatusData.connectionId, "string", JSON.stringify(firstStatus));

    const receiptService = createCompoundReceiptServiceV2({
      store: createDurableCompoundReceiptStoreV2({ directory: receiptDirectory }),
      createWaiterId: () => "waiter-disease-integration",
      createResultToken: () => Buffer.alloc(32, 0x64).toString("base64url")
    });
    const opened = await receiptService.openWaiter({
      workspaceId: "workspace-disease-integration",
      viewId: "view-disease-integration",
      opId: "op-disease-integration"
    });
    const stale = startDiseaseReceiptRacer(children, [
      "old",
      userRoot,
      endpointIdentity,
      machineId,
      String(firstGeneration),
      receiptDirectory,
      encodeDiseaseIdentity(opened.identity)
    ]);
    assert.equal((await awaitDiseaseChildMessage(stale)).type, "validated");

    process.kill(started.pid as number, "SIGKILL");
    await killDiseaseDaemonAndWait(started.pid as number);
    const replacementStart = runDaemonCommand(fixture.repoRoot, [
      "daemon", "start", "--service",
      "--authority-manifest", fixture.manifestPath,
      "--json"
    ], env);
    assert.equal(replacementStart.started, true, JSON.stringify(replacementStart));
    assert.notEqual(replacementStart.pid, started.pid, JSON.stringify(replacementStart));

    const replacementLaunch = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.launch-spec",
      { includeGenerationAxes: true },
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const replacementLaunchData = diseaseReceiptData(replacementLaunch);
    const replacementGeneration = Number(replacementLaunchData.daemonGeneration);
    assert.equal(replacementLaunchData.machineId, machineId, JSON.stringify(replacementLaunch));
    assert.equal(replacementGeneration > firstGeneration, true, JSON.stringify(replacementLaunch));

    const replacementStatus = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "repo.daemon.status",
      { repo: { repoId: "canonical" }, includeGenerationAxes: true },
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    const replacementStatusData = diseaseReceiptData(replacementStatus);
    const replacementService = replacementStatusData.service as Record<string, unknown>;
    assert.equal(replacementService.daemonGeneration, replacementGeneration, JSON.stringify(replacementStatus));
    assert.notEqual(replacementStatusData.connectionId, firstStatusData.connectionId, JSON.stringify(replacementStatus));

    const staleControl = await requestLocalDaemonJsonRpc(
      fixture.repoRoot,
      "admin.daemon.restart",
      {
        payload: {
          reason: "prove stale generation control rejection",
          drainTimeoutMs: 5_000,
          daemonGeneration: firstGeneration,
          connectionId: firstStatusData.connectionId
        }
      },
      1_000,
      { userRoot, allowLegacySocket: false }
    );
    assert.equal(staleControl.ok, false, JSON.stringify(staleControl));
    assert.equal((staleControl.error as Record<string, unknown>).code, "daemon_control_generation_mismatch");

    const current = startDiseaseReceiptRacer(children, [
      "current",
      userRoot,
      endpointIdentity,
      machineId,
      String(replacementGeneration),
      receiptDirectory,
      encodeDiseaseIdentity(opened.identity)
    ]);
    const committed = await awaitDiseaseChildMessage(current);
    assert.equal(committed.type, "committed", JSON.stringify(committed));
    const terminalReceipt = committed.receipt as Record<string, unknown>;
    assert.equal(terminalReceipt.daemonGeneration, replacementGeneration, JSON.stringify(committed));
    assert.equal(terminalReceipt.delivery, "DETACHED", JSON.stringify(committed));
    const statePath = path.join(receiptDirectory, "compound-receipt-broker-state-v2.json");
    const currentBytes = readFileSync(statePath);

    stale.send("release");
    const rejected = await awaitDiseaseChildMessage(stale);
    assert.equal(rejected.type, "error", JSON.stringify(rejected));
    assert.equal(rejected.code, daemonGenerationFencedCode, JSON.stringify(rejected));
    assert.equal((rejected.context as Record<string, unknown>).schema, "daemon-generation-write-rejection/v1");
    assert.equal(readFileSync(statePath).equals(currentBytes), true, "stale terminal attempt changed replacement receipt bytes");
  } finally {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await stopDaemon(fixture.repoRoot, userRoot).catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function diseaseReceiptData(receipt: Record<string, unknown>): Record<string, unknown> {
  const details = receipt.details as Record<string, unknown> | undefined;
  const data = details?.data as Record<string, unknown> | undefined;
  assert.ok(data, JSON.stringify(receipt));
  return data;
}

function startDiseaseReceiptRacer(children: ChildProcess[], args: ReadonlyArray<string>): ChildProcess {
  const child = fork(fileURLToPath(new URL("../../daemon/test/fixtures/generation-terminal-racer.ts", import.meta.url)), [...args], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: process.execArgv.filter((argument) => argument !== "--test-force-exit")
  });
  children.push(child);
  return child;
}

function awaitDiseaseChildMessage(child: ChildProcess): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`disease racer exited before response: code=${code};signal=${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.once("message", onMessage);
    child.once("exit", onExit);
  });
}

function encodeDiseaseIdentity(identity: unknown): string {
  return Buffer.from(JSON.stringify(identity), "utf8").toString("base64url");
}

async function killDiseaseDaemonAndWait(pid: number): Promise<void> {
  await pollUntil(
    () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    (alive) => !alive,
    (alive, error) => JSON.stringify({ pid, alive, error: String(error ?? "") }),
    { timeoutMs: 8_000 }
  );
}
