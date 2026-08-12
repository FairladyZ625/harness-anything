// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { detachedProcessOptions } from "../../daemon/src/process-port.ts";

test("daemon process port hides detached startup windows", () => {
  assert.deepEqual(detachedProcessOptions, { detached: true, stdio: "ignore", windowsHide: true });
});

test("daemon-missing write rejects without autostart or local fallback", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-no-daemon-"));
  try { const started = performance.now(), result = spawnSync(process.execPath,
    [path.resolve("packages/cli/src/index.ts"), "--root", root, "--json", "task", "create", "--title", "No daemon"],
    { encoding: "utf8", env: { ...process.env, HOME: path.join(root, ".home"), HARNESS_DAEMON_USER_ROOT: path.join(root, "user") } });
    const elapsedMs = performance.now() - started, receipt = JSON.parse(result.stdout) as { ok: boolean; error: { code: string } };
    assert.notEqual(result.status, 0); assert.equal(receipt.ok, false); assert.equal(receipt.error.code, "daemon_unavailable");
    assert.equal(existsSync(path.join(root, "harness")), false); assert.equal(existsSync(path.join(root, ".harness")), false);
    assert.equal(elapsedMs < 250, true, `source-mode diagnostic ${elapsedMs.toFixed(3)}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
