// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readDaemonStoppedAt, writeDaemonStoppedMarker } from "../src/client/daemon-autostart.ts";
import { daemonPidPath } from "../src/daemon-singleton.ts";

const entry = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

test("a supervised entry leaves an operator stop standing and exits zero so the service manager stands down", () => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-daemon-supervised-entry-")),
    daemonId = "supervised-entry";
  try {
    const stoppedAt = writeDaemonStoppedMarker(userRoot, daemonId),
      result = spawnSync(
        process.execPath,
        [entry, "--service", "--user-root", userRoot, "--daemon-id", daemonId, "--supervised"],
        { encoding: "utf8", timeout: 60_000 },
      );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, new RegExp(`stopped by the operator at ${stoppedAt.replaceAll(".", "\\.")}`, "u"));
    assert.equal(readDaemonStoppedAt(userRoot, daemonId), stoppedAt, "only an explicit start clears the marker");
    assert.equal(existsSync(daemonPidPath(userRoot, daemonId)), false, "no daemon claimed the slot");
  } finally {
    rmSync(userRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
