// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { daemonWalMaterializationWorkerUrl } from "../src/repo-cell.ts";

test("the daemon WAL worker keeps the executing module extension in source and dist layouts", () => {
  assert.equal(
    daemonWalMaterializationWorkerUrl("file:///repo/packages/daemon/src/repo-cell.ts").href,
    "file:///repo/packages/daemon/src/wal-materialization-daemon-worker.ts",
  );
  assert.equal(
    daemonWalMaterializationWorkerUrl("file:///repo/packages/cli/dist/daemon/src/repo-cell.js").href,
    "file:///repo/packages/cli/dist/daemon/src/wal-materialization-daemon-worker.js",
  );
});
