// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTerminalSessionRegistry } from "../src/terminal/session-store.ts";

test("terminal registry load projects owner-stripped DTOs and drops undeclared secret fields", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-terminal-store-"));
  const filePath = path.join(root, "generated", "terminal-sessions.json");
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      schema: "terminal-session-registry/v1",
      sessions: [{
        sessionId: "term-1", name: "Safe", backend: "direct-pty", durability: "none", degraded: true,
        status: "unknown", attachable: false, hostLabel: "local", createdAt: "2026-07-18T00:00:00.000Z",
        token: "must-not-cross", ownerPid: 42
      }]
    }));
    const sessions = loadTerminalSessionRegistry(filePath);
    assert.equal(sessions.length, 1);
    assert.equal("token" in (sessions[0] as object), false);
    assert.equal("ownerPid" in (sessions[0] as object), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
