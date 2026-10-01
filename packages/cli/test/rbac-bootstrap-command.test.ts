// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { parseThinCommand } from "../src/cli/thin-command.ts";

test("ha bootstrap routes managed lifecycle options to the daemon", () => {
  const parsed = parseThinCommand(["bootstrap", "--operation", "backup", "--backup-dir", "/tmp/rbac-backup"], "/repo");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.command.method, "daemon.rbac.manage");
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    operation: "backup",
    backupDir: "/tmp/rbac-backup",
  });
});

test("ha bootstrap parses one external Keycloak through the same command", () => {
  const parsed = parseThinCommand(
    ["bootstrap", "--mode", "external", "--url", "https://id.example", "--realm", "fleet", "--client-id", "center"],
    "/repo",
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.command.action, {
    kind: "rbac-bootstrap",
    mode: "external",
    url: "https://id.example",
    realm: "fleet",
    clientId: "center",
  });
});

test("ha bootstrap reads and sets the session lifetime through the same daemon method", () => {
  const read = parseThinCommand(["bootstrap", "--operation", "session-lifetime"], "/repo");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.command.action, { kind: "rbac-bootstrap", operation: "session-lifetime" });
  const set = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "session-lifetime-set",
      "--seconds",
      "43200",
      "--expected-version",
      "21600",
      "--operation-id",
      "lifetime-change-1",
    ],
    "/repo",
  );
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.equal(set.command.method, "daemon.rbac.manage");
  assert.deepEqual(set.command.action, {
    kind: "rbac-bootstrap",
    operation: "session-lifetime-set",
    sessionLifetimeSeconds: 43_200,
    expectedVersion: "21600",
    operationId: "lifetime-change-1",
  });
  assert.equal(
    parseThinCommand(["bootstrap", "--operation", "session-lifetime-set", "--seconds", "soon"], "/repo").ok,
    false,
  );
});

test("ha bootstrap reads and sets the listener edge nodes sign in through", () => {
  const read = parseThinCommand(["bootstrap", "--operation", "listener"], "/repo");
  assert.equal(read.ok, true);
  if (!read.ok) return;
  assert.deepEqual(read.command.action, { kind: "rbac-bootstrap", operation: "listener" });
  const set = parseThinCommand(
    [
      "bootstrap",
      "--operation",
      "listener-set",
      "--listen-address",
      "192.0.2.10",
      "--hostname",
      "center.example.test",
      "--port",
      "8443",
      "--certificate-file",
      "/etc/harness/center.crt",
      "--certificate-key-file",
      "/etc/harness/center.key",
      "--expected-version",
      "version-1",
    ],
    "/repo",
  );
  assert.equal(set.ok, true);
  if (!set.ok) return;
  assert.equal(set.command.method, "daemon.rbac.manage");
  assert.deepEqual(set.command.action, {
    kind: "rbac-bootstrap",
    operation: "listener-set",
    expectedVersion: "version-1",
    listenAddress: "192.0.2.10",
    hostname: "center.example.test",
    port: 8443,
    certificateFile: "/etc/harness/center.crt",
    certificateKeyFile: "/etc/harness/center.key",
  });
  assert.equal(parseThinCommand(["bootstrap", "--operation", "listener-set", "--port", "https"], "/repo").ok, false);
});

test("ha bootstrap lists, registers, and unregisters fleet nodes through the same daemon method", () => {
  const action = (args: readonly string[]) => {
    const parsed = parseThinCommand(["bootstrap", ...args], "/repo");
    assert.equal(parsed.ok, true, args.join(" "));
    if (!parsed.ok) return undefined;
    assert.equal(parsed.command.method, "daemon.rbac.manage");
    return parsed.command.action;
  };
  assert.deepEqual(action(["--operation", "node-list"]), { kind: "rbac-bootstrap", operation: "node-list" });
  assert.deepEqual(
    action(["--operation", "node-register", "--node-id", "edge-one", "--person-id", "alice", "--operation-id", "r-1"]),
    { kind: "rbac-bootstrap", operation: "node-register", operationId: "r-1", nodeId: "edge-one", personId: "alice" },
  );
  assert.deepEqual(
    action([
      "--operation",
      "node-unregister",
      "--node-id",
      "edge-one",
      "--expected-version",
      "version-1",
      "--operation-id",
      "u-1",
    ]),
    {
      kind: "rbac-bootstrap",
      operation: "node-unregister",
      expectedVersion: "version-1",
      operationId: "u-1",
      nodeId: "edge-one",
    },
  );
  assert.equal(parseThinCommand(["bootstrap", "--operation", "node-remove"], "/repo").ok, false);
});
