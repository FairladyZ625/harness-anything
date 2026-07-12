// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  daemonIdForUserRoot,
  defaultNamedPipePath,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath
} from "../../daemon/src/index.ts";
import { resolveSshForcedCommandAuthentication } from "../src/commands/daemon/connect.ts";
import { createDaemonLocalTransport } from "../src/commands/daemon/serve-transport.ts";
import { hasPrivilegedSshdAncestor } from "../src/commands/daemon/sshd-witness.ts";
import {
  remoteDaemonUnavailableHint,
  remoteDaemonSshArgs,
  type RemoteDaemonConfig
} from "../src/daemon/client.ts";

test("daemon endpoint selection uses a named pipe on Windows and a unix socket on POSIX", () => {
  const userRoot = "/srv/harness-user";
  const daemonId = "team";
  assert.equal(
    localUserDaemonEndpoint(userRoot, daemonId, "win32"),
    defaultNamedPipePath(daemonIdForUserRoot(userRoot, daemonId))
  );
  assert.equal(localUserDaemonEndpoint(userRoot, daemonId, "linux"), localUserDaemonSocketPath(userRoot, daemonId));
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
    createProtocolServer
  });
  const posix = createDaemonLocalTransport({
    daemonId: "daemon-test",
    endpoint: "/tmp/daemon-test.sock",
    platform: "linux",
    createProtocolServer
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

test("forced-command principal requires an unforgeable sshd process witness", () => {
  assert.throws(() => resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio", "--principal", "person_alice", "--expect-original-command", "ha daemon connect --stdio"],
    rootDir: "/srv/canonical",
    env: { SSH_ORIGINAL_COMMAND: "ha daemon connect --stdio", USER: "shared-harness" },
    verifySshdContext: () => false
  }), /root-owned sshd ancestor/iu);
});

test("forced-command principal is static argv and never comes from SSH_ORIGINAL_COMMAND or USER", () => {
  const authentication = resolveSshForcedCommandAuthentication({
    args: ["daemon", "connect", "--stdio", "--principal", "person_alice", "--expect-original-command", "ha daemon connect --stdio"],
    rootDir: "/srv/canonical",
    env: { SSH_ORIGINAL_COMMAND: "ha daemon connect --stdio", USER: "person_mallory" },
    verifySshdContext: () => true
  });

  assert.deepEqual(authentication, { personId: "person_alice", canonicalRoot: "/srv/canonical" });
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
