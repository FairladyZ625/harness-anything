// harness-test-tier: fast
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  daemonIdForUserRoot,
  defaultNamedPipePath,
  encodeLengthPrefixedFrame,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath,
  type SshAuthorityWireBootstrapFrame
} from "../../daemon/src/index.ts";
import {
  resolveSshForcedCommandAuthentication,
  runDaemonConnect
} from "../src/commands/daemon/connect.ts";
import { createDaemonLocalTransport } from "@harness-anything/daemon";
import { hasPrivilegedSshdAncestor } from "../src/commands/daemon/sshd-witness.ts";
import {
  commandRunPayload,
  daemonClientCliEntrypointPath,
  remoteDaemonUnavailableHint,
  remoteDaemonSshArgs,
  type RemoteDaemonConfig
} from "../src/daemon/client.ts";
import { parseArgs } from "../src/cli/parse-args.ts";

test("daemon client resolves its CLI entrypoint across native path separators", () => {
  const clientPath = fileURLToPath(new URL("../src/daemon/client.ts", import.meta.url));
  const expectedEntrypoint = path.resolve(path.dirname(clientPath), "../index.ts");

  assert.equal(daemonClientCliEntrypointPath(), expectedEntrypoint);
  assert.equal(
    daemonClientCliEntrypointPath("file:///C:/workspace/packages/cli/dist/daemon/client.js"),
    fileURLToPath("file:///C:/workspace/packages/cli/dist/index.js")
  );
});

test("daemon endpoint selection uses a named pipe on Windows and a unix socket on POSIX", () => {
  const userRoot = "/srv/harness-user";
  const daemonId = "team";
  assert.equal(
    localUserDaemonEndpoint(userRoot, daemonId, "win32"),
    defaultNamedPipePath(daemonIdForUserRoot(userRoot, daemonId))
  );
  assert.equal(
    localUserDaemonEndpoint(userRoot, daemonId, "linux"),
    localUserDaemonSocketPath(userRoot, daemonId, { platform: "linux" })
  );
});

test("daemon client resolves the same Linux per-user runtime socket authority", () => {
  const userRoot = "/srv/harness-user";
  const daemonId = "team";
  const runtimeDir = "/run/user/1234";
  const pathOptions = {
    env: { XDG_RUNTIME_DIR: runtimeDir },
    linuxRuntimeRoot: "/missing-run-user",
    tmpdir: "/shared-tmp",
    uid: 1234
  };

  assert.equal(
    localUserDaemonEndpoint(userRoot, daemonId, "linux", pathOptions),
    localUserDaemonSocketPath(userRoot, daemonId, { ...pathOptions, platform: "linux" })
  );
  assert.equal(
    localUserDaemonEndpoint(userRoot, daemonId, "linux", pathOptions).startsWith(`${runtimeDir}/harness-anything/`),
    true
  );
});

test("daemon serve transport wires the selected endpoint to the platform adapter", () => {
  const createProtocolServer = () => {
    throw new Error("not used by adapter selection test");
  };
  const windows = createDaemonLocalTransport({
    daemonId: "daemon-test",
    endpoint: "\\\\.\\pipe\\daemon-test",
    platform: "win32",
    createProtocolServer,
    acceptSshForcedCommand: () => false
  });
  const posix = createDaemonLocalTransport({
    daemonId: "daemon-test",
    endpoint: "/tmp/daemon-test.sock",
    platform: "linux",
    createProtocolServer,
    acceptSshForcedCommand: () => false
  });

  assert.equal(windows.kind, "named-pipe");
  assert.equal(windows.endpoint, "\\\\.\\pipe\\daemon-test");
  assert.equal(posix.kind, "unix-socket");
  assert.equal(posix.endpoint, "/tmp/daemon-test.sock");
});

test("remote mode invokes the pure connect subcommand without a runtime or client-selected root", () => {
  const remote: RemoteDaemonConfig = {
    host: "daemon.example.test",
    remoteHaPath: "/opt/harness/bin/ha",
    remoteRoot: "/srv/canonical",
    repoId: "canonical"
  };

  assert.deepEqual(remoteDaemonSshArgs(remote), [
    "daemon.example.test",
    "/opt/harness/bin/ha",
    "daemon",
    "connect",
    "--stdio"
  ]);
  assert.match(remoteDaemonUnavailableHint(remote), /Start the persistent daemon on daemon\.example\.test/iu);
  assert.match(remoteDaemonUnavailableHint(remote), /ha daemon start --service/iu);
});

test("remote command payloads do not attach the caller's local runtime session", () => {
  const parsed = parseArgs(["--root", "/srv/canonical", "task", "claim", "task_remote", "--execution"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const remotePayload = commandRunPayload(parsed.value);
  assert.equal(Object.hasOwn(remotePayload, "session"), false);

  const localPayload = commandRunPayload(parsed.value, {
    runtime: "codex",
    sessionId: "local-codex-session",
    source: "runtime",
    detectedAt: "2026-07-14T00:00:00.000Z"
  });
  assert.deepEqual(localPayload.session, {
    runtime: "codex",
    sessionId: "local-codex-session",
    source: "runtime",
    detectedAt: "2026-07-14T00:00:00.000Z"
  });
});

test("forced-command principal requires an unforgeable sshd process witness", () => {
  assert.throws(() => resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio", "--principal", "person_alice", "--expect-original-command", "ha daemon connect --stdio"],
    rootDir: "/srv/canonical",
    env: { SSH_ORIGINAL_COMMAND: "ha daemon connect --stdio", USER: "shared-harness" },
    verifySshdContext: () => false
  }), /root-owned sshd ancestor/iu);
});

test("after an independently tested sshd witness passes, principal comes from static argv rather than SSH_ORIGINAL_COMMAND or USER", () => {
  const authentication = resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio", "--principal", "person_alice", "--expect-original-command", "ha daemon connect --stdio"],
    rootDir: "/srv/canonical",
    env: { SSH_ORIGINAL_COMMAND: "ha daemon connect --stdio", USER: "person_mallory" },
    verifySshdContext: () => true
  });

  assert.deepEqual(authentication, { personId: "person_alice", canonicalRoot: path.resolve("/srv/canonical") });
});

test("forced-command principal rejects client-controlled privileged options in the original command", () => {
  assert.throws(() => resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio", "--principal", "person_alice", "--expect-original-command", "ha daemon connect --stdio"],
    rootDir: "/srv/canonical",
    env: { SSH_ORIGINAL_COMMAND: "ha --root /srv/other daemon connect --stdio --principal person_mallory" },
    verifySshdContext: () => true
  }), /does not match/iu);
});

test("SSH remote connect without a forced-command principal fails closed with configuration guidance", () => {
  assert.throws(() => resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio"],
    env: { SSH_ORIGINAL_COMMAND: "ha daemon connect --stdio" },
    verifySshdContext: () => true
  }), /authorized_keys/iu);
});

test("local connect without SSH context remains an owner-boundary relay", () => {
  assert.equal(resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio"],
    env: {},
    verifySshdContext: () => false
  }), undefined);
});

test("sshd witness requires a privileged sshd ancestor instead of a lookalike process", () => {
  const processTable = new Map([
    [42, { pid: 42, parentPid: 21, executable: "/bin/sh", privileged: false }],
    [21, { pid: 21, parentPid: 1, executable: "/usr/sbin/sshd", privileged: true }]
  ]);
  assert.equal(hasPrivilegedSshdAncestor(42, (pid) => processTable.get(pid)), true);

  const spoofedTable = new Map([
    [42, { pid: 42, parentPid: 21, executable: "/bin/sh", privileged: false }],
    [21, { pid: 21, parentPid: 1, executable: "/tmp/sshd", privileged: false }]
  ]);
  assert.equal(hasPrivilegedSshdAncestor(42, (pid) => spoofedTable.get(pid)), false);
});

test("authority-wire connect emits the versioned bootstrap then relays raw bytes without a runtime", async (t) => {
  if (process.platform === "win32") return;
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "ha-authority-connect-"));
  const endpoint = path.join(rootDir, "relay.sock");
  const authorityBytes = encodeLengthPrefixedFrame({
    type: "harness-authority-wire/v1",
    kind: "hello",
    requestId: "relay",
    connectionGeneration: 1
  });
  const received = new Promise<Buffer>((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffered = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const newline = buffered.indexOf(0x0a);
        if (newline < 0 || buffered.length < newline + 1 + authorityBytes.length) return;
        resolve(buffered);
        socket.end();
      });
      socket.once("error", reject);
    });
    server.once("error", reject);
    server.listen(endpoint);
    t.after(async () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }));
  });
  await waitForEndpoint(endpoint);
  const input = new PassThrough();
  const output = new PassThrough();
  const error = new PassThrough();
  input.end(authorityBytes);

  const exitCode = await runDaemonConnect([
    "daemon", "connect", "--stdio", "--authority-wire", "--socket", endpoint,
    "--principal", "person_alice", "--expect-original-command", "ha-authority-connect"
  ], {
    rootDir,
    env: { SSH_ORIGINAL_COMMAND: "ha-authority-connect" },
    streams: { input, output, error },
    verifySshdContext: () => true
  });
  const bytes = await received;
  const newline = bytes.indexOf(0x0a);
  const bootstrap = JSON.parse(bytes.subarray(0, newline).toString("utf8")) as SshAuthorityWireBootstrapFrame;

  assert.equal(exitCode, 0, error.read()?.toString());
  assert.deepEqual(bootstrap, {
    type: "harness-daemon.ssh-forced-command/v2",
    streamProtocol: "harness-authority-wire/v1",
    personId: "person_alice",
    canonicalRoot: path.resolve(rootDir)
  });
  assert.deepEqual(bytes.subarray(newline + 1), authorityBytes);
  assert.equal(existsSync(path.join(rootDir, "harness")), false);
});

test("authority-wire connect requires authenticated forced-command inputs", async () => {
  const error = new PassThrough();
  const exitCode = await runDaemonConnect(["daemon", "connect", "--stdio", "--authority-wire"], {
    env: {},
    streams: { input: new PassThrough(), output: new PassThrough(), error },
    verifySshdContext: () => false
  });

  assert.equal(exitCode, 2);
  assert.match(error.read()?.toString() ?? "", /requires an authenticated SSH forced-command context/u);
});

test("authority-wire local ingress is explicitly unavailable on named pipes", () => {
  assert.throws(() => createDaemonLocalTransport({
    daemonId: "daemon-test",
    endpoint: "\\\\.\\pipe\\daemon-test",
    platform: "win32",
    createProtocolServer: () => { throw new Error("not used"); },
    acceptSshForcedCommand: () => true,
    authorityWireIngress: () => undefined
  }), /requires a Unix socket with server-observed peer credentials/u);
});

async function waitForEndpoint(endpoint: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`endpoint did not become ready: ${endpoint}`);
}
