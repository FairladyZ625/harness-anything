import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, resolve } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import { discoverRuntimeInstallations } from "../../daemon/src/agent-runtime-instances.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { seedTriadicEvents, writeTriadicLedger } from "../test-support/triadic-ledger.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");
test("Electron shell opens its first BrowserWindow", { timeout: 90_000 }, async (t) => {
  const daemonFixture = await startGuiResidentDaemonFixture({ prefix: "ha-gui-e2e-", daemonId: "gui-e2e", repoId: "gui-e2e",
    task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" }, beforeRestart: seedTriadicEvents });
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
  assert.equal(await taskSurface.count(), 1, "renderer did not show the real task projection or its real empty state");

  // The shipped relation graph consumes the same daemon/service bridge as the
  // task projection. The hermetic authored ledger renders all three entity
  // shapes and the kernel-named relation rows without a mock banner.
  await page.getByRole("button", { name: /关系图/u }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  // 图默认落在领地(territory)模式:先点 decision chip 进入聚光灯(spotlight),
  // ego 画布才会展开 task/decision/fact 三类节点与 kernel 命名边。
  await page.locator('[data-testid="territory-chip"]', { hasText: "Expose the triadic projection" }).first().click();
  await page.getByText(/聚光灯/u).first().waitFor({ timeout: 10_000 });
  // ReactFlow 边在模式切换后异步入画:先等第一条边再计数,避免竞态误报。
  await page.locator(".react-flow__edge").first().waitFor({ timeout: 10_000 });
  // ego 画布节点是 EgoNode(实体语义走 data-entity,不再按类型注册 react-flow node)。
  assert.equal(await page.locator('[data-entity="task"]').count(), 1);
  assert.equal(await page.locator('[data-entity="decision"]').count(), 1);
  assert.equal(await page.locator('[data-entity="fact"]').count(), 1);
  // ego 画布按 hop 展开:焦点 decision 一跳内可见 derives + evidenced-by;
  // produces(task→fact)在 task 展开后才入画,不断言固定 3。
  assert.ok((await page.locator(".react-flow__edge").count()) >= 2, "spotlight must render kernel relation edges");
  assert.equal(await page.getByText("MOCK", { exact: true }).count(), 0, "triadic views must not be mock-backed");

  // Graph entities remain live links even though fact bodies are not part of
  // the rebuild read schema. Open the task through the graph drawer and follow
  // its derives edge to the exact decision.
  await page.locator('[data-entity="decision"]').first().click();
  await page.locator("aside").getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  await page.locator('[data-entity="task"]').first().click();
  await page.locator("aside").getByText("task-gui-smoke", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  await page.getByRole("button", { name: /派生自 dec_gui_smoke/u }).waitFor({ timeout: 10_000 });
  const relationLink = page.getByRole("button", { name: "decision/dec_gui_smoke", exact: true });
  await relationLink.waitFor();
  // 收起态终端 dock 的悬浮按钮(fixed 右下角,z-30)会盖住详情页链接:
  // 先移除再点,避免点击被遮罩吞掉。
  await page.evaluate(() => globalThis.document.querySelector('button[title="Ctrl+`"]')?.remove());
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

test("GUI dispatches a real daemon-mediated codex provider mission and exposes its settled artifact chain", { timeout: 90_000 }, async (t) => {
  const proofValue = `gui-real-dispatch-${Date.now()}`;
  const fakeProviderRoot = mkdtempSync(resolve(tmpdir(), "ha-gui-codex-provider-")), fakeProviderBin = resolve(fakeProviderRoot, "bin"), fakeProviderPath = resolve(fakeProviderBin, "codex"), originalPath = process.env.PATH ?? "";
  mkdirSync(fakeProviderBin);
  writeFakeCodex(fakeProviderPath);
  assert.equal(execFileSync(fakeProviderPath, ["--version"], { encoding: "utf8" }).trim(), "codex-cli e2e-fake");
  process.env.PATH = `${fakeProviderBin}${delimiter}${originalPath}`;
  let daemonFixture;
  try {
    daemonFixture = await startGuiResidentDaemonFixture({ prefix: "ha-gui-dispatch-", daemonId: "gui-e2e-dispatch", repoId: "gui-e2e-dispatch", task: { taskId: "task-gui-dispatch", title: "Run a real GUI dispatch" } });
  } catch (error) {
    process.env.PATH = originalPath;
    rmSync(fakeProviderRoot, { recursive: true, force: true });
    throw error;
  }
  const ledgerRoot = daemonFixture.rootDir, proofPath = resolve(ledgerRoot, "artifacts/gui-real-dispatch-proof.txt");
  let electronApp;
  t.after(async () => { try { if (electronApp) await closeElectronApp(electronApp); await daemonFixture.stop(); } finally { process.env.PATH = originalPath; rmSync(fakeProviderRoot, { recursive: true, force: true }); } });
  const codexInstallation = discoverRuntimeInstallations().find((installation) => installation.kindId === "codex" && installation.executablePath === realpathSync.native(fakeProviderPath));
  if (!codexInstallation) throw new Error("fake codex installation was not witnessed by the daemon runtime inventory");
  seedRealDispatchFixture(daemonFixture.userRoot, ledgerRoot, codexInstallation.installationId);

  electronApp = await electron.launch({ executablePath: electronPath, args: [resolve(guiRoot, "src/main/electron-main.ts")], cwd: repoRoot, env: { ...process.env, ...daemonFixture.env, HARNESS_GUI_ROOT: ledgerRoot } });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: "Agent 会话", exact: true }).click();
  await page.getByTestId("rail-agent-codex-sidecar").waitFor({ timeout: 20_000 });
  await page.getByTestId("rail-agent-codex-sidecar").click();
  await page.getByTestId("dispatch-entry-codex-sidecar").waitFor({ timeout: 20_000 });
  await page.getByTestId("dispatch-entry-codex-sidecar").click();
  const dialog = page.getByTestId("dispatch-dialog");
  await dialog.waitFor();
  await dialog.getByTestId("dispatch-task-task-gui-dispatch").click();
  await dialog.getByTestId("dispatch-mission").fill(`Use your shell to create artifacts/gui-real-dispatch-proof.txt with exactly GUI_REAL_DISPATCH_PROOF=${proofValue}, read it back, and report the exact line. Do not modify any other file.`);
  const submit = dialog.getByTestId("dispatch-submit");
  await submit.waitFor();
  assert.equal(await submit.isEnabled(), true, "real mission form did not become dispatchable");
  await submit.click();

  const dock = page.getByTestId("sessions-dock");
  await dock.waitFor({ timeout: 30_000 });
  const settledOutcome = page.locator('[data-testid^="runtime-outcome-"]').first();
  await settledOutcome.waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('[data-testid^="runtime-outcome-"]')].some((element) => ["succeeded", "failed", "unknown", "cancelled"].includes(element.textContent?.trim() ?? "")), undefined, { timeout: 150_000 });
  assert.equal((await settledOutcome.textContent())?.trim(), "succeeded", `real provider dispatch did not settle successfully: ${await settledOutcome.textContent()}`);
  const detail = page.getByTestId("session-detail");
  await detail.waitFor();
  await detail.getByText("exited", { exact: true }).waitFor({ timeout: 20_000 });
  const providerResult = await detail.locator("pre").textContent();
  assert.ok((providerResult ?? "").trim().length > 0, "daemon did not expose a provider result in the GUI");
  assert.match(providerResult ?? "", /GUI_REAL_DISPATCH_PROOF=/u, "provider result did not report the requested proof line");
  assert.equal(readFileSync(proofPath, "utf8"), `GUI_REAL_DISPATCH_PROOF=${proofValue}\n`, "provider did not create the requested proof file");

  await page.getByTestId("rail-orchestration-task-gui-dispatch").waitFor({ timeout: 20_000 });
  await page.getByTestId("rail-orchestration-task-gui-dispatch").click();
  const orchestration = page.getByTestId("orchestration-panel");
  const missionCell = orchestration.getByTestId("orchestration-missions").locator("button", { hasText: /dispatch_/u });
  await missionCell.waitFor({ timeout: 20_000 });
  const dispatchId = (await missionCell.innerText()).match(/dispatch_[a-z0-9]+/u)?.[0];
  assert.ok(dispatchId, "GUI did not display a dispatch id in the mission chain");
  for (const [kind, expected] of [["missions", /GUI_REAL_DISPATCH_PROOF=/u], ["dispatches", /runtimeSessionId/u], ["reports", /GUI_REAL_DISPATCH_PROOF=/u]] ) {
    const cell = orchestration.getByTestId(`orchestration-${kind}`).locator("button", { hasText: dispatchId });
    await cell.waitFor({ timeout: 20_000 });
    await cell.click();
    await page.waitForFunction((pattern) => new RegExp(pattern, "u").test(globalThis.document.querySelector('[data-testid="orchestration-preview"]')?.textContent ?? ""), expected.source);
    const preview = await orchestration.getByTestId("orchestration-preview").textContent();
    assert.match(preview ?? "", expected, `${kind} artifact preview was not visible in the GUI`);
  }
});

function seedRealDispatchFixture(userRoot, rootDir, installationId) {
  if (!installationId) throw new Error("codex installation is not witnessed by the daemon runtime inventory");
  mkdirSync(resolve(rootDir, "harness/agents"), { recursive: true });
  writeFileSync(resolve(rootDir, "harness/agents/codex-sidecar.json"), `${JSON.stringify({ schema: "agent-declaration/v1", id: "codex-sidecar", name: "Codex Sidecar", instructions: "Use the shell to complete the mission exactly and report the resulting file contents.", runtime_type: "codex" }, null, 2)}\n`);
  writeFileSync(resolve(userRoot, "runtime-instances.json"), `${JSON.stringify({ schema: "runtime-instances/v1", instances: [{ schemaVersion: 2, instanceId: "codex-sidecar", name: "Codex Sidecar", installationId, providerId: "codex_local_access", models: ["gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: true, auth: { mode: "api-key", credentialRef: "credential:v1:codex-sidecar" }, kindId: "codex", codex: { reasoningEffort: "low", baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true } }] }, null, 2)}\n`);
}

function writeFakeCodex(target) { const source = ["#!/usr/bin/env node", "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';", "import path from 'node:path';", "if (process.argv.includes('--version')) { console.log('codex-cli e2e-fake'); process.exit(0); }", "const prompt = readFileSync(0, 'utf8');", "const proof = /GUI_REAL_DISPATCH_PROOF=([A-Za-z0-9-]+)/u.exec(prompt)?.[1] ?? 'missing';", "const line = `GUI_REAL_DISPATCH_PROOF=${proof}`;", "mkdirSync(path.resolve(process.cwd(), 'artifacts'), { recursive: true });", "writeFileSync(path.resolve(process.cwd(), 'artifacts/gui-real-dispatch-proof.txt'), `${line}\\n`);", "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-gui-e2e-fake' }));", "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed', path: 'artifacts/gui-real-dispatch-proof.txt' } }));", "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: line } }));", "console.log(JSON.stringify({ type: 'turn.completed' }));"].join("\n"); writeFileSync(target, `${source}\n`, { mode: 0o755 }); chmodSync(target, 0o755); }

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
