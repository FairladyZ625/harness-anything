// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { enqueueDaemonAuthorityPublication } from "../src/runtime/authority-publication.ts";
import { runWithAuthorityDurableAcceptance } from "../src/runtime/authority-durable-acceptance-context.ts";
import type { DaemonWriteQueue } from "../src/runtime/write-queue.ts";

test("durable acceptance is observable while canonical reads still expose the prior cut", async () => {
  const materializer = deferred<void>();
  const accepted = deferred<void>();
  let canonicalValue = "old";
  let sessionDurable = false;
  let enqueueCount = 0;
  const queue = {
    enqueueBackground: async <Result>(request: { readonly run: () => Promise<Result> | Result }) => {
      enqueueCount += 1;
      if (enqueueCount === 2) await materializer.promise;
      return request.run();
    }
  } as unknown as DaemonWriteQueue;

  const settlement = runWithAuthorityDurableAcceptance({
    accept: (receipt) => {
      assert.equal(sessionDurable, true);
      assert.equal(receipt.acceptedCommitSha, "a".repeat(40));
      accepted.resolve();
    }
  }, () => enqueueDaemonAuthorityPublication(
    queue,
    {
      sessionId: "session-read-cut",
      publish: async () => {
        sessionDurable = true;
        return {
          reason: "explicit",
          opCount: 1,
          committed: true,
          watermark: "watermark-1"
        };
      }
    },
    () => {
      canonicalValue = "new";
      return {
        dryRun: false,
        merged: 1,
        considered: 1,
        branches: [],
        warnings: [],
        projectionRebuilt: false,
        attributionEventsProjected: 0
      };
    },
    () => "a".repeat(40)
  ));

  await accepted.promise;
  assert.equal(canonicalValue, "old");
  materializer.resolve();
  await settlement;
  assert.equal(canonicalValue, "new");
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = (value) => {
      complete(value);
    };
  });
  return { promise, resolve };
}
