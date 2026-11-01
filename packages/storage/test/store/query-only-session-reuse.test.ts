// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { runtimeEventContentClaims } from "@harness-anything/kernel/internal/domain/agent-runtime.ts";
import { canonicalEventWritePlan, makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { makeTaskProjection, makeTaskProjectionReader } from "../../src/projection/rebuildable-task-projection.ts";
import {
  closeTaskProjectionsUnder,
  countQueryOnlyProjectionOpens,
} from "../../src/projection/rebuildable-task-projection-database.ts";
import { withTempStoreAsync } from "./helpers.ts";

// The daemon answers every repository read with one query-only projection session, so the
// per-session connection open (schema parse included) is per-request work on the host thread.
// These tests pin the reuse contract: one connection across sessions, snapshot semantics per
// session, reopen when the file's identity changes, and teardown closing the cached connection.
const actor = { principal: { personId: "person-reuse" }, executor: null } as const;

function appendSessionEvent(
  store: ReturnType<typeof makeTaskEventStore>,
  index: number,
  type: "runtime_session_started" | "runtime_session_liveness_changed",
): void {
  const event = {
    schema: "agent-runtime-event/v1",
    eventId: `event-reuse-${index}`,
    workspaceRevision: index,
    opId: `op-reuse-${index}`,
    actor,
    source: "local",
    occurredAt: `2026-10-21T00:00:0${index % 10}.000Z`,
    type,
    payload:
      type === "runtime_session_started"
        ? {
            runtimeSessionId: "runtime-session-reuse",
            instanceId: "reuse-fixture",
            installationId: "installation-reuse",
            kindId: "reuse",
            definitionSnapshotRef: "artifact:runtime-definitions/reuse/v1",
            launchGeneration: 1,
            attachable: false,
          }
        : { runtimeSessionId: "runtime-session-reuse", liveness: "live" },
  } as const;
  store.append({
    event,
    plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId),
    blobs: runtimeEventContentClaims(event).map((claim) => ({ ...claim, body: "fixture result" })),
  });
}

test("sequential query-only sessions reuse one connection and follow new commits and teardown", async () => {
  await withTempStoreAsync(async (rootDir) => {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Reuse Test");
    git(rootDir, "config", "user.email", "reuse@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    appendSessionEvent(store, 1, "runtime_session_started");
    appendSessionEvent(store, 2, "runtime_session_liveness_changed");
    projection.catchUp();
    const reader = makeTaskProjectionReader({ rootDir }),
      before = countQueryOnlyProjectionOpens();
    reader.withSession((queries) => queries.readCut());
    reader.withSession((queries) => queries.readRuntimeSessions());
    reader.withSession((queries) => queries.readCut());
    assert.equal(countQueryOnlyProjectionOpens(), before + 1, "three sessions opened more than one connection");

    // The reused connection must see newly committed rows: each session takes its own BEGIN/COMMIT,
    // so a WAL reader follows later commits without reopening the file.
    appendSessionEvent(store, 3, "runtime_session_liveness_changed");
    projection.catchUp();
    assert.equal(reader.withSession((queries) => queries.readCut()).sourceRevision, 3);
    assert.equal(countQueryOnlyProjectionOpens(), before + 1, "a same-file commit forced a reopen");

    closeTaskProjectionsUnder(rootDir);
    assert.equal(reader.withSession((queries) => queries.readCut()).sourceRevision, 3);
    assert.equal(countQueryOnlyProjectionOpens(), before + 2, "teardown did not close the cached connection");
    await store.drain();
  });
});

test("a query-only session reopens when the projection file is rebuilt", async () => {
  await withTempStoreAsync(async (rootDir) => {
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Reuse Test");
    git(rootDir, "config", "user.email", "reuse@example.invalid");
    git(rootDir, "commit", "--allow-empty", "-qm", "base");
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      projection = makeTaskProjection({ rootDir, eventStore: store });
    appendSessionEvent(store, 1, "runtime_session_started");
    appendSessionEvent(store, 2, "runtime_session_liveness_changed");
    projection.catchUp();
    const reader = makeTaskProjectionReader({ rootDir }),
      before = countQueryOnlyProjectionOpens();
    assert.equal(reader.withSession((queries) => queries.readCut()).sourceRevision, 2);
    assert.equal(countQueryOnlyProjectionOpens(), before + 1);

    // rebuild() discards and recreates the file; the cached connection follows the new identity
    // instead of reading the detached old inode. The rebuild's own discard pass opens a coverage
    // session, so the reopen is measured from after the rebuild.
    projection.rebuild();
    const afterRebuild = countQueryOnlyProjectionOpens();
    assert.equal(reader.withSession((queries) => queries.readCut()).sourceRevision, 2);
    assert.equal(countQueryOnlyProjectionOpens(), afterRebuild + 1, "a replaced projection file did not reopen");
    await store.drain();
  });
});

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
