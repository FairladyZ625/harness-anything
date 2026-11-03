// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { ProjectionIdentityMismatchError } from "@harness-anything/storage";
import { repoCellStatus, repoCellStatusCuts } from "../src/repo-cell-status.ts";

test("status reports projection identity failure without blocking backup or publishing a completed cut", () => {
  const error = new ProjectionIdentityMismatchError(),
    context: Parameters<typeof repoCellStatus>[0] = {
      input: { repoId: "corrupt-cache" },
      rootDir: "/unused",
      mode: "local",
      state: "attached",
      generation: 3,
      queueDepth: 0,
      lastError: null,
      causeClass: null,
      recovery: { elapsedMs: 0, status: "none" },
      recoveryUncertain: false,
      projection: {
        readCut: () => {
          throw error;
        },
      } as never,
      store: { materializationHealth: () => null } as never,
    };
  const status = repoCellStatus(context);
  assert.equal(status.state, "attached");
  assert.equal(status.projectionReadable, false);
  assert.equal(status.projectionWatermark, undefined);
  assert.equal(status.ledgerRevision, undefined);
  assert.equal(status.lastError, error.message);
  assert.equal(status.causeClass, "projection");
  assert.equal(repoCellStatusCuts(context), null);
  const unexpected = new Error("unrelated failure");
  assert.throws(
    () =>
      repoCellStatus({
        ...context,
        projection: {
          readCut: () => {
            throw unexpected;
          },
        } as never,
      }),
    (actual) => actual === unexpected,
  );
});
