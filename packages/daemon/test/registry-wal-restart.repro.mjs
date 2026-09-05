#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const kernelUrl = pathToFileURL(path.join(repositoryRoot, "packages/kernel/src/index.ts")).href;
const walUrl = pathToFileURL(path.join(repositoryRoot, "packages/kernel/src/store/wal-event-log.ts")).href;

export async function reproduceRegistryWalRestart(arm, options = {}) {
  if (arm !== "migrate-v1" && arm !== "restart-v2" && arm !== "drop-v1-mapping")
    throw new Error(`unknown reproduction arm: ${arm}`);
  const fixtureRoot = options.fixtureRoot ?? mkdtempSync(path.join(tmpdir(), `ha-registry-wal-${arm}-`));
  const rootDir = path.join(fixtureRoot, "repository");
  const userRoot = path.join(fixtureRoot, "user-root");
  mkdirSync(rootDir, { recursive: true });
  mkdirSync(userRoot, { recursive: true });
  initRepo(rootDir);
  writeRegistry(userRoot, rootDir, arm === "restart-v2" ? "v2" : "v1");

  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", fileURLToPath(import.meta.url), "--child", rootDir],
    { encoding: "utf8", env: { ...process.env, HA_REPRO_KERNEL_URL: kernelUrl } },
  );
  if (child.status !== 0) throw new Error(`writer process failed (${child.status}): ${child.stderr || child.stdout}`);
  const before = observe(rootDir, userRoot, child.stdout.trim());

  const { makeTaskEventStore, readDaemonRegistry } = await import(kernelUrl);
  const { openWalEventLog } = await import(walUrl);
  const registry =
    arm === "drop-v1-mapping" ? { schema: "harness-daemon-registry/v2", repos: [] } : readDaemonRegistry({ userRoot });
  const registered = registry.repos.find((repo) => repo.repoId === "repro-repo");
  if (!registered?.canonicalRoot)
    throw new Error("restart cannot attach repro-repo because its registry mapping is absent");

  const store = makeTaskEventStore({ repoId: "repro-repo", rootDir: registered.canonicalRoot });
  const recovery = store.recover();
  await store.settleRecoveryMaterialization?.();
  await store.drain();
  const stream = store.read();
  const after = {
    registrySchema: readDaemonRegistry({ userRoot }).schema,
    eventHead: stream.revision,
    schemas: stream.events.map((event) => event.schema),
    walRevisions: openWalEventLog(rootDir, { mutable: false })
      .records()
      .map((record) => record.revision),
    taskPackageExists: existsSync(path.join(rootDir, "harness/tasks/task-repro/task.md")),
    factDocumentExists: existsSync(path.join(rootDir, "harness/facts/F-REPR0002.md")),
    canonicalCommit: git(rootDir, "rev-parse", "refs/ha/canonical"),
    recovery,
  };
  return { arm, fixtureRoot, before, after };
}

async function childWrite(rootDir) {
  const { REPLAY_TASK_GRAPH, compileFactWrite, makeTaskEventStore, sha256Text, taskLifecycleWritePlan } = await import(
    process.env.HA_REPRO_KERNEL_URL ?? kernelUrl
  );
  const store = makeTaskEventStore({
    repoId: "repro-repo",
    rootDir,
    walFlushEvents: 64,
    walFlushMs: 60_000,
  });
  const taskBody = "# Reproduction task\n",
    taskClaim = {
      path: "tasks/task-repro/task.md",
      sha256: sha256Text(taskBody),
      size: Buffer.byteLength(taskBody),
      mediaType: "text/markdown",
      policyId: "typed-machine-writer/v1",
    },
    taskEvent = {
      schema: "task-event/v1",
      eventId: "event-repro-task",
      workspaceRevision: 1,
      opId: "op-repro-task",
      taskId: "task-repro",
      type: "task_created",
      actor: { principal: { personId: "person-repro" }, executor: { kind: "agent", id: "codex" } },
      source: "local",
      occurredAt: "2026-09-05T00:00:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
          taskId: "task-repro",
          title: "Registry WAL restart reproduction",
          taskClass: "standard",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: {
            principal: { personId: "person-repro" },
            executor: { kind: "agent", id: "codex" },
          },
          completionGateIds: [],
          presetSnapshotDigest: null,
          pinned: false,
        },
        documentClaims: [taskClaim],
      },
    };
  const taskReceipt = store.append({
    event: taskEvent,
    plan: taskLifecycleWritePlan(taskEvent),
    blobs: [{ ...taskClaim, body: taskBody }],
  });
  const factWrite = compileFactWrite({
    event: {
      schema: "fact-event/v1",
      eventId: "event-repro-fact",
      workspaceRevision: 2,
      opId: "op-repro-fact",
      taskId: "task-repro",
      factId: "F-REPR0002",
      type: "fact_recorded",
      actor: { principal: { personId: "person-repro" }, executor: { kind: "agent", id: "codex" } },
      source: "local",
      occurredAt: "2026-09-05T00:00:01.000Z",
      payload: {
        statement: "The reproduction fact reached the durable WAL.",
        evidenceSource: "scripts/repro-registry-wal-restart.mjs",
        observedAt: "2026-09-05T00:00:01.000Z",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: ["episode"],
        provenance: [
          {
            runtime: "unavailable",
            sessionId: null,
            transcriptReachability: "unavailable",
            boundAt: "2026-09-05T00:00:01.000Z",
          },
        ],
      },
    },
  });
  const factReceipt = store.append(factWrite);
  process.stdout.write(`${JSON.stringify({ taskReceipt, factReceipt })}\n`);
  process.exit(0);
}

function observe(rootDir, userRoot, receipts) {
  const segmentPath = path.join(rootDir, ".harness/wal/seg-000000.log");
  return {
    registrySchema: JSON.parse(readFileSync(path.join(userRoot, "registry.json"), "utf8")).schema,
    gitEventHead: readGitEventHead(rootDir),
    walLines: existsSync(segmentPath) ? readFileSync(segmentPath, "utf8").trim().split("\n").filter(Boolean).length : 0,
    taskPackageExists: existsSync(path.join(rootDir, "harness/tasks/task-repro/task.md")),
    factDocumentExists: existsSync(path.join(rootDir, "harness/facts/F-REPR0002.md")),
    receipts: JSON.parse(receipts),
  };
}

function readGitEventHead(rootDir) {
  try {
    return JSON.parse(git(rootDir, "show", "refs/ha/canonical:harness/events/head.json")).revision;
  } catch {
    return 0;
  }
}

function writeRegistry(userRoot, rootDir, version) {
  const repo = {
    repoId: "repro-repo",
    canonicalRoot: realpathSync.native(rootDir),
    displayName: "WAL reproduction",
    authoredBranch: "master",
    ...(version === "v2" ? { mode: "local", connectionId: "local" } : {}),
    state: "enabled",
    registeredAt: "2026-09-05T00:00:00.000Z",
  };
  const registry =
    version === "v2"
      ? {
          schema: "harness-daemon-registry/v2",
          connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
          repos: [repo],
        }
      : { schema: "harness-daemon-registry/v1", repos: [repo] };
  writeFileSync(path.join(userRoot, "registry.json"), `${JSON.stringify(registry)}\n`);
}

function initRepo(rootDir) {
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Registry WAL Reproduction");
  git(rootDir, "config", "user.email", "registry-wal-repro@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
}

function git(rootDir, ...args) {
  return execFileSync("git", ["-C", rootDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (process.argv[2] === "--child") {
  await childWrite(process.argv[3]);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const requestedArm = process.argv[2];
  const arms = requestedArm ? [requestedArm] : ["migrate-v1", "restart-v2"];
  for (const arm of arms) process.stdout.write(`${JSON.stringify(await reproduceRegistryWalRestart(arm), null, 2)}\n`);
}
