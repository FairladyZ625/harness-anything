// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  withDaemonObservation,
  observeDaemonOperation,
  markDaemonOperationPhase,
  type DaemonOperationObserver,
} from "../src/daemon-operation.ts";
import { fleetBaseBackupTrace } from "@harness-anything/storage";

function observer() {
  const active = new Map<number, Record<string, unknown>>();
  let next = 0;
  const sink: DaemonOperationObserver = {
    begin: (fields) => {
      const id = ++next;
      active.set(id, { ...fields });
      return {
        update: (update) => active.set(id, { ...active.get(id), ...update }),
        end: () => {
          active.delete(id);
        },
      };
    },
  };
  return { sink, active };
}
test("operation scopes isolate concurrent phases and remove synchronous, rejected and fulfilled calls", async () => {
  const o = observer();
  await withDaemonObservation(o.sink, async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = observeDaemonOperation({ method: "first", repoId: "repo-a" }, async () => {
      markDaemonOperationPhase("waiting");
      await gate;
      markDaemonOperationPhase("settled");
    });
    assert.equal(o.active.size, 1);
    assert.equal(
      observeDaemonOperation({ method: "sync" }, () => {
        markDaemonOperationPhase("scan");
        return 42;
      }),
      42,
    );
    assert.equal(o.active.size, 1);
    assert.throws(
      () =>
        observeDaemonOperation({ method: "throw" }, () => {
          throw new Error("sync-error");
        }),
      /sync-error/u,
    );
    await assert.rejects(
      observeDaemonOperation({ method: "reject" }, async () => {
        throw new Error("async-error");
      }),
      /async-error/u,
    );
    assert.deepEqual([...o.active.values()], [{ method: "first", repoId: "repo-a", phase: "waiting" }]);
    release();
    await first;
    assert.equal(o.active.size, 0);
  });
});
test("basebackup span remains registered from snapshot through archive completion", () => {
  const o = observer();
  withDaemonObservation(o.sink, () => {
    const span = { repoId: null as string | null };
    fleetBaseBackupTrace.start.publish(span);
    assert.equal(o.active.size, 1);
    span.repoId = "repo-a";
    fleetBaseBackupTrace.asyncStart.publish(span);
    assert.deepEqual(
      [...o.active.values()],
      [{ method: "fleet.basebackup", repoId: "repo-a", actor: "daemon", phase: "archive" }],
    );
    fleetBaseBackupTrace.end.publish(span);
    assert.equal(o.active.size, 0);
  });
});
