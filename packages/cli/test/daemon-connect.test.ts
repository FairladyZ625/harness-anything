import assert from "node:assert/strict";
import test from "node:test";
import {
  daemonIdForUserRoot,
  defaultNamedPipePath,
  localUserDaemonEndpoint,
  localUserDaemonSocketPath
} from "../../daemon/src/index.ts";
import { createDaemonLocalTransport } from "../src/commands/daemon/serve-transport.ts";
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
