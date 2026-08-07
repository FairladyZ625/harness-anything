// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { readDaemonRegistry } from "../../kernel/src/index.ts";
import { defaultDaemonUserRoot } from "./helpers/daemon-cli.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { createFixture } from "./production-authority-canonical-ingress/fixture.ts";

const execFileAsync = promisify(execFile);

test("occupied daemon socket does not persist a new authority manifest registry pointer", { timeout: 30_000 }, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const endpoint = localUserDaemonEndpoint(userRoot);
  const ownerSockets = new Set<net.Socket>();
  const owner = net.createServer((socket) => {
    ownerSockets.add(socket);
    socket.once("close", () => ownerSockets.delete(socket));
  });
  try {
    mkdirSync(userRoot, { recursive: true });
    const registryBefore = readDaemonRegistry({ userRoot });
    await new Promise<void>((resolve, reject) => {
      owner.once("error", reject);
      owner.listen(endpoint, () => resolve());
    });
    writeFileSync(`${endpoint}.owner`, JSON.stringify({
      schema: "daemon-socket-owner/v1",
      pid: process.pid,
      ownerToken: "occupied-socket-test-owner"
    }));

    await assert.rejects(execFileAsync(process.execPath, [
      path.resolve("packages/cli/src/index.ts"),
      "--root", fixture.repoRoot,
      "daemon", "serve",
      "--repo", "canonical",
      "--socket", endpoint,
      "--user-root", userRoot,
      "--authority-manifest", fixture.manifestPath
    ], {
      encoding: "utf8",
      env: cliTestEnv({ HARNESS_DAEMON_USER_ROOT: userRoot }),
      timeout: 10_000,
      killSignal: "SIGKILL"
    }), /already owned/u);

    assert.deepEqual(readDaemonRegistry({ userRoot }), registryBefore);
  } finally {
    for (const socket of ownerSockets) socket.destroy();
    if (owner.listening) await new Promise<void>((resolve) => owner.close(() => resolve()));
    rmSync(`${endpoint}.owner`, { force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    assertDaemonSocketNamespaceEmpty(endpoint);
  }
});

test("transport bind failure uses the shared namespace diagnosis without persisting registry change", {
  skip: process.platform === "win32",
  timeout: 30_000
}, async () => {
  const fixture = createFixture();
  const userRoot = defaultDaemonUserRoot(fixture.root);
  const endpoint = localUserDaemonEndpoint(userRoot);
  try {
    mkdirSync(userRoot, { recursive: true });
    mkdirSync(endpoint);
    const registryBefore = readDaemonRegistry({ userRoot });

    await assert.rejects(
      execFileAsync(process.execPath, [
        path.resolve("packages/cli/src/index.ts"),
        "--root", fixture.repoRoot,
        "daemon", "serve",
        "--repo", "canonical",
        "--socket", endpoint,
        "--user-root", userRoot,
        "--authority-manifest", fixture.manifestPath
      ], {
        encoding: "utf8",
        env: cliTestEnv({ HARNESS_DAEMON_USER_ROOT: userRoot }),
        timeout: 10_000,
        killSignal: "SIGKILL"
      }),
      new RegExp(
        `DAEMON_SOCKET_NAMESPACE_INVALID:path=${escapeRegExp(endpoint)};shape=directory;owner=live-pid-[0-9]+;cleanup=not-attempted;connectCode=(?:ERR_FS_EISDIR|EISDIR)`,
        "u"
      )
    );

    assert.deepEqual(readDaemonRegistry({ userRoot }), registryBefore);
    assert.equal(existsSync(`${endpoint}.owner`), false);
  } finally {
    rmSync(endpoint, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
    assertDaemonSocketNamespaceEmpty(endpoint);
  }
});

function assertDaemonSocketNamespaceEmpty(endpoint: string): void {
  const directory = path.dirname(endpoint);
  const basename = path.basename(endpoint);
  const entries = readdirSync(directory)
    .filter((entry) => entry === basename || entry.startsWith(`${basename}.`))
    .sort();
  assert.deepEqual(entries, [], `test leaked daemon socket namespace entries for ${endpoint}: ${JSON.stringify(entries)}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
