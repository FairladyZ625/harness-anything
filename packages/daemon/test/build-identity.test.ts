// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const moduleUrl = new URL("../src/build-identity.ts", import.meta.url).href;

// The stamp is the daemon's answer to "which build are you": a packaged build stamps
// HARNESS_BUILD_COMMIT, and a source-tree run resolves the commit from git so a resident daemon
// can be compared against the tree it was started from. Each case loads a fresh module instance
// because the stamp is frozen at first use.
test("the build stamp prefers the packaged build stamp over the source tree", async () => {
  const previous = process.env.HARNESS_BUILD_COMMIT;
  process.env.HARNESS_BUILD_COMMIT = "0123456789abcdef0123456789abcdef01234567";
  try {
    const fresh = await import(`${moduleUrl}?case=stamped`);
    assert.equal(fresh.daemonBuildStamp().commit, "0123456789abcdef0123456789abcdef01234567");
  } finally { restore(previous); }
});

test("a source-tree run reports the serving tree's HEAD commit", async () => {
  const previous = process.env.HARNESS_BUILD_COMMIT;
  delete process.env.HARNESS_BUILD_COMMIT;
  try {
    const fresh = await import(`${moduleUrl}?case=tree`);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.dirname(fileURLToPath(moduleUrl)), encoding: "utf8" }).trim();
    assert.equal(fresh.daemonBuildStamp().commit, head);
  } finally { restore(previous); }
});

function restore(previous: string | undefined): void { if (previous === undefined) delete process.env.HARNESS_BUILD_COMMIT; else process.env.HARNESS_BUILD_COMMIT = previous; }
