// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import { event, initRepo } from "./task-event-store.fixtures.ts";

// #1587: the predicate passing is not the same as the predicate being wired into publication.
// This drives a real append, so removing the assertion from assertBundle turns it red — the
// unit test over assertPublishableOpId alone stayed green when the call site was deleted.
test("#1587: publishing an event whose opId cannot be a filename is refused, and nothing is written", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      before = store.currentCommit();
    const unportable = {
      ...event,
      opId: "runtime-spawn-abcdef:installation",
    } as typeof event;
    assert.throws(
      () =>
        store.append({
          event: unportable,
          plan: taskLifecycleWritePlan(unportable),
          blobs: [],
        }),
      /cannot be a filename/u,
    );
    assert.deepEqual(store.currentCommit(), before);
    assert.equal(store.readEvent(unportable.opId), null);
    // The legal spelling of the same publication still goes through.
    const portable = {
      ...event,
      opId: "runtime-spawn-abcdef-installation",
    } as typeof event;
    assert.equal(
      store.append({
        event: portable,
        plan: taskLifecycleWritePlan(portable),
        blobs: [],
      }).commitSha.sha.length,
      40,
    );
  });
});
