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
