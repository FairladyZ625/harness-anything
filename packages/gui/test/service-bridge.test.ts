// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  apiRouteContracts,
  createGuiServiceBridgeForDaemon,
  createLocalGuiServiceBridge,
  getShippedGuiBridgeMethods,
  packagedCliEntrypointPath,
  resolveGuiDaemonNodeRuntime,
  resolveGuiDaemonIdleExitMs
} from "../src/index.ts";
import { deriveRelationId, formatFactFlowRecord, formatRelationFlowRecord } from "../../kernel/src/index.ts";
import { buildTriadicRendererData } from "../src/renderer/triadic-data.ts";
import type {
  DecisionListSuccess,
  RelationGraphSuccess,
  TaskFactListSuccess
} from "../src/renderer/api-client.ts";
import {
  daemonPidFromStatus,
  daemonStatusData,
  initAuthoredGit,
  readDaemonStatus,
  stopDaemonProcess,
  withGuiDaemonEnv,
  writeExecutionEvidence
} from "./helpers/daemon-generation-lifecycle.ts";

test("GUI daemon autostart resolves system Node instead of Electron runtime", () => {
  const electronExecPath = "/Applications/Harness Anything.app/Contents/MacOS/Harness Anything";
  const systemNode = "/opt/homebrew/bin/node";
  const runtime = resolveGuiDaemonNodeRuntime({
    execPath: electronExecPath,
    env: {
      npm_node_execpath: electronExecPath,
      ELECTRON_RUN_AS_NODE: "1"
    },
    lookupNodeOnPath: () => systemNode
  });

  assert.equal(runtime.execPath, systemNode);
  assert.notEqual(runtime.execPath, electronExecPath);
  assert.deepEqual(runtime.execArgv, []);
  assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("GUI daemon autostart honors HARNESS_NODE_BIN before other Node candidates", () => {
  const runtime = resolveGuiDaemonNodeRuntime({
    execPath: "/Applications/Electron.app/Contents/MacOS/Electron",
    env: {
      HARNESS_NODE_BIN: "/custom/bin/node",
      npm_node_execpath: "/npm/bin/node"
    },
    lookupNodeOnPath: () => "/path/bin/node"
  });

  assert.equal(runtime.execPath, "/custom/bin/node");
});

test("GUI daemon keeps a warm generation across normal interaction pauses", () => {
  assert.equal(resolveGuiDaemonIdleExitMs({}), 5 * 60_000);
  assert.equal(resolveGuiDaemonIdleExitMs({ HARNESS_DAEMON_IDLE_MS: "1500" }), 1_500);
});

test("GUI daemon autostart uses packaged Node when system PATH has no Node", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-packaged-runtime-"));
  try {
    const packagedNode = path.join(rootDir, "node/darwin-arm64/node");
    mkdirSync(path.dirname(packagedNode), { recursive: true });
    writeFileSync(packagedNode, "");

    const runtime = resolveGuiDaemonNodeRuntime({
      execPath: "/Applications/Harness Anything.app/Contents/MacOS/Harness Anything",
      resourcesPath: rootDir,
      platform: "darwin",
      arch: "arm64",
      env: {
        PATH: "/usr/bin:/bin",
        npm_node_execpath: "/Applications/Harness Anything.app/Contents/MacOS/Harness Anything",
        ELECTRON_RUN_AS_NODE: "1"
      },
      lookupNodeOnPath: () => undefined
    });

    assert.equal(runtime.execPath, packagedNode);
    assert.deepEqual(runtime.execArgv, []);
    assert.equal(runtime.env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI packaged daemon entrypoint resolves to unpacked CLI dist", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-packaged-entry-"));
  try {
    const entrypoint = path.join(rootDir, "app/packages/cli/dist/cli/src/index.js");
    mkdirSync(path.dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, "");

    assert.equal(packagedCliEntrypointPath(rootDir), entrypoint);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI daemon bridge rejects malformed payload contracts before request dispatch", async () => {
  let requests = 0;
  const bridge = createGuiServiceBridgeForDaemon(async () => {
    requests += 1;
    return { ok: true };
  });

  const nonRecord = await bridge.invoke("getTaskDetail", "task-1") as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
  assert.equal(nonRecord.ok, false);
  assert.equal(nonRecord.error?.code, "invalid_payload");
  assert.match(nonRecord.error?.hint ?? "", /taskId is required/u);

  const malformedRecord = await bridge.invoke("setTaskStatus", { taskId: "task-1", status: "unknown-status" }) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
  assert.equal(malformedRecord.ok, false);
  assert.equal(malformedRecord.error?.code, "invalid_payload");
  assert.match(malformedRecord.error?.hint ?? "", /valid status/u);

  const malformedPage = await bridge.invoke("getExecutionEvidencePage", { limit: 1_000 }) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
  assert.equal(malformedPage.ok, false);
  assert.equal(malformedPage.error?.code, "invalid_payload");
  assert.match(malformedPage.error?.hint ?? "", /limit/u);

  const staleShape = await bridge.invoke("getExecutionEvidencePage", {
    limit: 25,
    cursor: {
      latestAt: "2026-07-13T00:00:00.000Z",
      executionId: "exe_00000000000000000000000001"
    }
  }) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
  assert.equal(staleShape.ok, false);
  assert.match(staleShape.error?.hint ?? "", /generation/u);

  assert.equal(requests, 0);
});

test("GUI daemon bridge exposes typed daemon log filters without broadening validation", async () => {
  const calls: Array<{ readonly routeId: string; readonly payload: unknown }> = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route, payload) => {
    calls.push({ routeId: route.id, payload });
    return {
      ok: true,
      details: {
        data: {
          schema: "daemon-log-page/v1",
          entries: [],
          nextCursor: null,
          truncated: false,
          droppedCount: 0
        }
      }
    };
  });

  const page = await bridge.invoke("getDaemonLogs", { limit: 25, levels: ["error"], errorOnly: true }) as { readonly schema?: string };
  assert.equal(page.schema, "daemon-log-page/v1");
  assert.deepEqual(calls, [{
    routeId: "daemon.logs.list",
    payload: { cursor: null, limit: 25, since: null, levels: ["error"], errorOnly: true }
  }]);

  const rejected = await bridge.invoke("getDaemonLogs", { limit: 201 }) as { readonly ok?: boolean; readonly error?: { readonly code?: string } };
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error?.code, "invalid_payload");
  assert.equal(calls.length, 1);
});

test("GUI daemon bridge exposes execution and review projection readers", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("getExecutions", null) as { readonly routeId?: string }).routeId, "executions.list");
  assert.equal((await bridge.invoke("getExecutionEvidencePage", { limit: 40 }) as { readonly routeId?: string }).routeId, "executions.evidencePage");
  assert.equal((await bridge.invoke("getTaskExecutions", { taskId: "task-1" }) as { readonly routeId?: string }).routeId, "executions.taskList");
  assert.equal((await bridge.invoke("getExecutionDetail", { executionId: "exe-1" }) as { readonly routeId?: string }).routeId, "executions.detail");
  assert.equal((await bridge.invoke("getReviewDetail", { reviewId: "rev-1" }) as { readonly routeId?: string }).routeId, "reviews.detail");
  assert.deepEqual(routeIds, ["executions.list", "executions.evidencePage", "executions.taskList", "executions.detail", "reviews.detail"]);
});

test("GUI daemon bridge exposes one batched facts reader", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("getFacts", null) as { readonly routeId?: string }).routeId, "facts.list");
  assert.deepEqual(routeIds, ["facts.list"]);
});

test("GUI daemon bridge exposes peripheral document list and read routes", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("getPeripheralDocuments", null) as { readonly routeId?: string }).routeId, "documents.peripheral.list");
  assert.equal((await bridge.invoke("getPeripheralDocument", { path: "adr/ADR-0001.md" }) as { readonly routeId?: string }).routeId, "documents.peripheral.read");
  assert.deepEqual(routeIds, ["documents.peripheral.list", "documents.peripheral.read"]);
});

test("GUI daemon bridge exposes one triadic projection snapshot", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("getTriadicProjection", null) as { readonly routeId?: string }).routeId, "triadic.snapshot");
  assert.deepEqual(routeIds, ["triadic.snapshot"]);
});

test("GUI daemon bridge exposes terminal lifecycle and streaming routes", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("terminalCreate", { name: "Terminal", backend: "direct-pty" }) as { readonly routeId?: string }).routeId, "terminal.sessions.create");
  assert.equal((await bridge.invoke("terminalList", null) as { readonly routeId?: string }).routeId, "terminal.sessions.list");
  assert.equal((await bridge.invoke("terminalGet", { sessionId: "term-1" }) as { readonly routeId?: string }).routeId, "terminal.sessions.get");
  assert.equal((await bridge.invoke("terminalAttach", { sessionId: "term-1" }) as { readonly routeId?: string }).routeId, "terminal.sessions.attach");
  assert.equal((await bridge.invoke("terminalDetach", { sessionId: "term-1" }) as { readonly routeId?: string }).routeId, "terminal.sessions.detach");
  assert.equal((await bridge.invoke("terminalTerminate", { sessionId: "term-1", confirmation: "terminate-terminal-session" }) as { readonly routeId?: string }).routeId, "terminal.sessions.terminate");
  assert.equal((await bridge.invoke("terminalWrite", { sessionId: "term-1", data: "pwd\r" }) as { readonly routeId?: string }).routeId, "terminal.sessions.write");
  assert.equal((await bridge.invoke("terminalRead", { sessionId: "term-1", cursor: 0, timeoutMs: 250 }) as { readonly routeId?: string }).routeId, "terminal.sessions.read");
  assert.equal((await bridge.invoke("terminalResize", { sessionId: "term-1", columns: 100, rows: 30 }) as { readonly routeId?: string }).routeId, "terminal.sessions.resize");
  assert.equal((await bridge.invoke("terminalExit", { sessionId: "term-1" }) as { readonly routeId?: string }).routeId, "terminal.sessions.close");
  assert.deepEqual(routeIds, [
    "terminal.sessions.create",
    "terminal.sessions.list",
    "terminal.sessions.get",
    "terminal.sessions.attach",
    "terminal.sessions.detach",
    "terminal.sessions.terminate",
    "terminal.sessions.write",
    "terminal.sessions.read",
    "terminal.sessions.resize",
    "terminal.sessions.close"
  ]);
});

test("GUI daemon bridge rejects terminal termination without explicit confirmation", async () => {
  let dispatched = false;
  const bridge = createGuiServiceBridgeForDaemon(async () => {
    dispatched = true;
    return { ok: true };
  });
  const result = await bridge.invoke("terminalTerminate", { sessionId: "term-1" }) as { readonly ok?: boolean; readonly error?: { readonly code?: string } };
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "invalid_payload");
  assert.equal(dispatched, false);
});

test("GUI service bridge reaches application service through the daemon client", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-daemon-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    const list = await withGuiDaemonEnv(rootDir, async () => {
      const bridge = createLocalGuiServiceBridge(rootDir);
      return bridge.invoke("getTasks", null) as Promise<{ readonly ok: boolean; readonly tasks: readonly unknown[] }>;
    });

    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);
    assert.equal(existsSync(path.join(rootDir, "user-daemon", "registry.json")), true);
    assert.match(readFileSync(path.join(rootDir, "user-daemon", "registry.json"), "utf8"), /"repoId": "canonical"/u);
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI evidence route reuses one daemon generation across an interaction pause", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-evidence-generation-"));
  let daemonPid: number | undefined;
  try {
    writeExecutionEvidence(rootDir, "Warm daemon evidence", writeTaskIndex);
    initAuthoredGit(rootDir);
    const bridge = createLocalGuiServiceBridge(rootDir);
    await withGuiDaemonEnv(rootDir, async () => {
      const first = await bridge.invoke("getExecutionEvidencePage", { limit: 1 }) as {
        readonly ok: boolean;
        readonly groups?: ReadonlyArray<{ readonly title?: string }>;
      };
      assert.equal(first.ok, true);
      assert.equal(first.groups?.[0]?.title, "Warm daemon evidence");
      const firstStatus = daemonStatusData(await readDaemonStatus(rootDir));
      daemonPid = daemonPidFromStatus(firstStatus);
      assert.equal(typeof daemonPid, "number");

      await new Promise<void>((resolve) => setTimeout(resolve, 900));
      const second = await bridge.invoke("getExecutionEvidencePage", { limit: 1 }) as { readonly ok: boolean };
      assert.equal(second.ok, true);
      const secondStatus = daemonStatusData(await readDaemonStatus(rootDir));
      assert.equal(daemonPidFromStatus(secondStatus), daemonPid);
      const generation = secondStatus.projectionGeneration as {
        readonly state?: string;
        readonly validationRuns?: number;
        readonly fenceRuns?: number;
      };
      assert.equal(generation.state, "ready");
      assert.equal(generation.validationRuns, 1);
      assert.ok((generation.fenceRuns ?? 0) >= 3);
    }, { idleMs: "1500" });
  } finally {
    await stopDaemonProcess(daemonPid);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI bridge projects a hermetic decision-task-fact ledger into renderer data", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-triadic-"));
  try {
    writeTriadicLedger(rootDir);
    const bridge = createLocalGuiServiceBridge(rootDir);
    const projection = await withGuiDaemonEnv(rootDir, async () => {
      const graph = await bridge.invoke("getRelationGraph", null);
      const decisions = await bridge.invoke("getDecisions", null);
      const facts = await bridge.invoke("getTaskFacts", { taskId: "task-1" });
      assert.equal((graph as { readonly ok?: unknown }).ok, true, JSON.stringify(graph));
      assert.equal((decisions as { readonly ok?: unknown }).ok, true, JSON.stringify(decisions));
      assert.equal((facts as { readonly ok?: unknown }).ok, true, JSON.stringify(facts));
      assert.equal((facts as { readonly facts?: ReadonlyArray<unknown> }).facts?.length, 1, JSON.stringify(facts));
      return buildTriadicRendererData({
        graph: graph as RelationGraphSuccess,
        decisions: decisions as DecisionListSuccess,
        factResults: [facts as TaskFactListSuccess]
      });
    });

    assert.deepEqual(projection.decisions.map((decision) => decision.decisionId), ["dec_gui"]);
    assert.deepEqual(projection.decisions[0]?.riskTier, "medium");
    assert.deepEqual(projection.decisions[0]?.urgency, "medium");
    assert.deepEqual(projection.decisions[0]?.attribution, {
      originator: {
        principal: { kind: "person", personId: "ZeyuLi" },
        executor: { kind: "agent", id: "codex" }
      },
      latestActor: {
        principal: { kind: "person", personId: "ZeyuLi" },
        executor: null
      },
      trailCount: 2,
      completeness: "host-only"
    });
    assert.deepEqual(projection.decisions[0]?.provenance, [{ runtime: "codex", sessionId: "session-gui", boundAt: "2026-07-10T00:00:00.000Z" }]);
    assert.deepEqual(projection.facts.map((fact) => fact.anchor), ["task-1/F-12345678"]);
    assert.deepEqual(projection.facts.map((fact) => fact.confidence), ["high"]);
    assert.deepEqual(projection.facts[0]?.source, "test");
    assert.deepEqual(projection.facts[0]?.provenance, [{ runtime: "codex", sessionId: "session-gui", boundAt: "2026-07-10T00:00:00.000Z" }]);
    assert.deepEqual(projection.factAnchors.map((anchor) => anchor.factRef), ["fact/task-1/F-12345678"]);
    assert.deepEqual(projection.coverageRows.map((row) => row.coveringFactRef), ["fact/task-1/F-12345678"]);
    assert.deepEqual(projection.relations.map((relation) => relation.kind).sort(), [
      "derives",
      "evidenced-by",
      "produces"
    ]);
    assert.equal(
      projection.relations.some((relation) => relation.from.startsWith("fact/") && relation.to.startsWith("task/")),
      false
    );
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("renderer adapter contains no decision placeholder defaults", () => {
  const adapter = readFileSync(path.join(import.meta.dirname, "../src/renderer/triadic-data.ts"), "utf8");

  assert.doesNotMatch(adapter, /riskTier:\s*["']medium["']/u);
  assert.doesNotMatch(adapter, /proposedBy:\s*\{\s*kind:\s*["']system["']/u);
  assert.doesNotMatch(adapter, /id:\s*["']projection["']/u);
});

test("GUI service bridge preserves document results and daemon-side validation shape", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Task One", "planned");
    const bridge = createLocalGuiServiceBridge(rootDir);

    const document = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" })
    ) as { readonly ok: boolean; readonly body?: string };
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Task One/);

    const rejected = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTaskDocument", { taskId: "task-1", path: "../../../../.harness-private/review.md" })
    ) as { readonly ok: boolean; readonly error?: { readonly code: string } };
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error?.code, "invalid_payload");

    const windowsPath = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTaskDocument", { taskId: "task-1", path: "C:\\Users\\name\\secret.md" })
    ) as { readonly ok: boolean; readonly error?: { readonly code: string } };
    assert.equal(windowsPath.ok, false);
    assert.equal(windowsPath.error?.code, "invalid_payload");
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge honors explicit authored root context through daemon", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    writeTaskIndex(rootDir, "task-1", "Custom GUI Task", "planned", ".custom-harness");
    const bridge = createLocalGuiServiceBridge(rootDir, { authoredRoot: ".custom-harness" });

    const list = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTasks", null)
    ) as { readonly ok: boolean; readonly tasks: readonly unknown[] };
    assert.equal(list.ok, true);
    assert.equal(list.tasks.length, 1);

    const document = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" })
    ) as { readonly ok: boolean; readonly body?: string };
    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Custom GUI Task/);
    assert.equal(existsSync(path.join(rootDir, "harness/tasks/task-1/INDEX.md")), false);
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge resolves project root before daemon routing", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    mkdirSync(path.join(rootDir, "workspace", "nested"), { recursive: true });
    writeTaskIndex(rootDir, "task-1", "Subdir GUI Task", "planned");
    const nestedRoot = path.join(rootDir, "workspace", "nested");
    const canonicalRoot = realpathSync.native(rootDir);
    const bridge = createLocalGuiServiceBridge(nestedRoot);

    const document = await withGuiDaemonEnv(rootDir, () =>
      bridge.invoke("getTaskDocument", { taskId: "task-1", path: "INDEX.md" })
    ) as { readonly ok: boolean; readonly body?: string; readonly error?: { readonly code: string } };

    assert.equal(document.ok, true);
    assert.match(document.body ?? "", /Subdir GUI Task/);
    assert.notEqual(document.error?.code, "path_outside_project");
    const registry = JSON.parse(readFileSync(path.join(rootDir, "user-daemon", "registry.json"), "utf8")) as { readonly repos: ReadonlyArray<{ readonly canonicalRoot: string }> };
    assert.equal(registry.repos[0]?.canonicalRoot, canonicalRoot);
    assert.notEqual(registry.repos[0]?.canonicalRoot, path.resolve(nestedRoot));
  } finally {
    await waitForDaemonIdle();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge refuses custom authored root when an existing daemon layout cannot be verified", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  let daemonPid: number | undefined;
  try {
    writeTaskIndex(rootDir, "task-1", "Default GUI Task", "planned");
    const defaultBridge = createLocalGuiServiceBridge(rootDir);
    const customBridge = createLocalGuiServiceBridge(rootDir, { authoredRoot: ".custom-harness" });
    const customList = await withGuiDaemonEnv(rootDir, async () => {
      const defaultList = await defaultBridge.invoke("getTasks", null) as { readonly ok: boolean };
      assert.equal(defaultList.ok, true);
      const status = daemonStatusData(await readDaemonStatus(rootDir));
      assert.equal(status.started, true);
      daemonPid = daemonPidFromStatus(status);
      assert.equal(typeof daemonPid, "number");
      return customBridge.invoke("getTasks", null);
    }, { idleMs: "1500" }) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(customList.ok, false);
    assert.equal(customList.error?.code, "daemon_layout_conflict");
    assert.match(customList.error?.hint ?? "", /layout/u);
  } finally {
    await stopDaemonProcess(daemonPid);
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("GUI service bridge shipped methods are registry-driven and deferred methods return explicit errors", async () => {
  const activeGuiMethods = apiRouteContracts
    .map((route) => "guiBridgeMethod" in route ? route.guiBridgeMethod : undefined)
    .filter((method): method is string => typeof method === "string");

  assert.deepEqual(getShippedGuiBridgeMethods(), activeGuiMethods);
  const shippedMethods = new Set<string>(getShippedGuiBridgeMethods());
  assert.equal(shippedMethods.has("archiveTask"), false);
  assert.equal(shippedMethods.has("openShell"), false);

  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-bridge-"));
  try {
    writeHarnessConfig(rootDir);
    const bridge = createLocalGuiServiceBridge(rootDir);
    const archive = await bridge.invoke("archiveTask", null) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(archive.ok, false);
    assert.equal(archive.error?.code, "method_deferred");
    assert.match(archive.error?.hint ?? "", /Archive/);

    const shell = await bridge.invoke("openShell", null) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(shell.ok, false);
    assert.equal(shell.error?.code, "method_deferred");
    assert.match(shell.error?.hint ?? "", /terminal sessions/i);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeTaskIndex(rootDir: string, taskId: string, title: string, status: string, authoredRoot = "harness"): void {
  writeHarnessConfig(rootDir, authoredRoot);
  mkdirSync(path.join(rootDir, authoredRoot, "tasks", taskId), { recursive: true });
  writeFileSync(path.join(rootDir, authoredRoot, "tasks", taskId, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    `task_id: ${taskId}`,
    `title: ${title}`,
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    `  status: ${status}`,
    "  ref: ",
    `  titleSnapshot: ${title}`,
    "  url: ",
    "  bindingCreatedAt: 2026-06-12T00:00:00.000Z",
    "  bindingFingerprint: sha256:test",
    "packageDisposition: active",
    "vertical: default",
    "preset: default",
    "---",
    ""
  ].join("\n"), "utf8");
}

function writeHarnessConfig(rootDir: string, authoredRoot = "harness"): void {
  mkdirSync(path.join(rootDir, "harness"), { recursive: true });
  writeFileSync(path.join(rootDir, "harness", "harness.yaml"), [
    "schema: harness-anything/v1",
    "name: gui-bridge-test",
    "layout:",
    `  authoredRoot: ${authoredRoot}`,
    "  localRoot: .harness",
    ""
  ].join("\n"), "utf8");
}

function writeTriadicLedger(rootDir: string): void {
  writeTaskIndex(rootDir, "task-1", "Triadic GUI task", "active");
  const taskDir = path.join(rootDir, "harness/tasks/task-1");
  const taskIndexPath = path.join(taskDir, "INDEX.md");
  const taskIndex = readFileSync(taskIndexPath, "utf8");
  writeFileSync(taskIndexPath, taskIndex.replace(/---\n$/u, [
    "relations:",
    `  ${formatRelationFlowRecord({
      relation_id: deriveRelationId({ source: "task/task-1", target: "fact/task-1/F-12345678", type: "produces", direction: "directed" }),
      source: "task/task-1",
      target: "fact/task-1/F-12345678",
      type: "produces",
      strength: "strong",
      direction: "directed",
      origin: "declared",
      rationale: "Task completion produced the fact",
      state: "active"
    })}`,
    "---",
    ""
  ].join("\n")), "utf8");
  writeFileSync(path.join(taskDir, "facts.md"), [
    formatFactFlowRecord({
      fact_id: "F-12345678",
      statement: "Renderer projection fact",
      source: "test",
      observedAt: "2026-07-10T00:00:00.000Z",
      confidence: "high",
      memoryClass: "semantic",
      memoryTags: ["pattern"],
      provenance: [{ runtime: "codex", sessionId: "session-gui", boundAt: "2026-07-10T00:00:00.000Z" }]
    }),
    ""
  ].join("\n"), "utf8");

  const decisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui");
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_gui",
    "_coordinatorWatermark: gui-test",
    "title: \"Use the triadic GUI projection\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedAt: \"2026-07-10T00:00:00.000Z\"",
    "decidedAt: \"2026-07-10T01:00:00.000Z\"",
    "provenance:",
    "  - { runtime: \"codex\", sessionId: \"session-gui\", boundAt: \"2026-07-10T00:00:00.000Z\" }",
    "question: \"Expose the relation graph to the renderer?\"",
    "chosen:",
    "  - { id: \"CH1\", text: \"Use the public projection path\" }",
    "rejected: []",
    "claims:",
    "  - { id: \"CH1\", text: \"The renderer consumes kernel relation names\", load_bearing: true }",
    "relations:",
    `  ${formatRelationFlowRecord({
      relation_id: deriveRelationId({ source: "decision/dec_gui", target: "task/task-1", type: "derives", direction: "directed" }),
      source: "decision/dec_gui",
      target: "task/task-1",
      type: "derives",
      strength: "strong",
      direction: "directed",
      origin: "declared",
      rationale: "Decision derived the GUI task",
      state: "active"
    })}`,
    `  ${formatRelationFlowRecord({
      relation_id: deriveRelationId({ source: "decision/dec_gui/CH1", target: "fact/task-1/F-12345678", type: "evidenced-by", direction: "directed" }),
      source: "decision/dec_gui/CH1",
      target: "fact/task-1/F-12345678",
      type: "evidenced-by",
      strength: "strong",
      direction: "directed",
      origin: "declared",
      rationale: "Fact evidences the chosen path",
      state: "active"
    })}`,
    "---",
    "",
    "# Use the triadic GUI projection",
    ""
  ].join("\n"), "utf8");

  const attributionDir = path.join(rootDir, "harness/attribution-events");
  mkdirSync(attributionDir, { recursive: true });
  const baseEvent = {
    schema: "attribution-event/v1",
    journalRecordSchema: "write-journal/v2",
    entityId: "decision/dec_gui",
    principalSource: { kind: "migration", evidenceRef: "test/gui" },
    recordedAt: "2026-07-10T01:00:00.000Z",
    payloadHash: "gui-payload-hash",
    payloadRef: { path: "test/gui", sha256: "gui-payload-sha" }
  } as const;
  writeFileSync(path.join(attributionDir, "decision-propose.jsonl"), `${JSON.stringify({
    ...baseEvent,
    eventId: "evt_gui_propose",
    opId: "op_gui_propose",
    kind: "decision_propose",
    actor: {
      principal: { kind: "person", personId: "ZeyuLi" },
      executor: { kind: "agent", id: "codex" }
    },
    executorSource: "client-asserted",
    at: "2026-07-10T00:00:00.000Z"
  })}\n`, "utf8");
  writeFileSync(path.join(attributionDir, "decision-accept.jsonl"), `${JSON.stringify({
    ...baseEvent,
    eventId: "evt_gui_accept",
    opId: "op_gui_accept",
    kind: "decision_accept",
    actor: {
      principal: { kind: "person", personId: "ZeyuLi" },
      executor: null
    },
    executorSource: "none",
    at: "2026-07-10T01:00:00.000Z"
  })}\n`, "utf8");
}

function waitForDaemonIdle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 700));
}
