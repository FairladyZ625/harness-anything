// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import { serializeTaskEvent, type TaskCreatedEvent } from "../../src/domain/task-lifecycle.contract.ts";
import { serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { makeTaskEventStore } from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

const event: TaskCreatedEvent = {
  schema: "task-event/v1",
  eventId: "event-1",
  workspaceRevision: 1,
  opId: "op-1",
  taskId: "task-1",
  type: "task_created",
  actor: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } },
  source: "local",
  occurredAt: "2026-08-11T00:00:00.000Z",
  payload: {
    task: {
      schema: "task/v1",
      taskId: "task-1",
      title: "Replay task",
      status: "planned",
      graph: REPLAY_TASK_GRAPH,
      currentNode: "implementation",
      iteration: 0,
      createdBy: { principal: { personId: "person-1" }, executor: { kind: "agent", id: "codex" } },
      completionGateIds: []
    }
  }
};

test("event/head publisher commits one immutable event and exact head bytes together", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir });

    assert.deepEqual(store.read(), { schema: "task-event-stream/v1", revision: 0, events: [] });
    const receipt = store.append(event);
    const eventBytes = serializeTaskEvent(event);
    const eventDigest = `sha256:${createHash("sha256").update(eventBytes).digest("hex")}` as const;
    const headBytes = serializeEventHead({ revision: 1, opId: event.opId, eventDigest });

    assert.equal(receipt.status, "applied");
    assert.deepEqual(receipt.metrics, { gitProcesses: 3, nodeSyncs: 6,
      changedPaths: ["harness/events/head.json", "harness/events/op-1.json"] });
    assert.equal(store.append(event).revision, 1);
    assert.throws(() => store.append({ ...event, payload: { task: { ...event.payload.task, title: "different" } } }), /different event/u);
    assert.throws(() => store.append({ ...event, opId: "op-2", eventId: "event-2" }), /revision/u);
    assert.deepEqual(store.read().events, [event]);
    assert.equal(readFileSync(path.join(rootDir, "harness/events/op-1.json"), "utf8"), eventBytes);
    assert.equal(readFileSync(path.join(rootDir, "harness/events/head.json"), "utf8"), headBytes);
    assert.equal(existsSync(path.join(rootDir, "harness/task-events.ndjson")), false);
    assert.deepEqual(git(rootDir, "diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "HEAD").trim().split("\n").sort(), [
      "harness/events/head.json",
      "harness/events/op-1.json"
    ]);
  });
});

test("publication fsync count includes the instrumented Git process and stays within the hard budget", { skip: process.platform !== "darwin" }, async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const library = path.join(rootDir, "fsync-counter.dylib");
    const trace = path.join(rootDir, "fsync.trace");
    execFileSync("clang", ["-dynamiclib", "-Wno-deprecated-declarations", "-o", library,
      path.join(process.cwd(), "packages/kernel/test/store/fixtures/fsync-counter.c")]);
    const previous = { path: process.env.PATH, library: process.env.DYLD_INSERT_LIBRARIES, trace: process.env.HA_FSYNC_TRACE };
    process.env.PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].join(path.delimiter);
    const store = makeTaskEventStore({ rootDir });
    process.env.DYLD_INSERT_LIBRARIES = library;
    process.env.HA_FSYNC_TRACE = trace;
    try {
      const receipt = store.append(event);
      const traceBody = existsSync(trace) ? readFileSync(trace, "utf8") : "";
      const gitSyncs = traceBody.trim().split("\n").filter((line) => line === "fsync" || line === "fullfsync").length;
      assert.equal(receipt.metrics.nodeSyncs, 6);
      assert.equal(gitSyncs > 0, true, `Git publication must issue instrumented fsync calls; trace=${traceBody.trim()}`);
      assert.equal(receipt.metrics.nodeSyncs + gitSyncs <= 16, true, `publication issued ${receipt.metrics.nodeSyncs + gitSyncs} fsync calls`);
      context.diagnostic(`fsync-count node=${receipt.metrics.nodeSyncs} git=${gitSyncs} total=${receipt.metrics.nodeSyncs + gitSyncs}`);
    } finally {
      restoreEnv("PATH", previous.path);
      restoreEnv("DYLD_INSERT_LIBRARIES", previous.library);
      restoreEnv("HA_FSYNC_TRACE", previous.trace);
    }
  });
});

test("recovery clears the sole pending descriptor when publication died before the event write", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "before_event_write") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => store.append(event), /killpoint:before_event_write/u);

    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "cleared");
    assert.equal(recovered.publications, 0);
    assert.equal(makeTaskEventStore({ rootDir }).readEvent(event.opId), null);
    assert.equal(existsSync(path.join(rootDir, ".harness/event-publication.json")), false);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD").trim(), "1");
  });
});

test("recovery removes an uncommitted event when the head was never replaced", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "after_event_write") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => store.append(event), /killpoint:after_event_write/u);

    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "cleared");
    assert.equal(recovered.publications, 0);
    assert.equal(existsSync(path.join(rootDir, "harness/events/op-1.json")), false);
    assert.equal(makeTaskEventStore({ rootDir }).readHead(), null);
  });
});

test("recovery publishes the sole exact event/head pair left before Git commit", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "after_head_write") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => store.append(event), /killpoint:after_head_write/u);

    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "committed");
    assert.equal(recovered.publications, 1);
    assert.equal(recovered.elapsedMs < 100, true, `recovery took ${recovered.elapsedMs}ms`);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD").trim(), "2");
    assert.deepEqual(makeTaskEventStore({ rootDir }).read().events, [event]);
    assert.equal(existsSync(path.join(rootDir, ".harness/event-publication.json")), false);
  });
});

test("recovery recognizes the exact pair already committed before the response", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "after_git_commit") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => store.append(event), /killpoint:after_git_commit/u);

    const before = git(rootDir, "rev-parse", "HEAD").trim();
    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "already_committed");
    assert.equal(recovered.publications, 0);
    assert.equal(git(rootDir, "rev-parse", "HEAD").trim(), before);
    assert.deepEqual(makeTaskEventStore({ rootDir }).readEvent(event.opId), event);
    assert.equal(existsSync(path.join(rootDir, ".harness/event-publication.json")), false);
  });
});

test("recovery fails closed when the sole pending pair is not byte-exact", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "after_head_write") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => store.append(event), /killpoint:after_head_write/u);
    appendFileSync(path.join(rootDir, "harness/events/op-1.json"), " ");

    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "indeterminate");
    assert.equal(recovered.publications, 0);
    assert.equal(git(rootDir, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(existsSync(path.join(rootDir, ".harness/event-publication.json")), true);
  });
});

test("head is derivable from immutable events after the replaceable file is removed", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ rootDir });
    store.append(event);
    const expected = store.readHead();

    rmSync(store.headPath);

    assert.deepEqual(store.rebuildHead(), expected);
  });
});

test("startup recovery examines one in-flight pair without scanning 10,000 old events", async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const eventsRoot = path.join(rootDir, "harness/events");
    mkdirSync(eventsRoot, { recursive: true });
    let last = event;
    for (let revision = 1; revision <= 10_000; revision += 1) {
      last = eventAt(revision);
      writeFileSync(path.join(eventsRoot, `${last.opId}.json`), serializeTaskEvent(last));
    }
    const lastBytes = serializeTaskEvent(last);
    writeFileSync(path.join(eventsRoot, "head.json"), serializeEventHead({ revision: last.workspaceRevision, opId: last.opId,
      eventDigest: `sha256:${createHash("sha256").update(lastBytes).digest("hex")}` }));
    git(rootDir, "add", "--", "harness/events");
    git(rootDir, "commit", "--quiet", "-m", "10k event fixture");

    const next = eventAt(10_001);
    const interrupted = makeTaskEventStore({ rootDir, killpoint: (point) => {
      if (point === "after_head_write") throw new Error(`killpoint:${point}`);
    } });
    assert.throws(() => interrupted.append(next), /killpoint:after_head_write/u);

    const recovered = makeTaskEventStore({ rootDir }).recover();

    assert.equal(recovered.status, "committed");
    assert.equal(recovered.publications, 1);
    assert.equal(recovered.elapsedMs < 100, true, `10k recovery took ${recovered.elapsedMs}ms`);
    context.diagnostic(`recovery-10k elapsedMs=${recovered.elapsedMs.toFixed(3)} publications=${recovered.publications}`);
    assert.equal(makeTaskEventStore({ rootDir }).readEvent(next.opId)?.workspaceRevision, 10_001);
  });
});

function initRepo(rootDir: string): void {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Store Test");
  git(rootDir, "config", "user.email", "store-test@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "config", "maintenance.auto", "false");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function eventAt(revision: number): TaskCreatedEvent {
  const suffix = String(revision).padStart(5, "0");
  return { ...event, eventId: `event-${suffix}`, workspaceRevision: revision, opId: `op-${suffix}`, taskId: `task-${suffix}`,
    payload: { task: { ...event.payload.task, taskId: `task-${suffix}`, title: `Replay task ${suffix}` } } };
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
