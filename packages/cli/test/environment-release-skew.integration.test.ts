// harness-test-tier: integration
import { fixtureDaemonHello } from "../../daemon/test/fixtures/daemon-hello.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { requestDaemonShutdownAt } from "@harness-anything/daemon/internal/client/local-json-rpc-shutdown";
import { localUserDaemonEndpoint } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { daemonPidPath, daemonSingletonLockPath } from "@harness-anything/daemon/internal/daemon-singleton";
import { currentDaemonProtocolVersion } from "@harness-anything/daemon/internal/protocol/version";

// A failed hello must dominate every later side effect, including host control fallbacks.
async function fixture(stopOk: boolean) {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-release-skew-repro-")),
    userRoot = path.join(parent, "user"),
    daemonId = "release-skew-repro",
    endpoint = localUserDaemonEndpoint(userRoot, daemonId),
    methods: string[] = [],
    sockets = new Set<net.Socket>();
  mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
  mkdirSync(userRoot, { recursive: true });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const lines = createInterface({ input: socket });
    lines.on("line", (line) => {
      const request = JSON.parse(line) as { id: number; method: string };
      methods.push(request.method);
      const result =
        request.method === "protocol.hello"
          ? stopOk
            ? { ok: true, protocolVersion: currentDaemonProtocolVersion, build: { commit: "other-release" } }
            : fixtureDaemonHello()
          : stopOk
            ? { ok: true }
            : { ok: false, code: "daemon_version_mismatch", error: { hint: "Use the center release CLI." } };
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    });
  });
  server.listen(endpoint);
  await once(server, "listening");
  return {
    parent,
    userRoot,
    daemonId,
    endpoint,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      rmSync(parent, { recursive: true, force: true });
    },
  };
}

test("version-skewed shutdown must reject before sending daemon.stop", { timeout: 20_000 }, async () => {
  const f = await fixture(true);
  try {
    let failure: unknown;
    try {
      await requestDaemonShutdownAt(f.endpoint, 2_000);
    } catch (error) {
      failure = error;
    }
    console.log(JSON.stringify({ observedMethods: f.methods, rejected: failure !== undefined }));
    assert.deepEqual(f.methods, ["protocol.hello"], "A foreign release must not receive daemon.stop.");
    assert.ok(failure, "The foreign release must produce an actionable mismatch error.");
  } finally {
    await f.close();
  }
});

test(
  "daemon stop must surface version refusal without marking or signalling the daemon",
  { timeout: 20_000 },
  async () => {
    const f = await fixture(false),
      signalMarker = path.join(f.parent, "signalled");
    // This is a test-owned dummy process, not a host service or a real daemon.
    const target = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(process.argv[1],'SIGTERM');process.exit(0)}); console.log('ready'); setInterval(()=>{},1000);",
        signalMarker,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(target.stdout!, "data");
      writeFileSync(daemonPidPath(f.userRoot, f.daemonId), `${target.pid}\n`);
      writeFileSync(daemonSingletonLockPath(f.userRoot, f.daemonId), `${target.pid}\n`);
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.startsWith("HARNESS_")) delete env[key];
      if (fixtureDaemonHello().build.commit) env.HARNESS_BUILD_COMMIT = fixtureDaemonHello().build.commit!;
      env.HARNESS_DAEMON_USER_ROOT = f.userRoot;
      env.HARNESS_DAEMON_ID = f.daemonId;
      const cli = spawn(
        process.execPath,
        [
          "packages/cli/src/index.ts",
          "daemon",
          "stop",
          "--user-root",
          f.userRoot,
          "--daemon-id",
          f.daemonId,
          "--root",
          f.parent,
          "--json",
        ],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      cli.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      cli.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const [exitCode] = await once(cli, "close");
      const stoppedMarker = daemonPidPath(f.userRoot, f.daemonId).replace(/\.pid$/u, ".stopped");
      const observed = {
        exitCode,
        stdout,
        stderr,
        signalSent: existsSync(signalMarker),
        stoppedMarker: existsSync(stoppedMarker),
        methods: f.methods,
      };
      console.log(JSON.stringify(observed));
      assert.equal(observed.signalSent, false, JSON.stringify(observed));
      assert.equal(observed.stoppedMarker, false, JSON.stringify(observed));
      assert.notEqual(exitCode, 0, stdout);
      assert.match(stdout, /daemon_version_mismatch/u);
      assert.deepEqual(
        f.methods,
        ["protocol.hello", "daemon.stop"],
        "The fixture must reach the explicit stop refusal.",
      );
    } finally {
      if (target.exitCode === null && target.signalCode === null) {
        const exited = once(target, "exit");
        target.kill("SIGKILL");
        await exited;
      }
      await f.close();
    }
  },
);

test("ordinary CLI requests preserve release mismatch as their error code", async () => {
  const f = await fixture(true);
  try {
    writeFileSync(
      path.join(f.userRoot, "registry.json"),
      JSON.stringify({
        schema: "harness-daemon-registry/v2",
        connections: [{ id: "local", kind: "local", displayName: "Test", state: "enabled" }],
        repos: [
          {
            repoId: "release-skew",
            canonicalRoot: f.parent,
            displayName: "Release skew",
            authoredBranch: "main",
            mode: "local",
            connectionId: "local",
            state: "enabled",
            registeredAt: "2026-11-03T00:00:00.000Z",
          },
        ],
      }),
    );
    mkdirSync(path.join(f.parent, "harness"));
    writeFileSync(
      path.join(f.parent, "harness/harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("HARNESS_")) delete env[key];
    Object.assign(env, { HARNESS_DAEMON_USER_ROOT: f.userRoot, HARNESS_DAEMON_ID: f.daemonId });
    const cli = spawn(process.execPath, ["packages/cli/src/index.ts", "--root", f.parent, "task", "list", "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    cli.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    cli.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const [status] = await once(cli, "close");
    assert.equal(status, 1, stderr + stdout);
    assert.equal(JSON.parse(stdout).code, "daemon_version_mismatch", stdout);
    assert.deepEqual(f.methods, ["protocol.hello"]);
  } finally {
    await f.close();
  }
});
