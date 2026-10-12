// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { watchReplicaHead } from "../src/fleet/edge-replica-watch.ts";
import { watchReplica, type FleetReplicaSyncOptions } from "../src/fleet/edge-replica-sync.ts";

test("replica watch forwards the heartbeat deadline to the session", async () => {
  let observedTimeout: number | null | undefined;
  const session = {
    messageId: () => "watch-1",
    send: async () => {},
    next: async (timeoutMs?: number | null) => {
      observedTimeout = timeoutMs;
      return {
        schema: "fleet.replica.head-hint/v1" as const,
        messageId: "hint-1",
        inReplyTo: "watch-1",
        repoId: "repo",
        cut: { revision: 1, headDigest: "sha256:" + "a".repeat(64), schemaGeneration: 1 },
        knownHead: { revision: 1, headDigest: "sha256:" + "a".repeat(64), schemaGeneration: 1 },
      };
    },
  };
  await watchReplicaHead(session, "repo", 0, 1234);
  assert.equal(observedTimeout, 1234);
});

test("silent watch times out, discards the session, and follows the next checkpoint", async () => {
  let fireDeadline!: () => void;
  const deadlines: number[] = [],
    discarded: unknown[] = [],
    released: unknown[] = [],
    hint = {
      schema: "fleet.replica.head-hint/v1" as const,
      messageId: "hint-2",
      inReplyTo: "watch-2",
      repoId: "repo",
      cut: { revision: 2, headDigest: "sha256:" + "b".repeat(64), schemaGeneration: 1 },
      knownHead: { revision: 2, headDigest: "sha256:" + "b".repeat(64), schemaGeneration: 1 },
    },
    session = {
      messageId: (() => {
        let sequence = 0;
        return () => `watch-${++sequence}`;
      })(),
      send: async () => {},
      next: (() => {
        let calls = 0;
        return async () => {
          if (++calls === 1) return await new Promise<never>(() => {});
          return hint;
        };
      })(),
      close: () => {},
    },
    pool = {
      acquire: async () => session,
      discard: (_options: FleetReplicaSyncOptions, peer: typeof session) => discarded.push(peer),
      release: (_options: FleetReplicaSyncOptions, peer: typeof session) => released.push(peer),
    } as unknown as Parameters<typeof watchReplica>[1],
    options = {
      repoId: "repo",
      nodeId: "node",
      heartbeatTimeoutMs: 10,
      heartbeatSchedule: (callback: () => void, delayMs: number) => {
        deadlines.push(delayMs);
        fireDeadline = callback;
        return {} as NodeJS.Timeout;
      },
      heartbeatCancel: () => {},
    } as FleetReplicaSyncOptions;
  const timedOut = watchReplica(options, pool, 1);
  await Promise.resolve();
  assert.deepEqual(deadlines, [10]);
  fireDeadline();
  await assert.rejects(timedOut, (error: unknown) => (error as { code?: string }).code === "replica_heartbeat_timeout");
  assert.deepEqual(discarded, [session]);

  deadlines.push(1);
  const recovered = await watchReplica(options, pool, 1);
  assert.equal(recovered.cut.revision, 2);
  assert.deepEqual(released, [session]);
});
