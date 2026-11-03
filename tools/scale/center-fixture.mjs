import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { initRepo } from "../../packages/storage/test/store/task-event-store.fixtures.ts";
import { registerSettledBootstrappedDaemonRepo } from "../../packages/daemon/test/repo-settings.fixture.ts";
import { fleetNodeOwners } from "../../packages/daemon/test/fleet-store.fixture.ts";
import { saveFleetCenterConfig } from "../../packages/daemon/src/fleet-center-config.ts";
import { requestDaemonJsonRpcAt } from "../../packages/daemon/src/client/local-json-rpc-client.ts";
import { generateCenterLedger, ledgerProfile } from "./center-ledger.mjs";
import { withWatchdog } from "../stress/core/controller.mjs";

export async function createCenterFixture({
  nodes = 1,
  seed = "20261103",
  scale = 0.001,
  profile = ledgerProfile(scale),
  onProgress,
  track = () => undefined,
} = {}) {
  const scratch = mkdtempSync(path.join(tmpdir(), "ha-center-bench-")),
    rootDir = path.join(scratch, "repo"),
    userRoot = path.join(scratch, "user"),
    repoId = "center-bench",
    keyPath = path.join(scratch, "tls.key"),
    certPath = path.join(scratch, "tls.crt");
  let owners,
    child,
    childExit,
    closed = false;
  const waiters = new Map(),
    events = [],
    stderr = [];
  let sequence = 0,
    endpoint;
  const request = (command) =>
    withWatchdog(
      () =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          waiters.set(id, { resolve, reject });
          child.send({ command, id });
        }),
      { timeoutMs: 30_000, label: `center IPC ${command}` },
    );
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          await request("stop");
        } catch (error) {
          console.error(`center benchmark graceful stop: ${error.message}`);
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await childExit;
        }
      }
    } finally {
      await owners?.close();
      rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  };
  track(close);
  try {
    mkdirSync(rootDir);
    initRepo(rootDir);
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nname: center-bench\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    owners = await fleetNodeOwners({
      userRoot,
      repoIds: [repoId],
      localPersonId: "center-bench",
      owners: Object.fromEntries(Array.from({ length: nodes }, (_, index) => [`bench-node-${index}`, "center-bench"])),
    });
    await registerSettledBootstrappedDaemonRepo({
      canonicalRoot: rootDir,
      repoId,
      userRoot,
      mode: "remote-center",
      createConvenienceLinks: false,
    });
    const ledger = await generateCenterLedger({ rootDir, repoId, userRoot, seed, profile, onProgress });
    onProgress?.({ phase: "ledger-ready", ledger });
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-subj",
        "/CN=localhost",
        "-days",
        "1",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    const reservation = net.createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    saveFleetCenterConfig(userRoot, "center-bench", {
      port,
      bind: "127.0.0.1",
      repoId,
      keyPath,
      certPath,
      stateRoot: path.join(scratch, "fleet"),
      quotaBytes: Math.max(64 * 1024 ** 2, profile.jsonBytes * 4),
    });
    const configFile = path.join(scratch, "process.json");
    writeFileSync(configFile, JSON.stringify({ rootDir, userRoot, repoId }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
    Object.assign(env, { HARNESS_DAEMON_USER_ROOT: userRoot, HARNESS_DAEMON_ID: "center-bench" });
    child = fork(path.join(import.meta.dirname, "center-process.mjs"), [configFile], {
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    childExit = once(child, "exit");
    child.stderr.on("data", (chunk) => {
      stderr.push(String(chunk));
      if (stderr.length > 20) stderr.shift();
    });
    child.on("message", (message) => {
      if (message.event) {
        events.push(message);
        if (message.endpoint) endpoint = message.endpoint;
      }
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.result);
      }
    });
    child.on("exit", (code, signal) => {
      for (const waiter of waiters.values())
        waiter.reject(new Error(`center exited ${code}/${signal}: ${stderr.join("")}`));
      waiters.clear();
    });
    await withWatchdog(
      async () => {
        while (!endpoint) {
          if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`center startup: ${stderr.join("")}`);
          await once(child, "message");
        }
      },
      { timeoutMs: 30_000, label: "center socket bind" },
    );
    const attachStarted = performance.now();
    await withWatchdog(
      async () => {
        for (;;) {
          const status = await requestDaemonJsonRpcAt(endpoint, "daemon.status", {}, 5000, 5000);
          const repo = status.repos?.find((row) => row.repoId === repoId);
          if (repo?.state === "attached") return;
          if (repo?.state === "unavailable") throw new Error(`synthetic ledger attach failed: ${JSON.stringify(repo)}`);
          await new Promise((resolve) => setImmediate(resolve));
        }
      },
      { timeoutMs: 120_000, label: "synthetic ledger attach" },
    );
    const attachMs = performance.now() - attachStarted;
    return {
      rootDir,
      userRoot,
      repoId,
      ledger,
      attachMs,
      events,
      request,
      close,
      get endpoint() {
        return endpoint;
      },
      peer: (index) => ({
        hostname: "127.0.0.1",
        port,
        ca: readFileSync(certPath),
        servername: "localhost",
        repoId,
        nodeId: `bench-node-${index}`,
        credential: `secret-bench-node-${index}`,
        readAccessToken: owners.readAccessToken(`bench-node-${index}`),
        timeoutMs: 30_000,
      }),
      diagnostics: () => stderr.join(""),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
