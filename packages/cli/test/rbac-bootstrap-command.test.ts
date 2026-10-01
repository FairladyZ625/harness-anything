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
