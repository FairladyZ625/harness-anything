// harness-test-tier: fast
// Edge reads stamp a repository read frame whose freshness the GUI protocol validates as whole
// milliseconds; the replica pointer's mtime carries sub-millisecond precision.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { FleetMirrorView } from "../src/fleet-edge-mirror.ts";
import { edgeFreshness } from "../src/fleet-edge-task-read.ts";
import { validateRepositoryReadFrame } from "../src/protocol/repository-read-frame.ts";

test("edge read freshness is a valid repository read frame for a sub-millisecond pointer mtime", (t) => {
  const viewDir = mkdtempSync(path.join(tmpdir(), "ha-edge-freshness-"));
  t.after(() => rmSync(viewDir, { recursive: true, force: true }));
  writeFileSync(path.join(viewDir, "current.json"), "{}");
  utimesSync(path.join(viewDir, "current.json"), 1_000.0004, 1_000.0004);
  const view = { viewDir, revision: 3 } as FleetMirrorView,
    fresh = edgeFreshness(view, 3, {}, () => 1_000_250);
  assert.deepEqual(
    validateRepositoryReadFrame({ cut: { revision: 3, headDigest: "sha256:h:3" }, ...fresh }),
    [],
    JSON.stringify(fresh),
  );
  assert.equal(fresh.freshness.ageMs, 249);
});
