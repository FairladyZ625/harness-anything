import assert from "node:assert/strict";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { writeTriadicLedger } from "../test-support/triadic-ledger.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");
test("Electron shell opens its first BrowserWindow", { timeout: 90_000 }, async (t) => {
  const daemonFixture = await startGuiResidentDaemonFixture({ prefix: "ha-gui-e2e-", daemonId: "gui-e2e", repoId: "gui-e2e",
    task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" } });
  const ledgerRoot = daemonFixture.rootDir;
  let electronApp;
  t.after(async () => {
    if (electronApp) await closeElectronApp(electronApp);
    await daemonFixture.stop();
  });
  writeTriadicLedger(ledgerRoot);

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve(guiRoot, "src/main/electron-main.ts")],
    cwd: repoRoot,
    env: {
      ...process.env,
      ...daemonFixture.env,
      HARNESS_GUI_ROOT: ledgerRoot,
    }
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(15_000);
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
  await page.evaluate(() => {
    globalThis.__harnessCopiedText = "";
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          globalThis.__harnessCopiedText = text;
        }
      }
    });
  });

  const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  const taskError = page.getByTestId("task-error-state");
  await taskSurface.or(taskError).first().waitFor({ timeout: 20_000 });
  if (await taskError.isVisible()) throw new Error(`GUI task bridge failed:\n${await taskError.innerText()}`);
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

  // Graph entities remain live links even though fact bodies are not part of
  // the rebuild read schema. Open the task through the graph drawer and follow
  // its derives edge to the exact decision.
  await page.locator(".react-flow__node-decision").click();
  await page.locator("aside").getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  await page.locator(".react-flow__node-task").click();
  await page.locator("aside").getByText("task-gui-smoke", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("button", { name: /派生自 dec_gui_smoke/u }).waitFor({ timeout: 10_000 });
  const relationLink = page.getByRole("button", { name: "decision/dec_gui_smoke", exact: true });
  await relationLink.waitFor();
  await relationLink.click();
  await page.locator('#decision-card-dec_gui_smoke[data-focused="true"]').waitFor();

  // The decision inbox card exposes the same paste-ready context shape.
  await page.getByRole("button", { name: /决策批准/u }).click();
  await page.getByText("Should the GUI consume the public relation graph?", { exact: false }).waitFor();
  await page.getByRole("button", { name: /复制上下文/u }).click();
  const decisionClipboard = await page.evaluate(() => globalThis.__harnessCopiedText);
  assert.match(decisionClipboard, /Expose the triadic projection to the GUI/u);
  assert.match(decisionClipboard, /Render the real triadic projection/u);
  assert.match(decisionClipboard, /当前问题/u);
  assert.deepEqual(consoleFailures, [], "renderer emitted console errors");
});

async function closeElectronApp(electronApp) {
  const child = electronApp.process();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await Promise.race([exited, sleep(5_000)]);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
