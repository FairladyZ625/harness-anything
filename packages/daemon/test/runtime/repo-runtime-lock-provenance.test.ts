// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import test from "node:test";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { withTempStoreAsync } from "./helpers/store.ts";

test("a publishing daemon lock never impersonates takeover and resolves to its owner", async (t) => {
  await withTempStoreAsync(async (rootDir) => {
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, "", "utf8");

    const publishingRuntime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    const publishing = await rejectedError(publishingRuntime.start());
    assert.equal(errorReason(publishing), "lock-record-publishing");
    assert.doesNotMatch(publishing.message, /takeover/iu);

    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "published-owner",
      ownerKind: "daemon",
      repoId: "alpha",
      canonicalRoot: rootDir,
      userRoot: path.join(rootDir, ".daemon-user"),
      endpoint: path.join(rootDir, ".daemon-user/daemon.sock")
    }), "utf8");
    const heldRuntime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    const held = await rejectedError(heldRuntime.start());
    assert.equal(errorReason(held), "held");
    assert.match(held.message, /repo alpha/u);
    assert.match(held.message, /userRoot/u);
    assert.match(held.message, /endpoint/u);
    assert.match(held.message, /daemon-repository-ownership-invariants/u);
    t.diagnostic(JSON.stringify({
      publishing: { reason: errorReason(publishing), message: publishing.message },
      completed: { reason: errorReason(held), message: held.message }
    }));
  });
});

test("daemon runtime writes optional lock provenance and accepts legacy lock records", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const userRoot = path.join(rootDir, ".daemon-user");
    const endpoint = path.join(userRoot, "daemon.sock");
    const runtime = createDaemonRuntime({
      rootDir,
      materializerPollMs: false,
      lockProvenance: { repoId: "alpha", canonicalRoot: rootDir, userRoot, endpoint }
    });
    await runtime.start();
    const lockPath = path.join(rootDir, ".harness/locks/global.lock");
    const record = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, unknown>;
    assert.equal(record.repoId, "alpha");
    assert.equal(record.canonicalRoot, rootDir);
    assert.equal(record.userRoot, userRoot);
    assert.equal(record.endpoint, endpoint);
    await runtime.stop();

    writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      ownerToken: "legacy-owner",
      ownerKind: "daemon"
    }), "utf8");
    const legacyRuntime = createDaemonRuntime({ rootDir, materializerPollMs: false });
    assert.match((await rejectedError(legacyRuntime.start())).message, /held by daemon pid/u);
  });
});

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new Error("expected promise to reject");
}

function errorReason(error: Error): unknown {
  return "reason" in error ? error.reason : undefined;
}
