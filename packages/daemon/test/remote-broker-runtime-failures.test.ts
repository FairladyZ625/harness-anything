// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  BrokerDurableStateStore,
  BrokerReplicaIntegrityError,
  RemoteReadDownSession,
  RemoteReplicaResyncRequiredError,
  ReplicaBroker,
  type BrokerDurableState,
  type PersistentSshAuthorityClient
} from "../src/index.ts";
import {
  ReadDownClient,
  changeLog,
  emptyRemoteResync,
  makeRuntime,
  notifyRuntime,
  record,
  remoteResync,
  snapshotFixture,
  waitFor,
  withRoots,
  workspaceId
} from "./remote-broker-runtime-failure-support.ts";
import { deferred } from "./remote-read-down-test-support.ts";

test("cold restart seeds the durable epoch and bootstraps when the first remote cut changed epoch", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const fixture = snapshotFixture(1, "epoch-2");
    const store = new BrokerDurableStateStore(stateRoot);
    const initial = await store.initialize(workspaceId);
    await store.save({
      ...initial,
      epoch: "epoch-1",
      receivedCursor: 1,
      resolvedCursor: 1,
      receivedCommit: fixture.reservation.cut.commitSha,
      resolvedCommit: fixture.reservation.cut.commitSha
    });
    const client = new ReadDownClient(fixture);
    const runtime = makeRuntime(client, viewRoot, stateRoot);

    const state = await runtime.start();

    assert.equal(state.mode, "READY");
    assert.equal(state.epoch, "epoch-2");
    assert.equal(state.resolvedCursor, 1);
    assert.ok(client.changeRequests.length > 0);
    assert.ok(client.changeRequests.every((revision) => revision === 1));
    await runtime.stop();
  });
});

test("remote parent mismatch is terminal and never creates targetless RESYNC", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const wrongParent = record(1, "commit-1", "wrong-parent");
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaGapPolicy: "TERMINAL",
      replicaChangeLog: changeLog(async () => [wrongParent]),
      snapshotSource: {
        snapshotAt: async () => ({
          workspaceId,
          revision: 1,
          commitSha: "commit-1",
          entries: []
        })
      }
    });

    await assert.rejects(broker.synchronize(), BrokerReplicaIntegrityError);
    assert.equal(broker.snapshotState().mode, "READY");
    assert.equal(broker.snapshotState().resyncTarget, undefined);
  });
});

test("all broker synchronization entrypoints run serially without merging fresh intents", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const release = deferred<void>();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await release.promise;
        active -= 1;
        return [];
      }),
      snapshotSource: {
        snapshotAt: async () => {
          throw new Error("unexpected snapshot");
        }
      }
    });
    const hint = record(1, "commit-1", null);

    const first = broker.synchronize();
    const second = broker.synchronize();
    const notified = broker.onNotification(hint);
    assert.notEqual(first, second);
    assert.notEqual(second, notified);
    await waitFor(() => calls === 1);
    assert.equal(maximumActive, 1);
    release.resolve();
    await Promise.all([first, second, notified]);
    assert.equal(calls, 3);
    assert.equal(maximumActive, 1);
  });
});

test("repeated resync cut exits without rewriting the durable target indefinitely", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const cutChange = record(1, "commit-1", null);
    const resync = remoteResync(cutChange, "epoch-resync");
    let snapshotCalls = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => {
        throw resync;
      }),
      snapshotSource: {
        snapshotAt: async () => {
          snapshotCalls += 1;
          throw remoteResync(cutChange, "epoch-resync");
        }
      }
    });

    await assert.rejects(broker.synchronize(), RemoteReplicaResyncRequiredError);

    const state = broker.snapshotState();
    assert.equal(state.mode, "RESYNC_REQUIRED");
    assert.equal(state.resyncTarget?.revision, 1);
    assert.equal(state.nextJournalLSN, 2);
    assert.equal(snapshotCalls, 1);
  });
});

test("background deterministic failure becomes terminal, unsubscribes, and is observable through stop", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    await runtime.start();
    const failure = new BrokerReplicaIntegrityError("deterministic snapshot failure");
    runtime.broker.onNotification = async () => {
      throw failure;
    };

    notifyRuntime(runtime, record(1, "commit-1", null));
    await waitFor(() => runtime.health().status === "TERMINAL");

    const health = runtime.health();
    assert.equal(health.status, "TERMINAL");
    if (health.status === "TERMINAL") assert.equal(health.failure, failure);
    assert.equal(client.notificationListeners.size, 0);
    assert.equal(client.disconnectListeners.size, 0);
    await assert.rejects(runtime.stop(), failure);
  });
});

test("notification hints coalesce to one running synchronization and one latest rerun", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    await runtime.start();
    const release = deferred<void>();
    const revisions: number[] = [];
    runtime.broker.onNotification = async (change) => {
      revisions.push(change.revision);
      if (revisions.length === 1) await release.promise;
      return runtime.broker.snapshotState();
    };

    notifyRuntime(runtime, record(1, "commit-1", null));
    await waitFor(() => revisions.length === 1);
    for (let revision = 2; revision <= 100; revision += 1) {
      notifyRuntime(runtime, record(revision, `commit-${revision}`, `commit-${revision - 1}`));
    }
    assert.deepEqual(revisions, [1]);
    release.resolve();
    await waitFor(() => revisions.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(revisions, [1, 100]);
    await runtime.stop();
  });
});

test("retryable initial synchronization failure rolls back and a later start creates a fresh session", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    const synchronize = runtime.broker.synchronize.bind(runtime.broker);
    let attempts = 0;
    runtime.broker.synchronize = () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(emptyRemoteResync())
        : synchronize();
    };

    await assert.rejects(runtime.start(), RemoteReplicaResyncRequiredError);
    assert.deepEqual(runtime.health(), { status: "IDLE" });
    assert.equal(client.notificationListeners.size, 0);
    assert.equal(client.disconnectListeners.size, 0);
    assert.equal(client.closeRequests, 1);

    const state = await runtime.start();
    assert.equal(state.mode, "READY");
    assert.deepEqual(runtime.health(), { status: "RUNNING" });
    await runtime.stop();
    assert.equal(client.closeRequests, 2);
  });
});

test("historical targetless RESYNC is terminal instead of a successful remote startup", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const store = new BrokerDurableStateStore(stateRoot);
    const initial = await store.initialize(workspaceId);
    await store.save({ ...initial, mode: "RESYNC_REQUIRED" });
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);

    await assert.rejects(runtime.start(), BrokerReplicaIntegrityError);
    assert.equal(runtime.health().status, "TERMINAL");
    assert.deepEqual(client.changeRequests, []);
    await assert.rejects(runtime.stop(), BrokerReplicaIntegrityError);
  });
});

test("submission preflight and synchronization cannot interleave a stale durable snapshot", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const pathName = "tasks/a.md";
    await mkdir(path.join(viewRoot, "tasks"), { recursive: true });
    await writeFile(path.join(viewRoot, pathName), "draft\n");
    let queries = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => {
        queries += 1;
        return [record(1, "commit-1", null)];
      }),
      snapshotSource: {
        snapshotAt: async () => ({
          workspaceId,
          revision: 1,
          commitSha: "commit-1",
          entries: []
        })
      }
    });
    await broker.recordLocalChange(pathName);
    const entered = deferred<void>();
    const release = deferred<void>();
    const internals = broker as unknown as {
      readonly cas: { put: (bytes: Uint8Array) => Promise<string> };
    };
    const put = internals.cas.put.bind(internals.cas);
    internals.cas.put = async (bytes) => {
      entered.resolve();
      await release.promise;
      return put(bytes);
    };

    const submission = broker.prepareSubmission(pathName, "op-submit");
    await entered.promise;
    const synchronization = broker.synchronize();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(queries, 0);
    release.resolve();
    await submission;
    await synchronization;

    assert.equal(broker.snapshotState().receivedCursor, 1);
    assert.equal(broker.snapshotState().resolvedCursor, 1);
  });
});

test("a fresh synchronize intent queued during materialization re-queries authority", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const firstSnapshot = deferred<void>();
    const available = [record(1, "commit-1", null)];
    let queries = 0;
    let snapshots = 0;
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async (revision) => {
        queries += 1;
        return available.filter((change) => change.revision > revision);
      }),
      snapshotSource: {
        snapshotAt: async (change) => {
          snapshots += 1;
          if (snapshots === 1) await firstSnapshot.promise;
          return {
            workspaceId,
            revision: change.revision,
            commitSha: change.commitSha,
            entries: []
          };
        }
      }
    });

    const first = broker.synchronize();
    await waitFor(() => snapshots === 1);
    available.push(record(2, "commit-2", "commit-1"));
    const second = broker.synchronize();
    assert.notEqual(first, second);
    firstSnapshot.resolve();

    assert.equal((await first).resolvedCursor, 1);
    assert.equal((await second).resolvedCursor, 2);
    assert.equal(queries, 2);
  });
});

test("concurrent synchronize and notification share one initialization transition", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const broker = new ReplicaBroker({
      workspaceId,
      viewId: "view-remote",
      viewRoot,
      stateRoot,
      replicaChangeLog: changeLog(async () => []),
      snapshotSource: {
        snapshotAt: async () => {
          throw new Error("unexpected snapshot");
        }
      }
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    const internals = broker as unknown as {
      readonly store: {
        initialize: (id: string) => Promise<BrokerDurableState>;
      };
    };
    const initialize = internals.store.initialize.bind(internals.store);
    let initializations = 0;
    internals.store.initialize = async (id) => {
      initializations += 1;
      entered.resolve();
      await release.promise;
      return initialize(id);
    };

    const synchronized = broker.synchronize();
    await entered.promise;
    const notified = broker.onNotification(record(1, "commit-1", null));
    release.resolve();
    await Promise.all([synchronized, notified]);
    assert.equal(initializations, 1);
  });
});

test("background resync keeps health RECOVERING and owns a retry until READY", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const retrySleep = deferred<void>();
    const runtime = makeRuntime(client, viewRoot, stateRoot, {
      sleep: async () => retrySleep.promise,
      backoff: { initialMs: 1, maximumMs: 1, multiplier: 1 }
    });
    await runtime.start();
    const cut = record(1, "commit-1", null);
    const resync = remoteResync(cut, "epoch-resync");
    const internals = runtime.broker as unknown as { state: BrokerDurableState };
    runtime.broker.onNotification = async () => {
      internals.state = {
        ...internals.state,
        mode: "RESYNC_REQUIRED",
        resyncTarget: {
          epoch: resync.cut.epoch,
          revision: resync.cut.revision,
          commitSha: resync.cut.commitSha,
          cutChange: resync.cutChange
        }
      };
      throw resync;
    };
    let retries = 0;
    runtime.broker.synchronize = async () => {
      retries += 1;
      internals.state = {
        ...internals.state,
        mode: "READY",
        resyncTarget: undefined
      };
      return structuredClone(internals.state);
    };

    notifyRuntime(runtime, cut);
    await waitFor(() => runtime.health().status === "RECOVERING");
    assert.equal(runtime.broker.snapshotState().mode, "RESYNC_REQUIRED");
    assert.equal(retries, 0);
    retrySleep.resolve();
    await waitFor(() => runtime.health().status === "RUNNING");
    assert.equal(retries, 1);
    await runtime.stop();
  });
});

test("a malformed empty cut is classified terminal without reconnect", async () => {
  await withRoots(async ({ stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    client.invalidEmptyCutChange = true;
    const sleeps: number[] = [];
    let terminal: Error | undefined;
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      onTerminal: (failure) => {
        terminal = failure;
      }
    });

    await assert.rejects(session.latest(), /empty cut unexpectedly has a change/u);
    assert.equal(session.health().status, "TERMINAL");
    assert.match(terminal?.message ?? "", /empty cut unexpectedly has a change/u);
    assert.equal(client.reconnectRequests, 0);
    assert.deepEqual(sleeps, []);
    await session.close();
  });
});

test("session notification identity conflict immediately surfaces terminal runtime health", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const runtime = makeRuntime(client, viewRoot, stateRoot);
    await runtime.start();
    const first = record(2, "commit-2", "commit-1");
    client.emit(first);
    client.emit({ ...first, commitSha: "different-commit" });

    await waitFor(() => runtime.health().status === "TERMINAL");
    assert.match(
      runtime.health().status === "TERMINAL" ? runtime.health().failure.message : "",
      /identity conflict/u
    );
    assert.equal(client.notificationListeners.size, 0);
    await assert.rejects(runtime.stop(), /identity conflict/u);
  });
});

test("startup failures leave an explicit terminal or clean retryable boundary", async () => {
  await withRoots(async ({ viewRoot, stateRoot }) => {
    const initializeClient = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const initializeRuntime = makeRuntime(initializeClient, viewRoot, stateRoot);
    initializeRuntime.broker.initialize = async () => {
      throw new Error("durable initialize failed");
    };
    await assert.rejects(initializeRuntime.start(), /durable initialize failed/u);
    assert.equal(initializeRuntime.health().status, "TERMINAL");

    const listenerClient = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    listenerClient.disconnectRegistrationFailure = new Error("listener registration failed");
    const listenerRuntime = makeRuntime(
      listenerClient,
      `${viewRoot}-listener`,
      `${stateRoot}-listener`
    );
    await assert.rejects(listenerRuntime.start(), /listener registration failed/u);
    assert.equal(listenerClient.notificationListeners.size, 0);
    assert.equal(listenerRuntime.health().status, "TERMINAL");

    const retryClient = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    retryClient.closeFailuresRemaining = 1;
    const retryRuntime = makeRuntime(
      retryClient,
      `${viewRoot}-retry`,
      `${stateRoot}-retry`
    );
    const synchronize = retryRuntime.broker.synchronize.bind(retryRuntime.broker);
    let attempts = 0;
    retryRuntime.broker.synchronize = () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(emptyRemoteResync()) : synchronize();
    };
    await assert.rejects(retryRuntime.start(), RemoteReplicaResyncRequiredError);
    assert.deepEqual(retryRuntime.health(), { status: "IDLE" });
    assert.throws(() => retryRuntime.session, /not started/u);
    assert.equal(retryClient.notificationListeners.size, 0);
    await retryRuntime.start();
    await retryRuntime.stop();
  });
});

test("authoritative low revisions evict lossy high hints from the bounded cache", async () => {
  await withRoots(async ({ stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      changeCache: { maxCount: 3, maxBytes: 64 * 1024 }
    });
    await session.changesAfter(0);
    for (let revision = 100; revision <= 102; revision += 1) {
      client.emit(record(revision, `commit-${revision}`, `commit-${revision - 1}`));
    }
    assert.equal((await session.latest())?.revision, 102);
    client.authoritativeChanges = [record(1, "commit-1", null)];

    const changes = await session.changesAfter(0);
    assert.deepEqual(changes.map((change) => change.revision), [1]);
    assert.notEqual(session.health().status, "TERMINAL");
    await session.close();
  });
});

test("repeated fetch disconnects sleep with bounded backoff before retrying", async () => {
  await withRoots(async ({ stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    client.fetchFailuresRemaining = 3;
    const sleeps: number[] = [];
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot,
      backoff: { initialMs: 2, maximumMs: 5, multiplier: 2 },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      }
    });

    await session.changesAfter(0);
    assert.deepEqual(sleeps, [2, 4, 5]);
    assert.equal(client.changeRequests.length, 4);
    assert.equal(client.reconnectRequests, 3);
    await session.close();
  });
});

test("client close rejection is reported only after pending session work joins", async () => {
  await withRoots(async ({ stateRoot }) => {
    const client = new ReadDownClient(snapshotFixture(0, "epoch-1"));
    const fetchGate = deferred<void>();
    client.fetchGate = fetchGate;
    client.closeFailuresRemaining = 1;
    const session = new RemoteReadDownSession({
      client: client as unknown as PersistentSshAuthorityClient,
      workspaceId,
      stateRoot
    });
    const reading = session.changesAfter(0);
    await waitFor(() => client.changeRequests.length === 1);
    let settled = false;
    const closing = session.close().finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    fetchGate.resolve();
    await assert.rejects(closing, /scripted close failure/u);
    await assert.rejects(reading, /session is closed/u);
  });
});
