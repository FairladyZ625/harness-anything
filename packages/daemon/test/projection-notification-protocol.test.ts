// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import {
  makeServer,
  readFixture,
  resultReceipt
} from "./json-rpc-protocol-fixtures.ts";

test("repo notification subscription forwards projection changes and cleans up on disconnect", async () => {
  const notifications: unknown[] = [];
  let listener: ((event: unknown) => void) | undefined;
  let unsubscribeCalls = 0;
  const server = makeServer({
    notificationSink: (notification) => notifications.push(notification),
    subscribeProjectionChanges: (_repo, next) => {
      listener = next;
      return () => {
        unsubscribeCalls += 1;
        listener = undefined;
      };
    }
  });
  await server.handle(readFixture("hello-compatible.json"));

  const subscribed = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "subscribe-1",
    method: "repo.notifications.subscribe",
    params: { repo: { repoId: "canonical" } }
  }));
  assert.equal(subscribed.ok, true);
  assert.equal(subscribed.details.data.subscription, "projection-change/v1");

  listener?.({
    schema: "projection-change/v1",
    sourceHash: "sha256:new",
    entities: [{ kind: "task", id: "task-a" }]
  });
  assert.deepEqual(notifications, [{
    jsonrpc: "2.0",
    method: "repo.projection.changed",
    params: {
      repo: { repoId: "canonical" },
      event: {
        schema: "projection-change/v1",
        sourceHash: "sha256:new",
        entities: [{ kind: "task", id: "task-a" }]
      }
    }
  }]);

  const unsubscribed = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "unsubscribe-1",
    method: "repo.notifications.unsubscribe",
    params: { repo: { repoId: "canonical" } }
  }));
  assert.equal(unsubscribed.ok, true);
  assert.equal(unsubscribeCalls, 1);
  const resubscribed = resultReceipt(await server.handle({
    jsonrpc: "2.0",
    id: "subscribe-2",
    method: "repo.notifications.subscribe",
    params: { repo: { repoId: "canonical" } }
  }));
  assert.equal(resubscribed.ok, true);
  await server.close();
  assert.equal(unsubscribeCalls, 2);
  assert.equal(listener, undefined);
});
