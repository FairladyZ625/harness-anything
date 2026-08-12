// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalRoot, endpointIdentity, safePath } from "../../../packages/daemon/src/protocol/daemon-protocol.contract.ts";
import { parseThinCommand } from "../../../packages/cli/src/cli/thin-command.ts";

test("G13 constructs SafePath CanonicalRoot and EndpointIdentity only at the transport boundary", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-g13-")); try { assert.equal(safePath(root), path.resolve(root)); assert.equal(canonicalRoot(root), realpathSync.native(root));
    assert.throws(() => endpointIdentity(""), /Endpoint identity is required/u); } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G14 server authority rejects client workspace identity and canonicalizes symlink roots", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-g14-")), actual = path.join(root, "actual"), link = path.join(root, "link");
  try { mkdirSync(actual); symlinkSync(actual, link); assert.equal(canonicalRoot(link), realpathSync.native(actual));
    const parsed = parseThinCommand(["--root", link, "task", "create", "--title", "Bound"]); assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(Object.hasOwn(parsed.command.action, "workspaceId"), false); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
