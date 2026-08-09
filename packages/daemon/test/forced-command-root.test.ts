// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { commandRootMismatch, validateForcedCommandRoot } from "../src/protocol/forced-command-root.ts";
import { jsonRpcMethodContract } from "../src/protocol/method-registry.ts";

test("forced-command root mismatch names both roots and refuses blind registration", () => {
  const receipt = validateForcedCommandRoot(
    jsonRpcMethodContract("repo.tasks.list")!,
    { repo: { repoId: "locked", canonicalRoot: "/tmp/forced" } },
    { repoId: "locked", canonicalRoot: "/tmp/registered" },
    {
      transportKind: "ssh-exec",
      sshForcedCommand: {
        personId: "person_operator",
        canonicalRoot: "/tmp/forced",
        source: "sshd-authorized-keys-forced-command"
      }
    }
  );

  assert.equal(receipt?.error?.code, "forced_command_root_mismatch");
  assert.equal(
    receipt?.error?.hint,
    "Forced-command root mismatch: repo locked is registered at /tmp/registered, but the SSH forced command pins /tmp/forced. Run `ha daemon repo list --json` and ask an administrator to rebind repo locked to /tmp/forced before reconnecting. Do not register a second repo id."
  );
});

test("repo command root mismatch names the rejected payload field and canonical value", () => {
  const receipt = commandRootMismatch(
    { command: { rootDir: "/tmp/requested" } },
    { repoId: "locked", canonicalRoot: "/tmp/canonical" },
    undefined
  );

  assert.equal(receipt?.error?.code, "repo_command_root_mismatch");
  assert.equal(
    receipt?.error?.hint,
    "Root mismatch: payload.command.rootDir /tmp/requested does not match repo locked at /tmp/canonical. Set payload.command.rootDir to /tmp/canonical, then retry the original CLI command."
  );
});

test("forced command root mismatch renders a pasteable reconnect command", () => {
  const receipt = commandRootMismatch(
    { command: { rootDir: "/tmp/requested" } },
    { repoId: "locked", canonicalRoot: "/tmp/canonical" },
    {
      transportKind: "ssh-exec",
      sshForcedCommand: {
        personId: "person_operator",
        canonicalRoot: "/tmp/forced root",
        source: "sshd-authorized-keys-forced-command"
      }
    }
  );

  assert.equal(receipt?.error?.code, "forced_command_root_mismatch");
  assert.equal(
    receipt?.error?.hint,
    "Root mismatch: client --root /tmp/requested does not match the SSH forced-command root /tmp/forced root. Reconnect with `ha --root '/tmp/forced root' daemon connect --stdio`."
  );
});
