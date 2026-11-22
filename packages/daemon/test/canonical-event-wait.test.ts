// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { CanonicalEventPage } from "@harness-anything/kernel";
import { makeCanonicalEventWait } from "../src/daemon-host/canonical-event-wait.ts";

const request = { afterRevision: 9, limit: 2, waitMs: 25_000 };
const empty: CanonicalEventPage = {
  schema: "canonical-event-page/v1",
  ok: true,
  repoId: "event-wait",
  events: [],
  headRevision: 9,
  nextAfterRevision: 9,
  hasMore: false,
};

test("canonical event wait observes a commit between snapshot and subscriber registration", async () => {
  const wait = makeCanonicalEventWait(),
    first = Promise.withResolvers<CanonicalEventPage>(),
    updated = { ...empty, headRevision: 10 };
  let reads = 0;
  const response = wait.read(request, async () => (++reads === 1 ? first.promise : updated));
  wait.observeCommit(10);
  first.resolve(empty);
  try {
    assert.equal(await response, updated);
    assert.equal(reads, 2);
  } finally {
    wait.close();
  }
});

test("canonical event wait ignores repeated cuts and cancels on disconnect or repository close", async () => {
  const wait = makeCanonicalEventWait(),
    client = new AbortController();
  let reads = 0;
  const read = async () => {
    reads += 1;
    return empty;
  };
  const response = wait.read(request, read, client.signal);
  await Promise.resolve();
  wait.observeCommit(9);
  await Promise.resolve();
  assert.equal(reads, 1);
  client.abort(new Error("client disconnected"));
  await assert.rejects(response, /client disconnected/u);
  wait.observeCommit(10);
  assert.equal(reads, 1);

  const closingResponse = wait.read({ ...request, afterRevision: 10 }, async () => ({
    ...empty,
    headRevision: 10,
  }));
  await Promise.resolve();
  wait.close();
  await assert.rejects(closingResponse, { code: "repo_unavailable" });
});
