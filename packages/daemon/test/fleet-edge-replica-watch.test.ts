// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { watchReplicaHead } from "../src/fleet/edge-replica-watch.ts";
import {
  runFleetReplicaSync,
  watchReplica,
  type FleetReplicaSessionPool,
  type FleetReplicaSyncOptions,
} from "../src/fleet/edge-replica-sync.ts";

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

test("sync loop retries after a silent heartbeat and pulls the next checkpoint", async () => {
  const viewRoot = mkdtempSync(path.join(tmpdir(), "fleet-replica-sync-")),
    repoId = "repo",
    nodeId = "node",
    viewDir = path.join(viewRoot, "repos", repoId, "views", nodeId),
    cut = (revision: number) => ({
      revision,
      headDigest: `sha256:${String.fromCharCode(96 + revision).repeat(64)}`,
      schemaGeneration: 1,
    }),
    sessions: Array<{ readonly revision: number }> = [],
    discarded: Array<{ readonly revision: number }> = [],
    released: Array<{ readonly revision: number }> = [],
    scheduled: Array<{ readonly run: () => void; readonly delayMs: number }> = [],
    heartbeatDeadlines: Array<() => void> = [],
    revisions: number[] = [],
    failures: unknown[] = [];
  mkdirSync(viewDir, { recursive: true });

  const writeCurrent = (revision: number) => {
    const currentDir = path.join(viewDir);
    writeFileSync(
      path.join(currentDir, "current.json"),
      JSON.stringify({
        cut: cut(revision),
        schemaGeneration: 1,
        manifestDigest: `manifest-${revision}`,
        readerProfile: { personId: "person", nodeId },
        authorizationShapeDigest: `auth-${revision}`,
      }),
    );
  };
  class FakeReplicaSession {
    readonly revision: number;
    private sequence = 0;
    private mode: "pull" | "watch" | null = null;
    constructor(revision: number) {
      this.revision = revision;
    }
    messageId = () => `message-${this.revision}-${this.sequence++}`;
    send = async (frame: { readonly schema: string }) => {
      if (frame.schema === "fleet.replica.pull/v1") this.mode = "pull";
      if (frame.schema === "fleet.replica.watch/v1") this.mode = "watch";
    };
    request = async () => {
      throw new Error("fake center does not expect an ACK");
    };
    next = async () => {
      if (this.mode === "pull") {
        writeCurrent(this.revision);
        return {
          schema: "fleet.replica.current/v1" as const,
          messageId: this.messageId(),
          inReplyTo: "pull",
          repoId,
          viewId: nodeId,
          cut: cut(this.revision),
          knownHead: cut(this.revision),
          manifestDigest: `manifest-${this.revision}`,
          readerProfile: { personId: "person", nodeId },
          authorizationShapeDigest: `auth-${this.revision}`,
        };
      }
      if (this.revision === 1) return await new Promise<never>(() => {});
      return {
        schema: "fleet.replica.head-hint/v1" as const,
        messageId: this.messageId(),
        inReplyTo: "watch",
        repoId,
        cut: cut(3),
        knownHead: cut(3),
      };
    };
    close = () => {};
  }
  let active: InstanceType<typeof FakeReplicaSession> | undefined;
  const pool = {
    acquire: async () => {
      if (active) return active;
      active = new FakeReplicaSession(sessions.length + 1);
      sessions.push(active);
      return active;
    },
    discard: (_options: FleetReplicaSyncOptions, session: InstanceType<typeof FakeReplicaSession>) => {
      discarded.push(session);
      if (active === session) active = undefined;
    },
    release: (_options: FleetReplicaSyncOptions, session: { readonly revision: number }) => released.push(session),
    close: () => {},
  } as unknown as FleetReplicaSessionPool;
  const controller = new AbortController();
  try {
    const running = runFleetReplicaSync({
      repoId,
      nodeId,
      viewRoot,
      diskQuotaBytes: 64 * 1024 * 1024,
      sessionPool: pool,
      signal: controller.signal,
      retryDelaysMs: [7],
      onConfirmed: (revision) => {
        revisions.push(revision);
        if (revision === 2) controller.abort();
      },
      onFailure: (error) => failures.push(error),
      schedule: (run, delayMs) => {
        scheduled.push({ run, delayMs });
      },
      heartbeatTimeoutMs: 11,
      heartbeatSchedule: (callback, delayMs) => {
        assert.equal(delayMs, 11);
        heartbeatDeadlines.push(callback);
        return {} as NodeJS.Timeout;
      },
      heartbeatCancel: () => {},
    });
    await flushUntil(() => revisions.length === 1 && heartbeatDeadlines.length === 1);
    heartbeatDeadlines[0]!();
    await flushUntil(() => failures.length === 1 && scheduled.length === 1);
    assert.equal((failures[0] as { code?: string }).code, "replica_heartbeat_timeout");
    assert.deepEqual(
      discarded.map(({ revision }) => revision),
      [1],
    );
    assert.deepEqual(
      scheduled.map(({ delayMs }) => delayMs),
      [7],
    );
    scheduled[0]!.run();
    await flushUntil(() => revisions.includes(2));
    await running;
    assert.deepEqual(revisions, [1, 2]);
    assert.deepEqual(
      sessions.map(({ revision }) => revision),
      [1, 2],
    );
    assert.deepEqual(
      released.map(({ revision }) => revision),
      [1, 2],
    );
  } finally {
    controller.abort();
    rmSync(viewRoot, { recursive: true, force: true });
  }
});

async function flushUntil(ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !ready(); attempt += 1) await Promise.resolve();
  assert.equal(ready(), true, "deterministic sync event did not arrive");
}
