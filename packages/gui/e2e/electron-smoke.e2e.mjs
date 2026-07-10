import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");
const processOutput = new WeakMap();
const rendererUrl = "http://127.0.0.1:5173";

test("Electron shell opens its first BrowserWindow", { timeout: 45_000 }, async (t) => {
  const ledgerRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-e2e-"));
  writeTriadicLedger(ledgerRoot);
  t.after(() => rmSync(ledgerRoot, { recursive: true, force: true }));
  const vite = startRendererServer();
  t.after(async () => {
    await stopProcess(vite);
  });
  await waitForHttpOk(rendererUrl, { signalProcess: vite });

  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve(guiRoot, "src/main/electron-main.ts")],
    cwd: repoRoot,
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: rendererUrl,
      HARNESS_GUI_ROOT: ledgerRoot,
      HARNESS_DAEMON_USER_ROOT: path.join(ledgerRoot, "daemon-user"),
      HARNESS_DAEMON_IDLE_MS: "5000"
    }
  });
  t.after(async () => {
    await electronApp.close().catch(() => undefined);
  });

  const page = await electronApp.firstWindow();
  const consoleFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleFailures.push(message.text());
  });
  page.on("pageerror", (error) => consoleFailures.push(error.message));
  await page.waitForLoadState("domcontentloaded");

  assert.equal(await page.title(), "Harness Anything");

  const windowCount = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  assert.equal(windowCount, 1);

  // The window opening is not enough: the sandboxed preload must have loaded
  // and exposed the IPC bridge, otherwise the shell is a hollow window.
  const bridgeType = await page.evaluate(() => typeof globalThis.harness);
  assert.equal(bridgeType, "object", "preload bridge (window.harness) failed to load");

  const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  await taskSurface.waitFor({ timeout: 20_000 });
  const taskSurfaceText = await taskSurface.textContent();
  assert.match(
    taskSurfaceText ?? "",
    /Active work|No task rows available from the local task bridge/u,
    "renderer did not show real task projection data or the real task empty state"
  );

  // The shipped relation graph consumes the same daemon/service bridge as the
  // task projection. The hermetic authored ledger renders all three entity
  // shapes and the kernel-named relation rows without a mock banner.
  await page.getByRole("button", { name: /关系图/u }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  await page.getByText(/3\s*节点\s*·\s*3\s*边/u).waitFor({ timeout: 10_000 });
  assert.equal(await page.locator(".react-flow__node-task").count(), 1);
  assert.equal(await page.locator(".react-flow__node-decision").count(), 1);
  assert.equal(await page.locator(".react-flow__node-fact").count(), 1);
  assert.equal(await page.locator(".react-flow__edge").count(), 3);
  assert.equal(await page.getByText("MOCK", { exact: true }).count(), 0, "triadic views must not be mock-backed");
  assert.deepEqual(consoleFailures, [], "renderer emitted console errors");
});

function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  const decisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_smoke");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(decisionDir, { recursive: true });
  writeFileSync(path.join(rootDir, "harness/harness.yaml"), [
    "schema: harness-anything/v1",
    "name: gui-triadic-smoke",
    "layout:",
    "  authoredRoot: harness",
    "  localRoot: .harness",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    "task_id: task-gui-smoke",
    "title: Render the real triadic projection",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Render the real triadic projection",
    "  url:",
    "  bindingCreatedAt: 2026-07-10T00:00:00.000Z",
    "  bindingFingerprint: sha256:gui-smoke",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: implementation",
    "relations:",
    "  - {relation_id: rel_bfa32bfd7f399b66, source: task/task-gui-smoke, target: fact/task-gui-smoke/F-ABCDEFGH, type: produces, strength: strong, direction: directed, origin: declared, rationale: \"Task produced the renderer projection evidence\", state: active}",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(taskDir, "facts.md"), [
    "- {fact_id: F-ABCDEFGH, statement: \"The GUI renderer received real triadic rows through the public bridge.\", source: \"GUI E2E\", observedAt: \"2026-07-10T00:30:00.000Z\", confidence: high, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:30:00.000Z\"}]}",
    ""
  ].join("\n"));
  writeFileSync(path.join(decisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_gui_smoke",
    "_coordinatorWatermark: gui-smoke-watermark",
    "title: \"Expose the triadic projection to the GUI\"",
    "state: proposed",
    "riskTier: high",
    "urgency: high",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedBy: {kind: \"agent\", id: \"codex\"}",
    "proposedAt: \"2026-07-10T00:00:00.000Z\"",
    "arbiter: {kind: \"human\", id: \"ZeyuLi\"}",
    "provenance:",
    "  - {runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:00:00.000Z\"}",
    "question: \"Should the GUI consume the public relation graph?\"",
    "chosen:",
    "  - {id: \"CH1\", text: \"Use the existing daemon/service bridge\"}",
    "rejected: []",
    "claims:",
    "  - {id: \"C1\", text: \"The public path preserves kernel relation names\", load_bearing: false}",
    "relations:",
    "  - {relation_id: rel_5287143733cccbd9, source: decision/dec_gui_smoke, target: task/task-gui-smoke, type: derives, strength: strong, direction: directed, origin: declared, rationale: \"Decision derived the GUI task\", state: active}",
    "  - {relation_id: rel_f0e4909f80e86478, source: decision/dec_gui_smoke/CH1, target: fact/task-gui-smoke/F-ABCDEFGH, type: evidenced-by, strength: strong, direction: directed, origin: declared, rationale: \"Fact evidences the public projection\", state: active}",
    "---",
    ""
  ].join("\n"));
}

function startRendererServer() {
  const child = spawn("npm", ["run", "dev", "-w", "@harness-anything/gui", "--", "--port", "5173", "--strictPort"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      BROWSER: "none"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
  child.stderr.on("data", (chunk) => chunks.push(String(chunk)));
  processOutput.set(child, chunks);
  return child;
}

async function waitForHttpOk(url, { signalProcess }) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    if (signalProcess.exitCode !== null) {
      throw new Error(`Renderer server exited before becoming ready with code ${signalProcess.exitCode}.\n${recentProcessOutput(signalProcess)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`Renderer server returned HTTP ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }

  throw new Error(`Renderer server did not become ready at ${url}: ${lastError?.message ?? "timeout"}`);
}

function recentProcessOutput(child) {
  return (processOutput.get(child) ?? []).join("").split("\n").slice(-20).join("\n");
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const close = once(child, "close");
  const timeout = sleep(5_000).then(() => "timeout");
  if (await Promise.race([close, timeout]) === "timeout") {
    child.kill("SIGKILL");
    await once(child, "close").catch(() => undefined);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
