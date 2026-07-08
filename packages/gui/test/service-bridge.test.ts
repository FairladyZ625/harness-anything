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
  resolveGuiDaemonNodeRuntime
} from "../src/index.ts";

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

  assert.equal(requests, 0);
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
  try {
    writeTaskIndex(rootDir, "task-1", "Default GUI Task", "planned");
    const defaultBridge = createLocalGuiServiceBridge(rootDir);
    const defaultList = await withGuiDaemonEnv(rootDir, () =>
      defaultBridge.invoke("getTasks", null)
    ) as { readonly ok: boolean };
    assert.equal(defaultList.ok, true);

    const customBridge = createLocalGuiServiceBridge(rootDir, { authoredRoot: ".custom-harness" });
    const customList = await withGuiDaemonEnv(rootDir, () =>
      customBridge.invoke("getTasks", null)
    ) as { readonly ok: boolean; readonly error?: { readonly code: string; readonly hint: string } };
    assert.equal(customList.ok, false);
    assert.equal(customList.error?.code, "daemon_layout_conflict");
    assert.match(customList.error?.hint ?? "", /layout/u);
  } finally {
    await waitForDaemonIdle();
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

async function withGuiDaemonEnv<T>(rootDir: string, run: () => Promise<T>): Promise<T> {
  const previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT;
  const previousIdleMs = process.env.HARNESS_DAEMON_IDLE_MS;
  process.env.HARNESS_DAEMON_USER_ROOT = path.join(rootDir, "user-daemon");
  process.env.HARNESS_DAEMON_IDLE_MS = "250";
  try {
    return await run();
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previousUserRoot);
    restoreEnv("HARNESS_DAEMON_IDLE_MS", previousIdleMs);
  }
}

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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function waitForDaemonIdle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 700));
}
