// harness-test-tier: integration
import assert from "node:assert/strict";
import { ownDaemonFixture } from "./daemon-cleanup.fixture.ts";

import { execFileSync, spawn, spawnSync } from "node:child_process";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { createServer } from "node:net";

import { hostname, tmpdir } from "node:os";

import path from "node:path";

import {
  JsonRpcLineClient,
  connectSocket,
  requestDaemonJsonRpcAt,
} from "../../daemon/src/client/local-json-rpc-client.ts";

import { streamAgentRuntimeAt } from "../../daemon/src/client/local-json-rpc-stream.ts";

import { localUserDaemonEndpoint } from "../../daemon/src/client/local-daemon-target.ts";

import { clearDaemonStoppedMarker } from "../../daemon/src/client/daemon-autostart.ts";

import { openDaemonLifecycleLog, readDaemonLifecycleRecords } from "../../daemon/src/lifecycle-log.ts";

import { currentDaemonProtocolVersion } from "../../daemon/src/protocol/version.ts";

import { readDaemonPid } from "../../daemon/src/runtime.ts";

import { openPersistentWriterEpoch } from "../../daemon/src/writer-epoch.ts";

import { cliDaemonServeLaunch } from "../src/daemon/client.ts";

import { seedSettingsEvent } from "../../daemon/test/repo-settings.fixture.ts";

import {
  canonicalEventWritePlan,
  makeTaskEventStore,
  activateEmptyCanonicalGeneration,
  registerDaemonRepo,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  type AgentDefinitionSnapshot,
  type AgentRuntimeEventV1,
  type TaskEventV1,
} from "../../kernel/src/index.ts";

import { WRITE_RECEIPT_SCHEMA } from "../../kernel/src/index.ts";

import { validateWriteReceipt } from "../../kernel/test/contracts/receipt-acceptance.fixtures.ts";

import { realizedTaskPlan } from "../../../tools/fixtures/task-plan.mjs";

const cli = path.resolve("packages/cli/src/index.ts");

function assertValidWriteReceipt(value: unknown): void {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  const allowed = new Set([...WRITE_RECEIPT_SCHEMA.required, ...WRITE_RECEIPT_SCHEMA.optional]),
    receipt = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => allowed.has(key)));
  assert.deepEqual(validateWriteReceipt(receipt), []);
}

function cliEnv(root: string, userRoot: string, actor?: string): NodeJS.ProcessEnv {
  const {
    HARNESS_ACTOR: _actor,
    HARNESS_DAEMON_ENDPOINT: _endpoint,
    HARNESS_DAEMON_REPO_ID: _repoId,
    HARNESS_DAEMON_ID: _daemonId,
    ...base
  } = process.env;
  return {
    ...base,
    HOME: path.join(root, ".home"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    HARNESS_DAEMON_USER_ROOT: userRoot,
    ...(actor ? { HARNESS_ACTOR: actor } : {}),
  };
}

function setup(): { parent: string; root: string; userRoot: string } {
  const parent = mkdtempSync(path.join(tmpdir(), "ha-autostart-")),
    root = path.join(parent, "repo"),
    userRoot = path.join(parent, "user");
  ownDaemonFixture({ parent, userRoot, daemonId: "default", env: cliEnv(root, userRoot) });
  setupRepository(parent, "repo");
  return { parent, root, userRoot };
}

function setupRepository(parent: string, name: string): string {
  const root = path.join(parent, name);
  mkdirSync(path.join(root, "harness"), { recursive: true });
  writeFileSync(path.join(root, "README.md"), "# Fixture\n", "utf8");
  writeFileSync(path.join(root, "harness/harness.yaml"), "layout:\n  authoredRoot: harness\n", "utf8");
  writeFileSync(
    path.join(root, "harness/people.yaml"),
    `schema: harness-people/v1\npeople:\n  - personId: owner\n    displayName: Owner\n    primaryEmail: owner@example.test\n    roles: [owner]\n    credentials:\n      - kind: unix-socket-owner-boundary\n        issuer: host:${hostname()}\n        subject: ${process.getuid?.() ?? 0}\nroles:\n  - roleId: owner\n    commandClasses: [admin, repo-write, repo-read, arbiter]\n`,
    "utf8",
  );
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Autostart Test");
  git(root, "config", "user.email", "autostart@example.test");
  git(root, "add", "README.md", "harness/harness.yaml", "harness/people.yaml");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

function register(root: string, userRoot: string, repoId: string): void {
  assert.equal(
    run(root, userRoot, ["init", "--repo-id", repoId, "--person-id", "owner", "--display-name", "Owner"]).ok,
    true,
  );
}

function registerSeeded(root: string, userRoot: string, repoId: string): void {
  assert.equal(
    run(root, userRoot, ["daemon", "repo", "register", "--repo-id", repoId, "--root", root, "--no-link"]).ok,
    true,
  );
}

function run(root: string, userRoot: string, args: readonly string[], actor?: string): Record<string, unknown> {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], {
    encoding: "utf8",
    env: cliEnv(root, userRoot, actor),
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
function published(root: string, userRoot: string, receipt: Record<string, unknown>): Record<string, unknown> {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, userRoot, ["receipt", "show", String(receipt.opId), ...wait]);
}

function waitForDaemonDown(userRoot: string): void {
  const socketPath = localUserDaemonEndpoint(userRoot, "default");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readDaemonPid(userRoot, "default") === null && !existsSync(socketPath)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error("previous daemon did not drain before the autostart probe");
}

async function waitForFileContent(target: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const content = existsSync(target) ? readFileSync(target, "utf8").trim() : "";
    if (content) return content;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for content in ${target}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for process ${pid} to exit`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function delay<T>(milliseconds: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), milliseconds));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function coded(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : null;
}

function stop(root: string, userRoot: string): void {
  if (readDaemonPid(userRoot, "default") !== null)
    spawnSync(process.execPath, [cli, "--root", root, "--json", "daemon", "stop"], {
      encoding: "utf8",
      env: cliEnv(root, userRoot),
    });
}

function statusOf(root: string, userRoot: string, taskId: string): string {
  const shown = run(root, userRoot, ["task", "show", taskId]);
  return (JSON.parse(String(shown.evidence)) as { task: { status: string } }).task.status;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function seedLegacyTask(root: string, userRoot: string, repoId: string, taskId: string): Promise<void> {
  const actor = { principal: { personId: "owner" }, executor: null } as const,
    event: TaskEventV1 = {
      schema: "task-event/v1",
      eventId: "event-contract-receipt",
      workspaceRevision: 1,
      opId: "op-contract-receipt",
      taskId,
      type: "task_created",
      actor,
      source: "local",
      occurredAt: "2026-08-18T00:00:00.000Z",
      payload: {
        task: {
          schema: "task/v2",
          taskId,
          title: "Legacy contract receipt",
          taskClass: "standard",
          status: "planned",
          graph: REPLAY_TASK_GRAPH,
          currentNode: "implementation",
          iteration: 0,
          createdBy: actor,
          completionGateIds: [],
          presetSnapshotDigest: null,
          pinned: false,
        },
      },
    };
  const authority = openPersistentWriterEpoch({ stateRoot: path.join(userRoot, "fleet"), holderId: "direct-store" }),
    lease = authority.acquire(repoId),
    store = makeTaskEventStore({
      repoId,
      rootDir: root,
      activationPreflight: activateEmptyCanonicalGeneration,
      writerFence: () => ({ repoId, holderId: lease.holderId, epoch: lease.epoch }),
    });
  try {
    store.append({ event, plan: taskLifecycleWritePlan(event), blobs: [] });
    await store.drain();
  } finally {
    authority.close();
  }
}

async function seedAttachableRuntime(
  root: string,
  userRoot: string,
  repoId: string,
  runtimeSessionId: string,
): Promise<void> {
  const actor = { principal: { personId: "owner" }, executor: null } as const,
    definition: AgentDefinitionSnapshot = {
      schema: "agent-definition-snapshot/v1",
      configVersion: 1,
      instanceId: "runtime-instance-attach-live",
      installationId: "runtime-installation-attach-live",
      kindId: "codex",
      providerId: "openai",
      model: "runtime-test-model",
      reasoningEffort: null,
      baseUrl: null,
      authMode: "subscription",
    },
    at = (revision: number) => `2026-08-23T00:00:0${revision}.000Z`,
    authority = openPersistentWriterEpoch({ stateRoot: path.join(userRoot, "fleet"), holderId: "direct-store" }),
    lease = authority.acquire(repoId),
    store = makeTaskEventStore({
      repoId,
      rootDir: root,
      activationPreflight: activateEmptyCanonicalGeneration,
      writerFence: () => ({ repoId, holderId: lease.holderId, epoch: lease.epoch }),
    }),
    firstRevision = store.read().revision + 1;
  const events: AgentRuntimeEventV1[] = [
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-installation-attach-live",
      workspaceRevision: firstRevision,
      opId: "op-runtime-installation-attach-live",
      type: "runtime_installation_observed",
      actor,
      source: "local",
      occurredAt: at(1),
      payload: {
        installationId: definition.installationId,
        kindId: definition.kindId,
        protocolFamily: "codex",
        hostRef: "host:local",
        version: "runtime-test",
        discoverySource: "wrapper",
        capabilities: ["structured_witness", "attach"],
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-dispatch-attach-live",
      workspaceRevision: firstRevision + 1,
      opId: "op-runtime-dispatch-attach-live",
      type: "runtime_dispatch_requested",
      actor,
      source: "local",
      occurredAt: at(2),
      payload: {
        dispatchId: "dispatch-runtime-attach-live",
        runtimeSessionId,
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        idempotencyKey: "runtime-attach-live",
        definitionSnapshotRef: "artifact:runtime-definition/attach-live",
        definitionSnapshot: definition,
      },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "event-runtime-started-attach-live",
      workspaceRevision: firstRevision + 2,
      opId: "op-runtime-started-attach-live",
      type: "runtime_session_started",
      actor,
      source: "local",
      occurredAt: at(3),
      payload: {
        runtimeSessionId,
        instanceId: definition.instanceId,
        installationId: definition.installationId,
        kindId: definition.kindId,
        definitionSnapshotRef: "artifact:runtime-definition/attach-live",
        launchGeneration: 1,
        attachable: true,
      },
    },
  ];
  try {
    for (const event of events)
      store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", event.opId), blobs: [] });
    await store.drain();
  } finally {
    authority.close();
  }
}

async function probeRuntimeAttach(
  endpoint: string,
  repoId: string,
  runtimeSessionId: string,
): Promise<{ readonly status: string; readonly elapsedMs: number; readonly initialValues: number }> {
  const started = performance.now();
  let initialValues = 0;
  try {
    const detach = await streamAgentRuntimeAt({
      socketPath: endpoint,
      repoId,
      payload: { runtimeSessionId, afterCursor: "stream:0" },
      onValue: () => {
        initialValues += 1;
      },
      timeoutMs: 2_000,
    });
    detach();
    return { status: "attached", elapsedMs: Math.round(performance.now() - started), initialValues };
  } catch (error) {
    return {
      status: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - started),
      initialValues,
    };
  }
}

function spawnCli(
  root: string,
  userRoot: string,
  args: readonly string[],
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env: cliEnv(root, userRoot),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

export {
  assert,
  execFileSync,
  spawn,
  spawnSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  createServer,
  hostname,
  tmpdir,
  path,
  JsonRpcLineClient,
  connectSocket,
  requestDaemonJsonRpcAt,
  streamAgentRuntimeAt,
  localUserDaemonEndpoint,
  clearDaemonStoppedMarker,
  openDaemonLifecycleLog,
  readDaemonLifecycleRecords,
  currentDaemonProtocolVersion,
  readDaemonPid,
  openPersistentWriterEpoch,
  cliDaemonServeLaunch,
  seedSettingsEvent,
  canonicalEventWritePlan,
  makeTaskEventStore,
  activateEmptyCanonicalGeneration,
  registerDaemonRepo,
  REPLAY_TASK_GRAPH,
  taskLifecycleWritePlan,
  WRITE_RECEIPT_SCHEMA,
  validateWriteReceipt,
  realizedTaskPlan,
  cli,
  assertValidWriteReceipt,
  cliEnv,
  setup,
  setupRepository,
  register,
  registerSeeded,
  run,
  published,
  waitForDaemonDown,
  waitForFileContent,
  waitForProcessExit,
  delay,
  processAlive,
  coded,
  stop,
  statusOf,
  git,
  escapeRegExp,
  seedLegacyTask,
  seedAttachableRuntime,
  probeRuntimeAttach,
  spawnCli,
};
