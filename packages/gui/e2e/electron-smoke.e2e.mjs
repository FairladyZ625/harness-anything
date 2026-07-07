import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");
const processOutput = new WeakMap();
const rendererUrl = "http://127.0.0.1:5173";

test("Electron shell opens its first BrowserWindow", { timeout: 45_000 }, async (t) => {
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
      HARNESS_GUI_ROOT: repoRoot
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

  // Ported operator IA: the relation graph nav is labeled 关系图 and the graph
  // canvas is a React Flow surface. Decision/fact data is still mock, so the
  // view carries a visible MOCK banner.
  await page.getByRole("button", { name: /关系图/u }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  assert.equal(await page.getByText("MOCK").count() > 0, true, "mock-backed triadic views must be visibly labeled");
  assert.deepEqual(consoleFailures, [], "renderer emitted console errors");
});

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
