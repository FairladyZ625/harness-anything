import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = path.resolve(import.meta.dirname, "../../..");
const parent = mkdtempSync(path.join(tmpdir(), "ha-daemon-package-"));
const consumer = path.join(parent, "consumer");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HARNESS_")));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args, cwd = repository) {
  console.log(JSON.stringify({ command, args, cwd }));
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000 });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  console.log(`exit=${result.status}`);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
}
try {
  mkdirSync(consumer);
  writeFileSync(path.join(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  run(npm, ["pack", "-w", "@harness-anything/daemon", "--pack-destination", parent]);
  run(npm, ["pack", "-w", "@harness-anything/cli", "--pack-destination", parent]);
  run(
    npm,
    [
      "install",
      "--no-audit",
      "--no-fund",
      path.join(parent, "harness-anything-daemon-0.0.1.tgz"),
      path.join(parent, "harness-anything-cli-0.0.1.tgz"),
    ],
    consumer,
  );
  const cli = path.join(consumer, "node_modules/@harness-anything/cli/dist/cli/src/index.js");
  const cliArgs = ["--user-root", path.join(parent, "cli-user"), "--daemon-id", "cli-smoke", "--json"];
  run(process.execPath, [cli, "daemon", "start", "--service", ...cliArgs], consumer);
  try {
    const status = JSON.parse(run(process.execPath, [cli, "daemon", "status", ...cliArgs], consumer));
    assert.equal(status.ok, true);
    assert.equal(status.entry, "dist");
    console.log("installed CLI status exit=0; daemon start --service and protocol hello=true");
  } finally {
    run(process.execPath, [cli, "daemon", "stop", ...cliArgs], consumer);
  }
  const installed = path.join(consumer, "node_modules/@harness-anything/daemon");
  const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
  const entry = path.join(installed, manifest.bin["harness-anything-daemon"]);
  const load = (file) => import(pathToFileURL(path.join(installed, "dist/daemon/src", file)).href);
  const { localUserDaemonEndpoint } = await load("client/local-daemon-target.js");
  const { openDaemonJsonRpcClientAt } = await load("client/local-json-rpc-client.js");
  const { currentDaemonProtocolVersion } = await load("protocol/version.js");
  const { dispatchStreamPath } = await load("dispatch-stream.js");
  for (const mode of ["serve", "--service"]) {
    const userRoot = path.join(parent, mode.replaceAll("-", ""));
    const args = [entry, mode, "--user-root", userRoot, "--daemon-id", "smoke"];
    console.log(JSON.stringify({ command: process.execPath, args, cwd: consumer }));
    const child = spawn(process.execPath, args, { cwd: consumer, env, stdio: ["ignore", "pipe", "pipe"] });
    const exited = once(child, "exit");
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    let client;
    try {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline && !client; ) {
        assert.equal(child.exitCode, null, output);
        try {
          client = await openDaemonJsonRpcClientAt(localUserDaemonEndpoint(userRoot, "smoke"), 100, 1_000);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      assert.ok(client, output);
      const hello = await client.request("protocol.hello", { protocolVersion: currentDaemonProtocolVersion }, 2_000);
      assert.equal(hello.ok, true);
      console.log(JSON.stringify({ mode, hello: hello.ok, protocolVersion: hello.protocolVersion }));
      const deferred = run(process.execPath, args, consumer);
      assert.equal(JSON.parse(deferred).outcome, "deferred");
      const stopped = await client.request("daemon.stop", {}, 5_000);
      assert.equal(stopped.ok, true);
      client.close();
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error("daemon did not stop")), 10_000);
          timer.unref();
        }),
      ]);
      assert.equal(result[0], 0, output);
      console.log(`${mode} exit=0; hello=true; singleton deferred; cooperative stop=true`);
    } finally {
      client?.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }
  const rootDir = path.join(parent, "worker");
  const dispatchId = "dispatch_0123456789abcdef01234567";
  const stream = dispatchStreamPath(rootDir, dispatchId);
  mkdirSync(path.dirname(stream), { recursive: true });
  writeFileSync(stream, "");
  const args = [entry, "--runtime-worker-host"];
  console.log(JSON.stringify({ command: process.execPath, args, cwd: consumer }));
  const worker = spawn(process.execPath, args, { cwd: consumer, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(worker, "exit");
  let errors = "";
  worker.stderr.on("data", (data) => {
    errors += data;
  });
  worker.stdin.end(
    JSON.stringify({
      rootDir,
      dispatchId,
      executablePath: process.execPath,
      args: [
        "-e",
        'let prompt=""; process.stdin.on("data", chunk => prompt += chunk); process.stdin.on("end", () => console.log(JSON.stringify({hello:prompt})));',
      ],
      cwd: consumer,
      env,
      prompt: "package-worker-smoke",
      windowsVerbatimArguments: false,
    }),
  );
  try {
    const result = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("worker did not exit")), 30_000);
        timer.unref();
      }),
    ]);
    assert.equal(result[0], 0, errors);
    const records = readFileSync(stream, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(
      records.some((record) => record.kind === "provider_event" && record.event.hello === "package-worker-smoke"),
    );
    assert.ok(records.some((record) => record.kind === "process_exit" && record.exitCode === 0));
    console.log(
      "--runtime-worker-host exit=0; provider hello=true; persisted process_exit=0; protocol.hello=N/A (stdio worker)",
    );
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    await exited;
  }
  console.log(`Daemon package smoke passed; pack/install directory: ${parent}`);
} finally {
  rmSync(parent, { recursive: true, force: true });
}
