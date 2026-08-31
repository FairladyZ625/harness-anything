#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { REPLAY_TASK_GRAPH } from "../../packages/kernel/src/domain/task-graph.ts";
import { taskLifecycleWritePlan } from "../../packages/kernel/src/domain/task-lifecycle-publication.ts";
import { sha256Text } from "../../packages/kernel/src/integrity/stable-hash.ts";
import { makeWalShadowEventStore } from "../../packages/kernel/src/store/wal-shadow-event-store.ts";

const count = Number(process.argv[2] ?? 5_000);
const useBulkWrite = process.argv.includes("--bulk");
if (!Number.isSafeInteger(count) || count < 1) throw new Error("event count must be a positive integer");

const rootDir = mkdtempSync(path.join(tmpdir(), "ha-wal-hot-path-"));
const git = (...args) =>
  execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

try {
  git("init", "--quiet");
  git("config", "user.name", "WAL Benchmark");
  git("config", "user.email", "wal-benchmark@example.invalid");
  git("commit", "--allow-empty", "--quiet", "-m", "base");
  const store = makeWalShadowEventStore({
    repoId: "wal-hot-path-benchmark",
    rootDir,
    walFlushEvents: count + 1,
    walFlushMs: 3_600_000,
  });
  const bulk = useBulkWrite ? store.beginBulkWrite?.() : undefined;
  const appendStarted = performance.now();
  for (let revision = 1; revision <= count; revision += 1) store.append(bundle(revision));
  const appendMs = performance.now() - appendStarted;
  const readStarted = performance.now();
  const firstRead = store.read().revision;
  const secondRead = store.read().revision;
  const twoReadsMs = performance.now() - readStarted;
  const settlementStarted = performance.now();
  await bulk?.finish();
  await store.drain();
  const settlementMs = performance.now() - settlementStarted;
  const indexed = git("ls-files", "-v").split("\n").filter(Boolean);
  process.stdout.write(
    `${JSON.stringify(
      {
        schema: "wal-hot-path-benchmark/v1",
        events: count,
        bulkWrite: useBulkWrite,
        appendMs: Number(appendMs.toFixed(3)),
        eventsPerSecond: Number(((count * 1_000) / appendMs).toFixed(3)),
        twoReadsMs: Number(twoReadsMs.toFixed(3)),
        readRevisions: [firstRead, secondRead],
        settlementMs: Number(settlementMs.toFixed(3)),
        commits: Number(git("rev-list", "--count", "HEAD")) - 1,
        skipWorktreeEntries: indexed.filter((entry) => entry.startsWith("S ")).length,
        worktreeFiles:
          Number(git("ls-files").split("\n").filter(Boolean).length) -
          indexed.filter((entry) => entry.startsWith("S ")).length,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  rmSync(rootDir, { recursive: true, force: true });
}

function bundle(revision) {
  const body = `revision ${revision}\n`;
  const claim = {
    path: "tasks/perf/task.md",
    sha256: sha256Text(body),
    size: Buffer.byteLength(body),
    mediaType: "text/markdown",
    policyId: "typed-machine-writer/v1",
  };
  const event = {
    schema: "task-event/v1",
    eventId: `event-${revision}`,
    workspaceRevision: revision,
    opId: `op-${revision}`,
    taskId: "perf",
    type: "task_created",
    actor: {
      principal: { personId: "person-1" },
      executor: { kind: "agent", id: "benchmark" },
    },
    source: "local",
    occurredAt: "2026-08-31T00:00:00.000Z",
    payload: {
      task: {
        schema: "task/v2",
        taskId: "perf",
        title: "Performance fixture",
        taskClass: "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        createdBy: {
          principal: { personId: "person-1" },
          executor: { kind: "agent", id: "benchmark" },
        },
        completionGateIds: [],
        presetSnapshotDigest: null,
        pinned: false,
      },
      documentClaims: [claim],
    },
  };
  return {
    event,
    plan: taskLifecycleWritePlan(event),
    blobs: [{ sha256: claim.sha256, size: claim.size, mediaType: claim.mediaType, body }],
  };
}
