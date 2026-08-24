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
  const daemonFixture = await startGuiResidentDaemonFixture({
    prefix: "ha-gui-e2e-",
    daemonId: "gui-e2e",
    repoId: "gui-e2e",
    task: { taskId: "task-gui-smoke", title: "Render the real triadic projection" },
    beforeRestart: seedTriadicEvents,
  });
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
    },
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
        },
      },
    });
  });

  const taskSurface = page.getByTestId("real-task-summary").or(page.getByTestId("task-empty-state"));
  const taskError = page.getByTestId("task-error-state");
  await taskSurface.or(taskError).first().waitFor({ timeout: 20_000 });
  if (await taskError.isVisible()) throw new Error(`GUI task bridge failed:\n${await taskError.innerText()}`);
  assert.equal(await taskSurface.count(), 1, "renderer did not show the real task projection or its real empty state");

  // W5 IA 重构:一级导航 = 工作区 / 决策 / 运行时 / 系统;事实分诊·执行证据入口
  // 随页面撤销(内容并入 Task 详情),总览保留在「工作区」之下。
  // W6 IA 拆分:「运行时」组 = 会话 / Agent(含 Squad)/ Provider 三个独立工作区,
  // 原「Agent 运行时」聚合入口随页面撤销。
  const sidebarText = await page.locator("aside").first().innerText();
  for (const group of [
    "工作区",
    "决策",
    "运行时",
    "系统",
    "总览",
    "看板",
    "关系图",
    "决策批准",
    "决策池",
    "会话",
    "Agent · 含 Squad",
    "Provider",
  ]) {
    assert.ok(sidebarText.includes(group), `first-level nav must still expose ${group}`);
  }
  for (const retired of ["事实分诊", "执行证据", "管理", "Agent 运行时"]) {
    assert.ok(!sidebarText.includes(retired), `retired nav entry ${retired} must be gone from the sidebar`);
  }

  // The shipped relation graph consumes the same daemon/service bridge as the
  // task projection. The hermetic authored ledger renders all three entity
  // shapes and the kernel-named relation rows without a mock banner.
  await page.getByRole("button", { name: /关系图/u }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  // 图默认落在领地(territory)模式:先点 decision chip 进入聚光灯(spotlight),
  // ego 画布才会展开 task/decision/fact 三类节点与 kernel 命名边。
  await page.locator('[data-testid="territory-chip"]', { hasText: "Expose the triadic projection" }).first().click();
  await page
    .getByText(/聚光灯/u)
    .first()
    .waitFor({ timeout: 10_000 });
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
  await page.locator("aside").getByText("task/task-gui-smoke", { exact: true }).waitFor();
  await page.getByRole("button", { name: "打开", exact: true }).click();
  // W3 起 Task 详情是分页签的:上游 decision 归「关系」页签,默认页签是「概况」;
  // 同一次重构把关系类型拆成了独立的 label badge,链接按钮上只剩 peer 引用。
  await page.getByRole("tab", { name: "关系" }).click();
  const relationLink = page.getByRole("button", { name: "decision/dec_gui_smoke", exact: true });
  await relationLink.waitFor({ timeout: 10_000 });
  const relationRowText = await relationLink.locator("xpath=..").innerText();
  assert.match(relationRowText, /派生自/u, "the upstream decision must still be labelled as a derives edge");
  // 收起态终端 dock 的悬浮按钮(fixed 右下角,z-30)会盖住详情页链接:
  // 先移除再点,避免点击被遮罩吞掉。
  await page.evaluate(() => globalThis.document.querySelector('button[title="Ctrl+`"]')?.remove());
  await relationLink.click();
  // W4 可寻址路由:decision 引用直达决策详情页(详情栏 + 邻域画布),
  // 不再落决策池列表页。
  await page.getByTestId("decision-detail-view").waitFor({ timeout: 10_000 });
  await page.getByText("Should the GUI consume the public relation graph?", { exact: false }).first().waitFor();

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

test(
  "GUI creates a Runtime and Agent from zero, invokes its selected Skill, and exposes the settled artifact chain",
  { timeout: 90_000 },
  async (t) => {
    const proofValue = `gui-real-dispatch-${Date.now()}`,
      skillProofValue = `manifest-observed-${Date.now()}`;
    const fakeProviderRoot = mkdtempSync(resolve(tmpdir(), "ha-gui-codex-provider-")),
      fakeProviderBin = resolve(fakeProviderRoot, "bin"),
      fakeProviderPath = resolve(fakeProviderBin, "codex"),
      originalPath = process.env.PATH ?? "";
    mkdirSync(fakeProviderBin);
    writeFakeCodex(fakeProviderPath);
    assert.equal(execFileSync(fakeProviderPath, ["--version"], { encoding: "utf8" }).trim(), "codex-cli e2e-fake");
    process.env.PATH = `${fakeProviderBin}${delimiter}${originalPath}`;
    let daemonFixture;
    try {
      daemonFixture = await startGuiResidentDaemonFixture({
        prefix: "ha-gui-dispatch-",
        daemonId: "gui-e2e-dispatch",
        repoId: "gui-e2e-dispatch",
        task: { taskId: "task-gui-dispatch", title: "Run a real GUI dispatch" },
      });
    } catch (error) {
      process.env.PATH = originalPath;
      rmSync(fakeProviderRoot, { recursive: true, force: true });
      throw error;
    }
    const ledgerRoot = daemonFixture.rootDir,
      proofPath = resolve(ledgerRoot, "artifacts/gui-real-dispatch-proof.txt"),
      skillCandidate = resolve(ledgerRoot, ".agents/skills/gui-proof-skill");
    let electronApp;
    t.after(async () => {
      try {
        if (electronApp) await closeElectronApp(electronApp);
        await daemonFixture.stop();
      } finally {
        process.env.PATH = originalPath;
        rmSync(fakeProviderRoot, { recursive: true, force: true });
      }
    });
    const codexInstallation = discoverRuntimeInstallations().find(
      (installation) =>
        installation.kindId === "codex" && installation.executablePath === realpathSync.native(fakeProviderPath),
    );
    if (!codexInstallation)
      throw new Error("fake codex installation was not witnessed by the daemon runtime inventory");
    assert.deepEqual(codexInstallation.models, ["gpt-5.6-sol", "gpt-5.6-terra"]);
    assert.equal(codexInstallation.defaultModel, "gpt-5.6-sol");
    mkdirSync(skillCandidate, { recursive: true });
    const skillPath = realpathSync.native(skillCandidate);
    writeFileSync(
      resolve(skillPath, "SKILL.md"),
      `# GUI proof skill\n\nWhen selected, read this file and report GUI_MANIFEST_MARKER:${skillProofValue}.\n`,
    );

    electronApp = await electron.launch({
      executablePath: electronPath,
      args: [resolve(guiRoot, "src/main/electron-main.ts")],
      cwd: repoRoot,
      env: { ...process.env, ...daemonFixture.env, HARNESS_GUI_ROOT: ledgerRoot },
    });
    const page = await electronApp.firstWindow();
    page.setDefaultTimeout(20_000);
    await page.waitForLoadState("domcontentloaded");
    // W6 IA 拆分:原「Agent 运行时」聚合入口撤销,「运行时」组 = 会话 / Agent(含
    // Squad)/ Provider 三个独立工作区。从零建 Runtime 走 Provider 入口,建 Agent 走
    // Agent 入口;派工 settle 后应用自动跳会话入口看它跑(session/<id> 可寻址)。
    await page.getByRole("button", { name: /^(?:Provider|Providers)$/u }).click();

    await page.getByTestId("runtime-new-runtimes").click();
    const runtimeDialog = page.getByTestId("new-runtime-dialog");
    await runtimeDialog.waitFor();
    await runtimeDialog.getByRole("button", { name: "Codex", exact: true }).click();
    const fakeInstallationChoice = runtimeDialog.locator("button", { hasText: codexInstallation.installationId });
    await fakeInstallationChoice.waitFor();
    await fakeInstallationChoice.click();
    await runtimeDialog.getByTestId("new-runtime-id").fill("gui-from-zero");
    await runtimeDialog.getByLabel(/^(?:名称|Name)$/u).fill("GUI From Zero");
    // model 面自 bd7d9422e 起是多选 checkbox 列表,不再是单选 select。原断言
    // inputValue()==="" 表达的语义是「不必手动指定 model 就能建」;在多选形态下
    // 等价形态是:探测到的模型默认全部预勾选,用户不做任何选择即可提交。
    const modelList = runtimeDialog.getByTestId("new-runtime-models");
    await modelList.getByText("gpt-5.6-sol", { exact: true }).waitFor({ state: "attached" });
    const detectedCount = await modelList.locator('input[type="checkbox"]').count();
    assert.ok(detectedCount > 0, "model detection must populate the runtime model list");
    assert.equal(
      await modelList.locator('input[type="checkbox"]:checked').count(),
      detectedCount,
      "detected models must come pre-selected so creating a Runtime needs no manual model pick",
    );
    assert.equal(
      await runtimeDialog.getByTestId("new-runtime-model-custom").count(),
      0,
      "custom model input must stay opt-in",
    );
    const createRuntime = runtimeDialog.getByTestId("new-runtime-create");
    assert.equal(
      await createRuntime.isEnabled(),
      true,
      "blank-model Runtime form did not become creatable from the detected default",
    );
    await createRuntime.click();
    await page.getByTestId("rail-runtime-gui-from-zero").waitFor({ timeout: 20_000 });
    const savedRuntime = JSON.parse(
      readFileSync(resolve(daemonFixture.userRoot, "runtime-instances.json"), "utf8"),
    ).instances.find((instance) => instance.instanceId === "gui-from-zero");
    assert.equal(
      savedRuntime?.installationId,
      codexInstallation.installationId,
      "e2e Runtime did not bind the witnessed fake Codex installation",
    );

    await page.getByRole("button", { name: /^(?:Agents · Squads|Agent · 含 Squad)$/u }).click();
    await page.getByTestId("runtime-new-agents").click();
    const agentDialog = page.getByTestId("new-agent-dialog");
    await agentDialog.waitFor();
    await agentDialog.getByRole("button", { name: /(?:空白创建|Blank)/u }).click();
    await agentDialog.getByTestId("new-agent-id").fill("gui-from-zero-agent");
    await agentDialog.getByLabel(/^(?:名称|Name)$/u).fill("GUI From Zero Agent");
    await agentDialog.getByTestId("new-agent-create").click();
    const agentCard = page.getByTestId("agent-card-gui-from-zero-agent");
    await agentCard.waitFor({ timeout: 20_000 });
    await agentCard
      .getByTestId("agent-instructions")
      .fill("Use every selected Skill before completing the mission, then report the exact proof values.");
    await agentCard.getByTestId("agent-skill-search").fill("gui-proof-skill");
    const skillChoice = agentCard.locator("button", { hasText: "gui-proof-skill" });
    await skillChoice.waitFor();
    assert.ok(
      (await skillChoice.innerText()).includes(skillPath),
      "Skill selector did not expose the absolute .agents path",
    );
    await skillChoice.click();
    await agentCard.getByTestId("agent-preset").fill("standard-task");
    const presetChoice = agentCard.locator("button", { hasText: "standard-task" });
    await presetChoice.waitFor();
    await presetChoice.click();
    assert.equal(
      await agentCard.getByTestId("agent-model-select").inputValue(),
      "",
      "Agent must retain the Runtime provider default unless the user chooses an override",
    );
    await agentCard.getByTestId("agent-save").click();
    await page.waitForFunction(() =>
      globalThis.document.querySelector('[data-testid="agent-save"]')?.hasAttribute("disabled"),
    );
    const savedAgent = JSON.parse(readFileSync(resolve(ledgerRoot, "harness/agents/gui-from-zero-agent.json"), "utf8"));
    assert.deepEqual(savedAgent.skills, [{ id: "gui-proof-skill", path: skillPath }]);
    assert.equal(savedAgent.preset, "standard-task");

    await page.getByTestId("dispatch-entry-gui-from-zero-agent").click();
    const dialog = page.getByTestId("dispatch-dialog");
    await dialog.waitFor();
    await dialog.getByTestId("dispatch-task-task-gui-dispatch").click();
    await dialog
      .getByTestId("dispatch-mission")
      .fill(
        `Use your shell to create artifacts/gui-real-dispatch-proof.txt with exactly GUI_REAL_DISPATCH_PROOF=${proofValue}, read it back, and report the exact line. Do not modify any other file.`,
      );
    const submit = dialog.getByTestId("dispatch-submit");
    await submit.waitFor();
    assert.equal(await submit.isEnabled(), true, "real mission form did not become dispatchable");
    await submit.click();

    const sessionRow = page
      .getByTestId("runtime-rail")
      .locator('[data-testid^="rail-session-"]', { hasText: "Run a real GUI dispatch" })
      .first();
    await sessionRow.waitFor({ timeout: 30_000 });
    const settledOutcome = sessionRow.locator('[data-testid^="runtime-outcome-"]');
    await settledOutcome.waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () =>
        [...globalThis.document.querySelectorAll('[data-testid^="runtime-outcome-"]')].some(
          (element) =>
            element.closest("button")?.textContent?.includes("Run a real GUI dispatch") &&
            ["succeeded", "failed", "cancelled"].includes(element.textContent?.trim() ?? ""),
        ),
      undefined,
      { timeout: 150_000 },
    );
    assert.equal(
      (await settledOutcome.textContent())?.trim(),
      "succeeded",
      `real provider dispatch did not settle successfully: ${await settledOutcome.textContent()}`,
    );
    await sessionRow.click();
    const detail = page.getByTestId("session-detail");
    await detail.waitFor();
    await detail.getByText("exited", { exact: true }).waitFor({ timeout: 20_000 });
    const providerResult = await detail.locator("pre").textContent();
    assert.ok((providerResult ?? "").trim().length > 0, "daemon did not expose a provider result in the GUI");
    assert.match(
      providerResult ?? "",
      /GUI_REAL_DISPATCH_PROOF=/u,
      "provider result did not report the requested proof line",
    );
    assert.ok(
      (providerResult ?? "").includes(`GUI_MANIFEST_OBSERVED:${skillProofValue}`),
      `provider did not read the selected Skill manifest:\n${providerResult}`,
    );
    assert.ok(
      (providerResult ?? "").includes(`GUI_SKILL_PATH=${resolve(skillPath, "SKILL.md")}`),
      "provider prompt did not contain the selected Skill manifest's absolute path",
    );
    assert.equal(
      readFileSync(proofPath, "utf8"),
      `GUI_REAL_DISPATCH_PROOF=${proofValue}\n`,
      "provider did not create the requested proof file",
    );

    // W5:「编排」rail 段随入口撤销——派工链归 Task 详情:「派工」页签读结构化派工读面
    // (dispatch 身份 + runtime session + report),mission/report 工件文档在「文件」
    // 页签(documents.list / document.read,与原编排视图同一读面)。同一批 artifact
    // 必须仍可见可读,否则撤销入口就丢了东西。
    const runtimeSessionId = /rail-session-(.+)/u.exec((await sessionRow.getAttribute("data-testid")) ?? "")?.[1] ?? "";
    assert.ok(runtimeSessionId, "settled session row did not expose its runtime session id");
    await page.getByTestId("session-open-task").click();
    await page.getByTestId("task-detail-view").waitFor({ timeout: 10_000 });
    await page.getByRole("tab", { name: "派工" }).click();
    const dispatchTab = page.getByTestId("task-dispatch-tab");
    const dispatchChain = dispatchTab.locator('[data-testid^="dispatch-chain-"]').first();
    await dispatchChain.waitFor({ timeout: 20_000 });
    assert.match(
      await dispatchTab.textContent(),
      new RegExp(runtimeSessionId, "u"),
      "dispatch chain lost the runtime session id",
    );
    const dispatchId = (await dispatchChain.getAttribute("data-testid"))?.slice("dispatch-chain-".length);
    assert.ok(dispatchId, "GUI did not display a dispatch id in the dispatch chain");
    const reportText = dispatchTab.locator("pre").first();
    await reportText.waitFor({ timeout: 20_000 });
    assert.match(
      (await reportText.textContent()) ?? "",
      /GUI_REAL_DISPATCH_PROOF=/u,
      "dispatch chain did not render the settled report",
    );
    for (const [kind, dirName] of [
      ["mission", "missions/"],
      ["report", "reports/"],
    ]) {
      await page.getByRole("tab", { name: "文件" }).click();
      const documentTree = page.getByTestId("task-document-tree");
      // 文档树默认只展开根级目录:先展开 missions//reports/ 目录,再点 dispatch 工件叶节点。
      const dirToggle = documentTree.locator("button", { hasText: dirName }).first();
      await dirToggle.waitFor({ timeout: 20_000 });
      await dirToggle.click();
      const docLeaf = documentTree.locator("button", { hasText: dispatchId }).first();
      await docLeaf.waitFor({ timeout: 10_000 });
      await docLeaf.click();
      const bodyHandle = await page.waitForFunction(
        (pattern) => {
          const text =
            globalThis.document.querySelector('[data-testid="task-files-tab"] [data-testid="doc-reader"]')
              ?.textContent ?? "";
          return new RegExp(pattern, "u").test(text) ? text : null;
        },
        /GUI_REAL_DISPATCH_PROOF=/u.source,
        { timeout: 20_000 },
      );
      assert.match(
        (await bodyHandle.jsonValue()) ?? "",
        /GUI_REAL_DISPATCH_PROOF=/u,
        `${kind} artifact preview was not visible in the GUI`,
      );
    }
  },
);

function writeFakeCodex(target) {
  const source = [
    "#!/usr/bin/env node",
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const args = process.argv.slice(2);",
    "if (args.includes('--version')) { console.log('codex-cli e2e-fake'); process.exit(0); }",
    "if (args.join(' ') === 'debug models --bundled') { console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }, { slug: 'gpt-5.6-terra' }] })); process.exit(0); }",
    "if (args[0] === 'login' && args[1] === 'status') process.exit(0);",
    "if (args[0] === 'login') process.exit(0);",
    "const prompt = readFileSync(0, 'utf8');",
    "const proof = /GUI_REAL_DISPATCH_PROOF=([A-Za-z0-9-]+)/u.exec(prompt)?.[1] ?? 'missing';",
    "const skillFile = /^- gui-proof-skill: (.+)$/mu.exec(prompt)?.[1]?.trim() ?? '';",
    "const skillText = skillFile ? readFileSync(skillFile, 'utf8') : '';",
    "const skillProof = /GUI_MANIFEST_MARKER:([A-Za-z0-9-]+)/u.exec(skillText)?.[1] ?? 'missing';",
    "const line = `GUI_REAL_DISPATCH_PROOF=${proof}`;",
    "const result = `${line}\\nGUI_MANIFEST_OBSERVED:${skillProof}\\nGUI_SKILL_PATH=${skillFile}`;",
    "mkdirSync(path.resolve(process.cwd(), 'artifacts'), { recursive: true });",
    "writeFileSync(path.resolve(process.cwd(), 'artifacts/gui-real-dispatch-proof.txt'), `${line}\\n`);",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-gui-e2e-fake' }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'file_change', status: 'completed', path: 'artifacts/gui-real-dispatch-proof.txt' } }));",
    "console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: result } }));",
    "console.log(JSON.stringify({ type: 'turn.completed' }));",
  ].join("\n");
  writeFileSync(target, `${source}\n`, { mode: 0o755 });
  chmodSync(target, 0o755);
}

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
