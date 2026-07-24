// harness-test-tier: integration
import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { JsonRpcLineClient } from "../src/client/json-rpc-line-client.ts";
import type { JsonObject } from "../src/protocol/json-rpc-types.ts";
import { createFixture } from "../../cli/test/production-authority-canonical-ingress/fixture.ts";
import { cliTestEnv } from "../../cli/test/helpers/cli-test-env.ts";

const integrationTest = process.platform === "win32" ? test.skip : test;
const taskId = "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4";
const amplifierDelayMs = 5_250;
const readerP95TargetMs = 2_000;
const projectionMethods = [
  "repo.tasks.list",
  "repo.decisions.list",
  "repo.facts.list",
  "repo.executions.list",
  "repo.catalog.snapshot"
] as const;
const readerWorkload = Array.from(
  { length: 32 },
  (_, index) => projectionMethods[index % projectionMethods.length]!
);

integrationTest("production child keeps projection reader p95 below two seconds during a governed write", {
  timeout: 30_000
}, async (t) => {
  const probe = await startProbe();
  t.after(() => probe.close());
  const warmClient = await probe.openClient();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(
      (await request(warmClient, "repo.tasks.list", repoParams({}))).receipt.ok,
      true
    );
  }

  const writerClient = await probe.openClient();
  const readerClients = await Promise.all(
    readerWorkload.map(() => probe.openClient())
  );
  probe.arm();
  const writer = request(
    writerClient,
    "repo.command.run",
    repoParams({
      command: {
        rootDir: probe.repoRoot,
        json: true,
        action: {
          kind: "progress-append",
          taskId,
          text: "writer-reader production cutover probe",
          evidence: [],
          dryRun: false
        }
      },
      executor: { kind: "agent", id: "codex" }
    }),
    20_000
  );
  await probe.waitForAmplifier();
  const observations = await Promise.all(readerWorkload.map((method, index) =>
    request(readerClients[index]!, method, repoParams({}))
  ));
  const writerResult = await writer;

  assert.equal(writerResult.receipt.ok, true, JSON.stringify(writerResult.receipt));
  assert.equal(
    observations.every(({ receipt }) => receipt.ok === true),
    true,
    JSON.stringify(observations)
  );
  const p95ByClients = Object.fromEntries([3, 10, 32].map((clientCount) => [
    clientCount,
    percentile95(
      observations.slice(0, clientCount).map(({ wallMs }) => wallMs)
    )
  ]));
  const p95 = p95ByClients[32]!;
  t.diagnostic(JSON.stringify({
    schema: "daemon-writer-reader-cutover/v1",
    amplifierDelayMs,
    writerWallMs: writerResult.wallMs,
    readers: observations.map(({ method, wallMs }) => ({ method, wallMs })),
    readerP95MsByClients: p95ByClients,
    readerP95TargetMs
  }));
  assert.ok(
    p95 < readerP95TargetMs,
    `reader p95 ${p95}ms exceeded ${readerP95TargetMs}ms: ${JSON.stringify(observations)}`
  );
});

interface Probe {
  readonly repoRoot: string;
  readonly arm: () => void;
  readonly waitForAmplifier: () => Promise<void>;
  readonly openClient: () => Promise<JsonRpcLineClient>;
  readonly close: () => Promise<void>;
}

async function startProbe(): Promise<Probe> {
  const fixture = createFixture();
  const userRoot = path.join(fixture.root, "daemon-user");
  const socketRoot = path.join(
    "/tmp",
    `ha-wr-${process.pid}-${randomUUID().slice(0, 8)}`
  );
  const endpoint = path.join(socketRoot, "daemon.sock");
  const amplifier = installGitAmplifier(fixture.root);
  const loaderPath = installCheckoutLoader(fixture.root);
  const inheritedEnv = cliTestEnv();
  const clients = new Set<JsonRpcLineClient>();
  let stdout = "";
  let stderr = "";
  mkdirSync(userRoot, { recursive: true, mode: 0o700 });
  mkdirSync(socketRoot, { mode: 0o700 });
  const daemon = spawn(process.execPath, [
    "--import",
    loaderPath,
    path.resolve("packages/cli/src/index.ts"),
    "--root",
    fixture.repoRoot,
    "daemon",
    "serve",
    "--repo",
    "canonical",
    "--socket",
    endpoint,
    "--user-root",
    userRoot,
    "--authority-manifest",
    fixture.manifestPath,
    "--idle-ms",
    "0"
  ], {
    env: cliTestEnv({
      HOME: path.join(fixture.root, ".home"),
      USERPROFILE: path.join(fixture.root, ".home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_ACTOR: "agent:codex",
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: userRoot,
      HARNESS_GIT_AUTHOR_NAME: "Writer Reader Probe",
      HARNESS_GIT_AUTHOR_EMAIL: "writer-reader-probe@example.test",
      PATH: `${amplifier.binDir}${path.delimiter}${inheritedEnv.PATH ?? ""}`,
      HA_WRITER_READER_ARM: amplifier.armPath,
      HA_WRITER_READER_HIT: amplifier.hitPath,
      HA_WRITER_READER_REAL_GIT: amplifier.realGit,
      HA_WRITER_READER_CHECKOUT_ROOT: process.cwd()
    }, inheritedEnv),
    stdio: ["pipe", "pipe", "pipe"]
  });
  daemon.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout = `${stdout}${chunk}`.slice(-8_192);
  });
  daemon.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  let readinessSocket: net.Socket | undefined;
  try {
    readinessSocket = await connectWhenReady(
      endpoint,
      daemon,
      () => ({ stdout, stderr })
    );
  } catch (error) {
    await stopDaemon(daemon);
    rmSync(socketRoot, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    throw error;
  }
  return {
    repoRoot: fixture.repoRoot,
    arm: () => closeSync(openSync(amplifier.armPath, "w", 0o600)),
    waitForAmplifier: () => waitFor(
      () => existsSync(amplifier.hitPath),
      10_000,
      () => `writer never reached git commit; stdout=${stdout} stderr=${stderr}`
    ),
    openClient: async () => {
      const deadline = Date.now() + 20_000;
      let lastError: unknown;
      while (Date.now() < deadline) {
        const socket = readinessSocket
          ? takeReadinessSocket()
          : await connectWhenReady(
            endpoint,
            daemon,
            () => ({ stdout, stderr })
          );
        const client = new JsonRpcLineClient(socket, socket);
        try {
          const hello = await client.request("protocol.hello", {
            protocolVersion: 1
          });
          if (hello.ok !== true) {
            throw new Error(`handshake failed: ${JSON.stringify(hello)}`);
          }
          clients.add(client);
          return client;
        } catch (error) {
          lastError = error;
          client.close();
          await delay(25);
        }
      }
      throw new Error(
        `handshake transport failed: ${String(lastError)}`
        + ` code=${daemon.exitCode} signal=${daemon.signalCode}`
        + ` stdout=${stdout} stderr=${stderr}`
      );
    },
    close: async () => {
      for (const client of clients) client.close();
      await stopDaemon(daemon);
      rmSync(socketRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  };

  function takeReadinessSocket(): net.Socket {
    if (!readinessSocket) {
      throw new Error("readiness socket already consumed");
    }
    const socket = readinessSocket;
    readinessSocket = undefined;
    return socket;
  }
}

function installGitAmplifier(root: string): {
  readonly armPath: string;
  readonly binDir: string;
  readonly hitPath: string;
  readonly realGit: string;
} {
  const binDir = path.join(root, "probe-bin");
  const armPath = path.join(root, "git-amplifier.arm");
  const hitPath = path.join(root, "git-amplifier.hit");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperPath = path.join(binDir, "git");
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  writeFileSync(wrapperPath, [
    "#!/usr/bin/env node",
    '"use strict";',
    'const { closeSync, existsSync, openSync } = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    "const args = process.argv.slice(2);",
    "const env = process.env;",
    'if (args.includes("commit") && existsSync(env.HA_WRITER_READER_ARM ?? "") && !existsSync(env.HA_WRITER_READER_HIT ?? "")) {',
    '  closeSync(openSync(env.HA_WRITER_READER_HIT, "wx", 0o600));',
    `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${amplifierDelayMs});`,
    "}",
    "const result = spawnSync(env.HA_WRITER_READER_REAL_GIT, args, { env, stdio: \"inherit\" });",
    "if (result.error) throw result.error;",
    "if (result.signal) process.kill(process.pid, result.signal);",
    "process.exit(result.status ?? 1);",
    ""
  ].join("\n"), { encoding: "utf8", mode: 0o700 });
  chmodSync(wrapperPath, 0o700);
  return { armPath, binDir, hitPath, realGit };
}

function installCheckoutLoader(root: string): string {
  const loaderPath = path.join(root, "checkout-package-loader.mjs");
  writeFileSync(loaderPath, [
    'import path from "node:path";',
    'import { registerHooks } from "node:module";',
    'import { fileURLToPath, pathToFileURL } from "node:url";',
    'const checkoutRoot = process.env.HA_WRITER_READER_CHECKOUT_ROOT;',
    "registerHooks({ resolve(specifier, context, nextResolve) {",
    "  const resolved = nextResolve(specifier, context);",
    '  if (!specifier.startsWith("@harness-anything/") || !resolved.url.startsWith("file:")) return resolved;',
    "  const resolvedPath = fileURLToPath(resolved.url);",
    "  const marker = `${path.sep}packages${path.sep}`;",
    "  const markerIndex = resolvedPath.lastIndexOf(marker);",
    "  if (markerIndex < 0) return resolved;",
    "  return { ...resolved, url: pathToFileURL(path.join(checkoutRoot, resolvedPath.slice(markerIndex + 1))).href, shortCircuit: true };",
    "} });",
    ""
  ].join("\n"));
  return loaderPath;
}

async function request(
  client: JsonRpcLineClient,
  method: string,
  params: JsonObject,
  timeoutMs = 10_000
): Promise<{ readonly method: string; readonly wallMs: number; readonly receipt: JsonObject }> {
  const started = performance.now();
  const receipt = await client.request(method, params, timeoutMs);
  return { method, wallMs: performance.now() - started, receipt };
}

function repoParams(payload: JsonObject): JsonObject {
  return { repo: { repoId: "canonical" }, payload };
}

function percentile95(samples: ReadonlyArray<number>): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function connectWhenReady(
  endpoint: string,
  daemon: ChildProcessWithoutNullStreams,
  output: () => { readonly stdout: string; readonly stderr: string }
): Promise<net.Socket> {
  const deadline = Date.now() + 20_000;
  while (true) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`daemon exited before ready: ${JSON.stringify(output())}`);
    }
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(endpoint);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(`daemon readiness timeout: ${String(error)} ${JSON.stringify(output())}`);
      }
      await delay(25);
    }
  }
}

async function stopDaemon(daemon: ChildProcessWithoutNullStreams): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  daemon.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise<true>((resolve) => daemon.once("exit", () => resolve(true))),
    delay(1_000).then(() => false)
  ]);
  if (exited) return;
  daemon.kill("SIGKILL");
  await new Promise<void>((resolve) => daemon.once("exit", () => resolve()));
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  diagnostic: () => string
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(diagnostic());
    await delay(5);
  }
}
