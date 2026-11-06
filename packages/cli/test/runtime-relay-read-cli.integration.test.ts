// harness-test-tier: integration
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createRuntimeCallbackRelay } from "@harness-anything/daemon/internal/runtime-callback-relay";
import { perUserSocketRoot } from "@harness-anything/daemon/internal/client/local-daemon-target";
import * as shared from "./daemon-autostart-cli.fixture.ts";

const {
  assert,
  cli,
  cliEnv,
  localUserDaemonEndpoint,
  mkdirSync,
  path,
  realpathSync,
  registerDaemonRepo,
  run,
  seedSettingsEvent,
  spawn,
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
function runCli(
  fixture: RelayFixture,
  args: readonly string[],
  env: NodeJS.ProcessEnv = fixture.env,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--root", fixture.root, "--json", ...args], {
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

test("read-only CLI commands route through the runtime callback relay without reading the host registry", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = await relayFixture();
  try {
    const listed = await runCli(fixture, ["task", "list"]);
    assert.equal(listed.status, 0, `${listed.stderr}\n${listed.stdout}`);
    assert.equal((JSON.parse(listed.stdout) as { readonly outcome?: string }).outcome, "applied");

    const settings = await runCli(fixture, ["settings", "read"]);
    assert.equal(settings.status, 0, `${settings.stderr}\n${settings.stdout}`);
    const settingsReceipt = JSON.parse(settings.stdout) as { readonly settings?: { readonly locale?: string } };
    assert.equal(settingsReceipt.settings?.locale, "en-US");
  } finally {
    await fixture.relay.stop();
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});

test("a relay route missing its repo id is refused as a route error instead of daemon_unavailable", async () => {
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = "/tmp";
  const fixture = await relayFixture();
  try {
    const { HARNESS_DAEMON_REPO_ID: _repoId, ...missingRepo } = fixture.env;
    const refused = await runCli(fixture, ["task", "list"], missingRepo);
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
    if (previousTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTemp;
  }
});
