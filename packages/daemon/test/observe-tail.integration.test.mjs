// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDaemonConnLog } from "../src/conn-log.ts";
import { createDaemonHostRepositoryApi } from "../src/daemon-host-repository-api.ts";
import { validateObserveTailResult } from "../src/protocol/daemon-protocol-gui-types.ts";
import { validateDaemonRpcCall } from "../src/protocol/daemon-protocol-rpc-validation.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { daemonRequestLogPath, openDaemonRequestLog } from "../src/request-log.ts";
import { openRepoCell } from "../src/repo-cell.ts";

const actor = { principal: { personId: "person-observer" }, executor: null };
const binding = { actor, source: "local" };
const at = (iso) => () => new Date(iso);

test("observe.tail exposes the 3x3 mode matrix and advances only when the source advances", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observe-tail-"));
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-observe-tail-user-"));
  const repoId = workspaceId("observe-tail");
  const daemonId = "observe-tail-daemon";
  let cell;
  try {
    initRepo(rootDir);
    const requestLog = openDaemonRequestLog({
      resolveRootDir: (candidate) => (candidate === repoId ? rootDir : undefined),
      now: at("2026-08-26T04:00:00.000Z"),
    });
    requestLog.record({
      method: "repo.tasks.list",
      repoId,
      command: "task-list",
      connectionId: "observe-request-1",
      auth: {
        transportKind: "unix-socket",
        unixSocketOwnerBoundary: {
          ownerUid: typeof process.getuid === "function" ? process.getuid() : 0,
          source: "unix-socket-filesystem-owner-boundary",
        },
      },
      executor: null,
      ok: true,
      outcome: "applied",
      code: null,
      opId: null,
      durationMs: 2,
    });
    const connLog = openDaemonConnLog({
      userRoot,
      daemonId,
      now: at("2026-08-26T04:00:00.000Z"),
    });
    connLog.connectionOpened("observe-connection-1", "unix-socket");
    await connLog.settle();

    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "observe-tail-local",
      mode: "local",
    });
    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-observe-first", title: "Observe first" }, binding)).outcome,
      "applied",
    );

    const firstEvents = await hostObserve(
      cell,
      { repoId, userRoot, daemonId },
      { kind: "events", direction: "history" },
    );
    assertAvailable(firstEvents, "local", "events");
    assert.ok(firstEvents.items.length > 0);
    assert.equal(firstEvents.liveCursor.kind, "events");
    const unchangedEvents = await cell.observeTail(
      { kind: "events", direction: "follow", cursor: firstEvents.liveCursor },
      { userRoot, daemonId },
    );
    assertAvailable(unchangedEvents, "local", "events");
    assert.deepEqual(unchangedEvents.items, []);
    assert.deepEqual(unchangedEvents.liveCursor, firstEvents.liveCursor);

    assert.equal(
      (await cell.run({ kind: "task-create", taskId: "task-observe-second", title: "Observe second" }, binding))
        .outcome,
      "applied",
    );
    const appendedEvents = await cell.observeTail(
      { kind: "events", direction: "follow", cursor: firstEvents.liveCursor },
      { userRoot, daemonId },
    );
    assertAvailable(appendedEvents, "local", "events");
    assert.ok(appendedEvents.items.length > 0);
    assert.ok(appendedEvents.liveCursor.revision > firstEvents.liveCursor.revision);

    const localRepoLog = await cell.observeTail({ kind: "repo-log", direction: "history" }, { userRoot, daemonId });
    assertAvailable(localRepoLog, "local", "repo-log");
    assert.equal(
      localRepoLog.items.some((item) => item.connectionId === "observe-request-1"),
      true,
    );
    const localDaemonLog = await cell.observeTail({ kind: "daemon-log", direction: "history" }, { userRoot, daemonId });
    assertAvailable(localDaemonLog, "local", "daemon-log");
    assert.equal(
      localDaemonLog.items.some((item) => item.event === "conn_open"),
      true,
    );
    const unchangedDaemonLog = await cell.observeTail(
      { kind: "daemon-log", direction: "follow", cursor: localDaemonLog.liveCursor },
      { userRoot, daemonId },
    );
    assertAvailable(unchangedDaemonLog, "local", "daemon-log");
    assert.deepEqual(unchangedDaemonLog.items, []);
    assert.deepEqual(unchangedDaemonLog.liveCursor, localDaemonLog.liveCursor);
    await cell.close();
    cell = undefined;

    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "observe-tail-center",
      mode: "remote-center",
    });
    assertAvailable(
      await cell.observeTail({ kind: "events", direction: "history" }, { userRoot, daemonId }),
      "remote-center",
      "events",
    );
    const centerRepoLog = await cell.observeTail({ kind: "repo-log", direction: "history" }, { userRoot, daemonId });
    assertUnavailable(centerRepoLog, "remote-center", "repo-log", "center-request-log-not-wired", null);
    assertAvailable(
      await cell.observeTail({ kind: "daemon-log", direction: "history" }, { userRoot, daemonId }),
      "remote-center",
      "daemon-log",
    );
    await cell.close();
    cell = undefined;

    seedEdgeView(rootDir, repoId, 7);
    cell = await openRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "observe-tail-edge",
      mode: "remote-edge",
    });
    const edgeEvents = await cell.observeTail({ kind: "events", direction: "history" }, { userRoot, daemonId });
    assertUnavailable(edgeEvents, "remote-edge", "events", "edge-mirror-has-no-events", 7);
    assertAvailable(
      await cell.observeTail({ kind: "repo-log", direction: "history" }, { userRoot, daemonId }),
      "remote-edge",
      "repo-log",
    );
    assertAvailable(
      await cell.observeTail({ kind: "daemon-log", direction: "history" }, { userRoot, daemonId }),
      "remote-edge",
      "daemon-log",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("observe.tail follows a conn-log file identity across rotation and reports a retention gap", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observe-gap-"));
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-observe-gap-user-"));
  const repoId = workspaceId("observe-tail-gap");
  const daemonId = "observe-tail-gap-daemon";
  let cell;
  try {
    initRepo(rootDir);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "observe-tail-gap" });
    const connLog = openDaemonConnLog({
      userRoot,
      daemonId,
      maxBytes: 1,
      keptGenerations: 1,
      now: at("2026-08-26T05:00:00.000Z"),
    });
    connLog.connectionOpened("gap-connection-1", "unix-socket");
    await connLog.settle();
    const beforeRetention = await cell.observeTail(
      { kind: "daemon-log", direction: "history" },
      { userRoot, daemonId },
    );
    assertAvailable(beforeRetention, "local", "daemon-log");
    assert.equal(beforeRetention.items.length, 1);

    connLog.connectionOpened("gap-connection-2", "unix-socket");
    await connLog.settle();
    const afterRename = await cell.observeTail(
      { kind: "daemon-log", direction: "follow", cursor: beforeRetention.liveCursor },
      { userRoot, daemonId },
    );
    assertAvailable(afterRename, "local", "daemon-log");
    assert.equal(afterRename.items.length, 1);
    assert.notEqual(afterRename.liveCursor.fileId, beforeRetention.liveCursor.fileId);
    const rotatedHistory = await cell.observeTail({ kind: "daemon-log", direction: "history" }, { userRoot, daemonId });
    assert.deepEqual(
      rotatedHistory.items.map((item) => item.conn),
      ["c-1", "c-2"],
    );

    connLog.connectionOpened("gap-connection-3", "unix-socket");
    await connLog.settle();
    const afterRetention = await cell.observeTail(
      { kind: "daemon-log", direction: "follow", cursor: beforeRetention.liveCursor },
      { userRoot, daemonId },
    );
    assert.equal(afterRetention.status, "gap");
    assert.equal(afterRetention.gap.reason, "cursor-file-not-retained");
    assert.equal(afterRetention.gap.requestedFileId, beforeRetention.liveCursor.fileId);
    assert.deepEqual(validateObserveTailResult(afterRetention), []);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  }
});

test("observe.tail opens a 5000-line JSONL source at the latest page and pages backward", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-observe-reverse-"));
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-observe-reverse-user-"));
  const repoId = workspaceId("observe-reverse");
  const daemonId = "observe-reverse-daemon";
  let cell;
  try {
    initRepo(rootDir);
    const logPath = daemonRequestLogPath(rootDir),
      fixture = Array.from({ length: 5_000 }, (_, index) =>
        JSON.stringify({ schema: "daemon-request-log/v1", at: `fixture-${index + 1}`, seq: index + 1 }),
      ).join("\n");
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${fixture}\n`);
    cell = await openRepoCell({ repoId, rootDir: canonicalRoot(rootDir), ownerId: "observe-reverse" });

    const started = performance.now(),
      latest = await cell.observeTail({ kind: "repo-log", direction: "history" }, { userRoot, daemonId }),
      elapsedMs = performance.now() - started;
    assertAvailable(latest, "local", "repo-log");
    assert.ok(elapsedMs < 1_000, `5000-line first page took ${elapsedMs.toFixed(1)}ms`);
    assert.deepEqual(
      latest.items.map((item) => item.seq),
      Array.from({ length: 64 }, (_, index) => 4_937 + index),
    );

    const seen = [...latest.items];
    let page = latest;
    while (!page.done) {
      page = await cell.observeTail(
        { kind: "repo-log", direction: "history", cursor: page.historyCursor },
        { userRoot, daemonId },
      );
      seen.unshift(...page.items);
    }
    assert.equal(seen.length, 5_000);
    assert.equal(seen[0].seq, 1);
    assert.equal(seen.at(-1).seq, 5_000);
    console.info(`observe.tail 5000-line first page: ${elapsedMs.toFixed(1)}ms`);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(userRoot, { recursive: true, force: true });
  }
});

async function hostObserve(cell, daemon, payload) {
  const context = {
    input: { userRoot: daemon.userRoot, daemonId: daemon.daemonId },
    cells: new Map([[daemon.repoId, cell]]),
    warming: new Map(),
    unavailable: new Map(),
    requireHostMode: () => undefined,
    attemptHostRecovery: async () => undefined,
    binding: async () => binding,
    hostCodedError: (code, message) => Object.assign(new Error(message), { code }),
    warmingMessage: () => "warming",
  };
  const call = { method: "observe.tail", params: { repo: { repoId: daemon.repoId }, payload } };
  assert.deepEqual(validateDaemonRpcCall(call), []);
  assert.notDeepEqual(
    validateDaemonRpcCall({ ...call, params: { ...call.params, payload: { kind: payload.kind } } }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      ...call,
      params: { ...call.params, payload: { kind: payload.kind, direction: "follow" } },
    }),
    [],
  );
  assert.notDeepEqual(
    validateDaemonRpcCall({
      ...call,
      params: {
        ...call.params,
        payload: { kind: payload.kind, direction: "follow", cursor: { kind: "events", revision: -1 } },
      },
    }),
    [],
  );
  return createDaemonHostRepositoryApi(context).read(daemon.repoId, "observe.tail", payload, {
    transportKind: "unix-socket",
  });
}

function assertAvailable(result, mode, kind) {
  assert.equal(result.mode, mode);
  assert.equal(result.kind, kind);
  assert.ok(result.status === "ready" || result.status === "pending", JSON.stringify(result));
  assert.deepEqual(validateObserveTailResult(result), []);
}

function assertUnavailable(result, mode, kind, reason, centerRevision) {
  assert.equal(result.mode, mode);
  assert.equal(result.kind, kind);
  assert.equal(result.status, "unavailable");
  assert.equal(result.unavailable.reason, reason);
  assert.equal(result.unavailable.centerRevision, centerRevision);
  assert.deepEqual(validateObserveTailResult(result), []);
}

function seedEdgeView(rootDir, repoId, revision) {
  const viewRoot = path.join(rootDir, ".fleet-view");
  const viewDir = path.join(viewRoot, "repos", repoId, "views", "observe-view");
  mkdirSync(path.join(viewDir, "cuts", String(revision)), { recursive: true });
  writeFileSync(
    path.join(viewDir, "current.json"),
    `${JSON.stringify({ cut: { revision, headDigest: "head-observe" }, manifestDigest: "manifest-observe" })}\n`,
  );
  writeFileSync(path.join(viewDir, "cuts", String(revision), "manifest.json"), `${JSON.stringify({ entries: [] })}\n`);
  writeFileSync(
    path.join(rootDir, "fleet-edge.json"),
    `${JSON.stringify({
      schema: "fleet-edge-config/v1",
      repoId,
      host: "127.0.0.1",
      port: 1,
      caPath: path.join(rootDir, "unused-ca.pem"),
      nodeId: "observe-node",
      credential: "unused-test-credential",
      assignmentId: "observe-assignment",
      viewRoot,
      quotaBytes: 1024,
    })}\n`,
  );
}

function initRepo(rootDir) {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Observe Tail Test");
  git(rootDir, "config", "user.email", "observe-tail@example.invalid");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "base");
}

function git(rootDir, ...args) {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
