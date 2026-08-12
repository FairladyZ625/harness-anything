// harness-test-tier: contract
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  apiRouteContracts,
  createGuiServiceBridgeForDaemon,
  createLocalGuiServiceBridge,
  getShippedGuiBridgeMethods
} from "../src/index.ts";

test("GUI daemon bridge rejects malformed payload contracts before request dispatch", async () => {
  let requests = 0;
  const bridge = createGuiServiceBridgeForDaemon(async () => {
    requests += 1;
    return { ok: true };
  });

  const nonRecord = await bridge.invoke("getTaskDetail", "task-1") as Failure;
  assert.equal(nonRecord.ok, false);
  assert.equal(nonRecord.error?.code, "invalid_payload");
  assert.match(nonRecord.error?.hint ?? "", /taskId is required/u);
  assert.equal(requests, 0);
});

test("GUI daemon bridge exposes projection readers only through declared routes", async () => {
  const routeIds: string[] = [];
  const bridge = createGuiServiceBridgeForDaemon(async (route) => {
    routeIds.push(route.id);
    return { ok: true, details: { data: { ok: true, routeId: route.id } } };
  });

  assert.equal((await bridge.invoke("getTaskExecutions", { taskId: "task-1" }) as { readonly routeId?: string }).routeId, "executions.taskList");
  assert.equal((await bridge.invoke("getExecutionDetail", { executionId: "exe-1" }) as { readonly routeId?: string }).routeId, "executions.detail");
  assert.equal((await bridge.invoke("getReviewDetail", { reviewId: "rev-1" }) as { readonly routeId?: string }).routeId, "reviews.detail");
  assert.deepEqual(routeIds, ["executions.taskList", "executions.detail", "reviews.detail"]);
});

test("local GUI bridge fails closed without explicit daemon registration and never autostarts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-explicit-daemon-"));
  const userRoot = path.join(rootDir, "user-daemon");
  const previousUserRoot = process.env.HARNESS_DAEMON_USER_ROOT;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  try {
    const result = await createLocalGuiServiceBridge(rootDir).invoke("getTasks", null) as Failure;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "daemon_unavailable");
    assert.match(result.error?.hint ?? "", /workspace is not registered; run ha daemon repo register/u);
    assert.equal(existsSync(path.join(userRoot, "registry.json")), false);
    assert.equal(existsSync(path.join(userRoot, "run")), false);
  } finally {
    if (previousUserRoot === undefined) delete process.env.HARNESS_DAEMON_USER_ROOT;
    else process.env.HARNESS_DAEMON_USER_ROOT = previousUserRoot;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("renderer adapter contains no decision placeholder defaults", () => {
  const adapter = readFileSync(path.join(import.meta.dirname, "../src/renderer/triadic-data.ts"), "utf8");
  assert.doesNotMatch(adapter, /riskTier:\s*["']medium["']/u);
  assert.doesNotMatch(adapter, /proposedBy:\s*\{\s*kind:\s*["']system["']/u);
  assert.doesNotMatch(adapter, /id:\s*["']projection["']/u);
});

test("GUI service bridge methods remain registry-derived and deferred methods stay explicit", async () => {
  const activeGuiMethods = apiRouteContracts
    .map((route) => "guiBridgeMethod" in route ? route.guiBridgeMethod : undefined)
    .filter((method): method is string => typeof method === "string");
  assert.deepEqual(getShippedGuiBridgeMethods(), activeGuiMethods);

  const bridge = createGuiServiceBridgeForDaemon(async () => ({ ok: true }));
  const archive = await bridge.invoke("archiveTask", null) as Failure;
  assert.equal(archive.ok, false);
  assert.equal(archive.error?.code, "method_deferred");
  assert.match(archive.error?.hint ?? "", /Archive/u);

  const shell = await bridge.invoke("openShell", null) as Failure;
  assert.equal(shell.ok, false);
  assert.equal(shell.error?.code, "method_deferred");
  assert.match(shell.error?.hint ?? "", /terminal sessions/iu);
});

interface Failure {
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly hint: string };
}
