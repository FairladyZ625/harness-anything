// harness-test-tier: integration
import test from "node:test";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { createRuntimeCallbackRelay } from "@harness-anything/daemon/internal/runtime-callback-relay";
import { perUserSocketRoot } from "@harness-anything/daemon/internal/client/local-daemon-target";
import { currentDaemonProtocolVersion } from "@harness-anything/daemon/internal/protocol/version";
import * as shared from "./daemon-autostart-cli.fixture.ts";

const {
  assert,
  cli,
  cliEnv,
  localUserDaemonEndpoint,
  mkdirSync,
  mkdtempSync,
  path,
  realpathSync,
  registerDaemonRepo,
  rmSync,
  run,
  seedSettingsEvent,
  spawn,
  tmpdir,
  writeFileSync,
} = shared;

interface RelayFixture {
  readonly root: string;
  readonly userRoot: string;
  readonly repoId: string;
  readonly env: NodeJS.ProcessEnv;
  readonly relay: ReturnType<typeof createRuntimeCallbackRelay>;
}

interface CliResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// A sealed runtime receives the daemon route from its dispatcher: the relay endpoint, the repo id
// and the canonical root are already bound to that dispatch. The host registry that names them
// lives outside the runtime sandbox, so a read-only command must not need it.
async function relayFixture(): Promise<RelayFixture> {
  const fixture = shared.setup(),
    repoId = "relay-read",
    dispatchId = `dispatch_${randomBytes(12).toString("hex")}`,
    canonicalRoot = realpathSync.native(fixture.root),
    endpoint = localUserDaemonEndpoint(fixture.userRoot, "default"),
    relayPath = path.join(perUserSocketRoot(), `r-${dispatchId.slice("dispatch_".length)}.sock`),
    workerHome = path.join(fixture.parent, "worker", "home"),
    sealedUserRoot = path.join(fixture.parent, "sealed-user");
  seedSettingsEvent({ rootDir: fixture.root, repoId });
  registerDaemonRepo({
    canonicalRoot: fixture.root,
    repoId,
    userRoot: fixture.userRoot,
    createConvenienceLinks: false,
  });
  assert.equal(run(fixture.root, fixture.userRoot, ["daemon", "start", "--service"]).ok, true);
  mkdirSync(workerHome, { recursive: true });
  // The injected user root exists but its registry cannot be read: registry.json is a directory, so
  // every read fails the same way a sandbox-denied host path does, for any test uid.
  mkdirSync(path.join(sealedUserRoot, "registry.json"), { recursive: true });
  const relay = createRuntimeCallbackRelay({
    dispatchId,
    route: { userRoot: fixture.userRoot, daemonId: "default", endpoint },
    relayPath,
  });
  await relay.start();
  const {
      HARNESS_DAEMON_USER_ROOT: _userRoot,
      HARNESS_DAEMON_RELAY: _relay,
      ...base
    } = cliEnv(fixture.root, fixture.userRoot),
    env = {
      ...base,
      HOME: workerHome,
      HARNESS_ACTOR: "agent:runtime-session:relay-read",
      HARNESS_TASK_BOUND: "1",
      HARNESS_DAEMON_USER_ROOT: sealedUserRoot,
      HARNESS_DAEMON_ENDPOINT: relayPath,
      HARNESS_DAEMON_RELAY: "1",
      HARNESS_CANONICAL_ROOT: canonicalRoot,
      HARNESS_DAEMON_REPO_ID: repoId,
      HARNESS_DAEMON_ID: "default",
    };
  return { ...fixture, repoId, env, relay };
}

// The relay socket is served by this test process, so the child must run asynchronously: a
// spawnSync would hold the event loop that accepts and forwards its connection.
function runCli(root: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

interface FakeDaemon {
  readonly path: string;
  readonly methods: string[];
  close: () => Promise<void>;
}

// A minimal JSON-RPC peer that answers hello and records every method it was asked for. Two of them
// per test tell the fixed relay apart from the implicit user socket: only the relay may be used.
async function startFakeDaemon(socketPath: string): Promise<FakeDaemon> {
  mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const methods: string[] = [],
    sockets = new Set<net.Socket>(),
    server = net.createServer((client) => {
      sockets.add(client);
      client.setEncoding("utf8");
      let remainder = "";
      client.on("data", (chunk: string) => {
        remainder += chunk;
        for (let newline = remainder.indexOf("\n"); newline >= 0; newline = remainder.indexOf("\n")) {
          const frame = remainder.slice(0, newline);
          remainder = remainder.slice(newline + 1);
          if (!frame.trim()) continue;
          const request = JSON.parse(frame) as { readonly id?: number; readonly method?: string };
          methods.push(request.method ?? "");
          const result =
            request.method === "protocol.hello"
              ? {
                  ok: true,
                  protocolVersion: currentDaemonProtocolVersion,
                  methods: ["repo.task.read"],
                  build: { commit: null },
                }
              : { ok: true, command: "task-list", outcome: "applied", opId: "read:relay-fleet" };
          client.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
        }
      });
      client.on("error", () => client.destroy());
      client.on("close", () => sockets.delete(client));
    });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    path: socketPath,
    methods,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(socketPath, { force: true });
    },
  };
}

function fleetWorkspace(): { readonly root: string; readonly userRoot: string } {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "ha-relay-fleet-"))),
    userRoot = path.join(root, "sealed-user");
  // The workspace declares a remote-edge fleet channel; the host registry is unreadable.
  writeFileSync(
    path.join(root, "fleet-edge.json"),
    `${JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId: "relay-fleet",
      host: "center.invalid",
      port: 7443,
      caPath: "/fleet/ca.pem",
      nodeId: "edge-one",
      credential: "machine-secret",
      viewRoot: path.join(root, "view"),
      quotaBytes: 64 * 1024 * 1024,
    })}\n`,
  );
  mkdirSync(path.join(userRoot, "registry.json"), { recursive: true });
  return { root, userRoot };
}

function fleetEnv(input: {
  readonly root: string;
  readonly userRoot: string;
  readonly relayPath: string;
}): NodeJS.ProcessEnv {
  const {
    HARNESS_DAEMON_USER_ROOT: _userRoot,
    HARNESS_DAEMON_RELAY: _relay,
    ...base
  } = cliEnv(input.root, input.userRoot);
  return {
    ...base,
    HARNESS_ACTOR: "agent:runtime-session:relay-fleet",
    HARNESS_TASK_BOUND: "1",
    HARNESS_DAEMON_USER_ROOT: input.userRoot,
    HARNESS_DAEMON_ENDPOINT: input.relayPath,
    HARNESS_DAEMON_RELAY: "1",
    HARNESS_CANONICAL_ROOT: input.root,
    HARNESS_DAEMON_REPO_ID: "relay-fleet",
    HARNESS_DAEMON_ID: "default",
  };
}

function restoreTemp(previousTemp: string | undefined): void {
  if (previousTemp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTemp;
}

test("read-only CLI commands route through the runtime callback relay without reading the host registry", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = await relayFixture();
  try {
    const listed = await runCli(fixture.root, ["task", "list"], fixture.env);
    assert.equal(listed.status, 0, `${listed.stderr}\n${listed.stdout}`);
    assert.equal((JSON.parse(listed.stdout) as { readonly outcome?: string }).outcome, "applied");

    const settings = await runCli(fixture.root, ["settings", "read"], fixture.env);
    assert.equal(settings.status, 0, `${settings.stderr}\n${settings.stdout}`);
    const settingsReceipt = JSON.parse(settings.stdout) as { readonly settings?: { readonly locale?: string } };
    assert.equal(settingsReceipt.settings?.locale, "en-US");
  } finally {
    await fixture.relay.stop();
    restoreTemp(previousTemp);
  }
});

test("a relay route missing its repo id is refused as a route error instead of daemon_unavailable", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = await relayFixture();
  try {
    const { HARNESS_DAEMON_REPO_ID: _repoId, ...missingRepo } = fixture.env;
    const refused = await runCli(fixture.root, ["task", "list"], missingRepo);
    assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
    const receipt = JSON.parse(refused.stdout) as {
      readonly error?: { readonly code?: string };
      readonly outcome?: string;
      readonly diagnostic?: { readonly expectation?: string };
    };
    assert.equal(receipt.error?.code, "daemon_target_conflict");
    assert.equal(receipt.outcome, "op_rejected");
    assert.match(String(receipt.diagnostic?.expectation), /Relay daemon route rejected: HARNESS_DAEMON_REPO_ID/u);
    // The rejected route never falls back to the host socket: the command produced a receipt
    // instead of reaching the daemon that owns the sealed user root.
    assert.doesNotMatch(refused.stdout + refused.stderr, /daemon_unavailable/u);
  } finally {
    await fixture.relay.stop();
    restoreTemp(previousTemp);
  }
});

test("a relayed remote-edge fleet command forwards through the fixed relay, never the user socket", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const { root, userRoot } = fleetWorkspace(),
    relay = await startFakeDaemon(path.join(perUserSocketRoot(), `r-${randomBytes(12).toString("hex")}.sock`)),
    rawSocket = await startFakeDaemon(localUserDaemonEndpoint(userRoot, "default"));
  try {
    const result = await runCli(root, ["task", "list"], { ...fleetEnv({ root, userRoot, relayPath: relay.path }) });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal((JSON.parse(result.stdout) as { readonly outcome?: string }).outcome, "applied");
    assert.deepEqual(
      relay.methods,
      ["protocol.hello", "repo.task.read"],
      "the fleet payload must cross the injected relay",
    );
    assert.deepEqual(rawSocket.methods, [], "the implicit user socket must not be opened");
  } finally {
    await relay.close();
    await rawSocket.close();
    rmSync(root, { recursive: true, force: true });
    restoreTemp(previousTemp);
  }
});

test("a relayed remote-edge fleet command missing its endpoint is refused before any socket", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const { root, userRoot } = fleetWorkspace(),
    relay = await startFakeDaemon(path.join(perUserSocketRoot(), `r-${randomBytes(12).toString("hex")}.sock`)),
    rawSocket = await startFakeDaemon(localUserDaemonEndpoint(userRoot, "default"));
  try {
    const { HARNESS_DAEMON_ENDPOINT: _endpoint, ...noEndpoint } = fleetEnv({
      root,
      userRoot,
      relayPath: relay.path,
    });
    const refused = await runCli(root, ["task", "list"], noEndpoint);
    assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
    const receipt = JSON.parse(refused.stdout) as {
      readonly error?: { readonly code?: string };
      readonly diagnostic?: { readonly expectation?: string };
    };
    assert.equal(receipt.error?.code, "daemon_target_conflict");
    assert.match(String(receipt.diagnostic?.expectation), /HARNESS_DAEMON_ENDPOINT is not set/u);
    assert.deepEqual(relay.methods, [], "no relay request without an injected endpoint");
    assert.deepEqual(rawSocket.methods, [], "no fallback to the implicit user socket");
  } finally {
    await relay.close();
    await rawSocket.close();
    rmSync(root, { recursive: true, force: true });
    restoreTemp(previousTemp);
  }
});

test("a relayed remote-edge fleet command cannot override the dispatched repo", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const { root, userRoot } = fleetWorkspace(),
    relay = await startFakeDaemon(path.join(perUserSocketRoot(), `r-${randomBytes(12).toString("hex")}.sock`)),
    rawSocket = await startFakeDaemon(localUserDaemonEndpoint(userRoot, "default"));
  try {
    const refused = await runCli(
      root,
      ["--repo", "another-repo", "task", "list"],
      fleetEnv({ root, userRoot, relayPath: relay.path }),
    );
    assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
    const receipt = JSON.parse(refused.stdout) as {
      readonly error?: { readonly code?: string };
      readonly diagnostic?: { readonly expectation?: string };
    };
    assert.equal(receipt.error?.code, "daemon_target_conflict");
    assert.match(String(receipt.diagnostic?.expectation), /does not match the dispatched repo/u);
    assert.deepEqual(relay.methods, [], "a rejected scope must not reach the relay");
    assert.deepEqual(rawSocket.methods, [], "a rejected scope must not reach the user socket");
  } finally {
    await relay.close();
    await rawSocket.close();
    rmSync(root, { recursive: true, force: true });
    restoreTemp(previousTemp);
  }
});

test("an unreadable registry reports a registry failure, not daemon_unavailable", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = await relayFixture();
  try {
    const { HARNESS_DAEMON_ENDPOINT: _endpoint, HARNESS_DAEMON_RELAY: _relay, ...directEnv } = fixture.env;
    const refused = await runCli(fixture.root, ["task", "list"], directEnv);
    assert.notEqual(refused.status, 0, `${refused.stderr}\n${refused.stdout}`);
    const receipt = JSON.parse(refused.stdout) as {
      readonly error?: { readonly code?: string };
      readonly diagnostic?: { readonly expectation?: string };
    };
    assert.equal(receipt.error?.code, "daemon_registry_unreadable");
    assert.match(String(receipt.diagnostic?.expectation), /local daemon registry could not be read/u);
    assert.doesNotMatch(refused.stdout + refused.stderr, /daemon_unavailable/u);
  } finally {
    await fixture.relay.stop();
    restoreTemp(previousTemp);
  }
});
