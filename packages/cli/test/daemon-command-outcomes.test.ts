// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { localUserDaemonEndpoint } from "../../daemon/src/index.ts";
import { cliTestEnv } from "./helpers/cli-test-env.ts";
import { defaultDaemonUserRoot, runRawJson, withTempRootAsync } from "./helpers/daemon-cli.ts";
import { closeServer, listen } from "./helpers/daemon-transport.ts";

const cliEntry = path.resolve("packages/cli/src/index.ts");
const execFileAsync = promisify(execFile);

test("a timed-out write reports an unknown outcome after the daemon accepted the request", { skip: process.platform === "win32" }, async () => {
  await withSocketTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"]);
    const daemon = testDaemonLocation(rootDir);
    let acceptedRequest = false;
    const server = await startCommandServer(daemon, (request, socket) => {
      assert.equal(request.method, "repo.command.run");
      acceptedRequest = true;
      socket.on("error", () => undefined);
    });
    try {
      const result = await runCliFailure(rootDir, ["task", "create", "--title", "Committed Before Lost Response"], {
        ...testDaemonEnv(daemon),
        HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "40"
      });

      assert.equal(acceptedRequest, true, "the server must accept the write before the client times out");
      assert.equal(result.error.code, "daemon_request_outcome_unknown");
      assert.match(result.error.hint, /outcome is unknown/iu);
      assert.match(result.error.hint, /write may already have taken effect/iu);
      assert.match(result.error.hint, /Do not rerun this write blindly/iu);
      assert.match(result.error.hint, /ha task list/iu);
      assert.doesNotMatch(result.error.hint, /Daemon unavailable/iu);
      assert.doesNotMatch(result.error.hint, /HARNESS_DAEMON_MODE=direct/iu);
    } finally {
      await closeServer(server);
    }
  });
});

test("a daemon JSON-RPC rejection remains a known request failure", { skip: process.platform === "win32" }, async () => {
  await withSocketTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"]);
    const daemon = testDaemonLocation(rootDir);
    const server = await startCommandServer(daemon, (request, socket) => {
      socket.end(`${JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: "write rejected by fixture" }
      })}\n`);
    });
    try {
      const result = await runCliFailure(rootDir, ["task", "create", "--title", "Rejected Write"], {
        ...testDaemonEnv(daemon)
      });

      assert.equal(result.error.code, "write_rejected");
      assert.match(result.error.hint, /Daemon JSON-RPC request failed/iu);
      assert.doesNotMatch(result.error.hint, /outcome is unknown/iu);
      assert.doesNotMatch(result.error.hint, /Daemon unavailable/iu);
    } finally {
      await closeServer(server);
    }
  });
});

test("a timed-out local materializer request keeps its intentional local fallback", { skip: process.platform === "win32" }, async () => {
  await withSocketTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"]);
    const daemon = testDaemonLocation(rootDir);
    let acceptedRequest = false;
    const server = await startCommandServer(daemon, (request, socket) => {
      assert.equal(request.method, "repo.command.run");
      acceptedRequest = true;
      socket.on("error", () => undefined);
    });
    try {
      const result = await runCli(rootDir, ["materializer", "run", "--dry-run"], {
        ...testDaemonEnv(daemon),
        HARNESS_DAEMON_REQUEST_TIMEOUT_MS: "40"
      });

      assert.equal(acceptedRequest, true, "the materializer request must reach the daemon before timing out");
      assert.equal(result.ok, true);
      assert.equal(result.command, "materializer run");
    } finally {
      await closeServer(server);
    }
  });
});

test("an unreachable daemon remains unavailable with the direct recovery guidance", { skip: process.platform === "win32" }, async () => {
  await withTempRootAsync(async (rootDir) => {
    runRawJson(rootDir, ["init"]);
    const unreachableUserRoot = path.join(rootDir, "u".repeat(180));
    const daemon = testDaemonLocation(rootDir, unreachableUserRoot);
    const result = await runCliFailure(rootDir, ["task", "create", "--title", "Unreachable Write"], {
      ...testDaemonEnv(daemon),
      HARNESS_DAEMON_AUTOSTART_TIMEOUT_MS: "40"
    });

    assert.equal(result.error.code, "journal_unavailable");
    assert.match(result.error.hint, /Daemon unavailable/iu);
    assert.match(result.error.hint, /HARNESS_DAEMON_MODE=direct/iu);
    assert.doesNotMatch(result.error.hint, /outcome is unknown/iu);
  });
});

async function startCommandServer(
  daemon: TestDaemonLocation,
  onRequest: (request: { readonly id: number; readonly method: string }, socket: net.Socket) => void
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
      while (true) {
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        const request = JSON.parse(input.slice(0, newline)) as { readonly id: number; readonly method: string };
        input = input.slice(newline + 1);
        if (request.method === "protocol.hello") {
          socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`);
          continue;
        }
        onRequest(request, socket);
      }
    });
  });
  await listen(server, daemon.socketPath);
  return server;
}

interface TestDaemonLocation {
  readonly userRoot: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
}

function testDaemonLocation(
  rootDir: string,
  userRoot = path.join(rootDir, ".outcome-daemon-user")
): TestDaemonLocation {
  const runtimeDir = path.join(rootDir, ".daemon-runtime");
  const socketPath = localUserDaemonEndpoint(userRoot, "default", process.platform, {
    env: { XDG_RUNTIME_DIR: runtimeDir, TMPDIR: runtimeDir }
  });
  const relativeSocketPath = path.relative(rootDir, socketPath);
  assert.equal(
    relativeSocketPath !== "" && !relativeSocketPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeSocketPath),
    true,
    `test daemon socket must stay beneath its temporary root: ${socketPath}`
  );
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  return { userRoot, runtimeDir, socketPath };
}

function testDaemonEnv(daemon: TestDaemonLocation): Readonly<Record<string, string>> {
  return {
    HARNESS_DAEMON_USER_ROOT: daemon.userRoot,
    XDG_RUNTIME_DIR: daemon.runtimeDir,
    TMPDIR: daemon.runtimeDir
  };
}

async function withSocketTempRootAsync<T>(fn: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = mkdtempSync("/tmp/ha-rpc-");
  try {
    return await fn(rootDir);
  } finally {
    rmSync(rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

async function runCliFailure(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): Promise<{ readonly error: { readonly code: string; readonly hint: string } }> {
  try {
    await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
      encoding: "utf8",
      env: cliTestEnv({
        HOME: path.join(rootDir, ".home"),
        GIT_CONFIG_GLOBAL: "/dev/null",
        HARNESS_DAEMON_MODE: "local",
        HARNESS_DAEMON_USER_ROOT: defaultDaemonUserRoot(rootDir),
        ...env
      })
    });
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error ? String(error.stdout) : "";
    assert.notEqual(stdout, "", `expected JSON failure receipt: ${String(error)}`);
    return JSON.parse(stdout) as { readonly error: { readonly code: string; readonly hint: string } };
  }
  assert.fail("expected CLI command to fail");
}

async function runCli(
  rootDir: string,
  args: ReadonlyArray<string>,
  env: Readonly<Record<string, string>> = {}
): Promise<{ readonly ok: boolean; readonly command: string }> {
  const { stdout } = await execFileAsync(process.execPath, [cliEntry, "--root", rootDir, "--json", ...args], {
    encoding: "utf8",
    env: cliTestEnv({
      HOME: path.join(rootDir, ".home"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      HARNESS_DAEMON_MODE: "local",
      HARNESS_DAEMON_USER_ROOT: defaultDaemonUserRoot(rootDir),
      ...env
    })
  });
  return JSON.parse(stdout) as { readonly ok: boolean; readonly command: string };
}
