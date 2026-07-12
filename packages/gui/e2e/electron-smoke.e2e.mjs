import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");

// dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability evidence shots. The directory
// is a sibling of the hermetic ledger so it gets cleaned up with the test run
// but stays readable from a developer machine. Set HARNESS_GUI_E2E_SHOTS to
// a stable absolute path to retain shots across runs (used for closeout evidence).
const screenshotDir = process.env.HARNESS_GUI_E2E_SHOTS
  ? resolve(process.env.HARNESS_GUI_E2E_SHOTS)
  : mkdtempSync(path.join(tmpdir(), "ha-gui-e2e-shots-"));

async function captureGraphEvidence(page, name) {
  const file = path.join(screenshotDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch((error) => {
    console.warn(`[screenshot] ${name} failed: ${error.message}`);
  });
  return file;
}
test("Electron shell opens its first BrowserWindow", { timeout: 90_000 }, async (t) => {
  const ledgerRoot = mkdtempSync(path.join(tmpdir(), "ha-gui-e2e-"));
  writeTriadicLedger(ledgerRoot);
  let electronApp;
  t.after(async () => {
    if (electronApp) await closeElectronApp(electronApp);
    // The daemon is intentionally non-zero-idle; give the hermetic instance
    // enough time to release its socket before deleting its user root.
    await sleep(5_500);
    rmSync(ledgerRoot, { recursive: true, force: true });
  });

  electronApp = await electron.launch({
    executablePath: electronPath,
    args: [resolve(guiRoot, "src/main/electron-main.ts")],
    cwd: repoRoot,
    env: {
      ...process.env,
      HARNESS_GUI_ROOT: ledgerRoot,
      HARNESS_DAEMON_USER_ROOT: path.join(ledgerRoot, "daemon-user"),
      HARNESS_DAEMON_IDLE_MS: "5000"
    }
  });
  const page = await electronApp.firstWindow();
  page.setDefaultTimeout(15_000);
  const consoleFailures = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleFailures.push(message.text());
  });
  page.on("pageerror", (error) => consoleFailures.push(`${error.message}\n${error.stack ?? ""}`));
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
  await taskSurface.waitFor({ timeout: 20_000 });
  const taskSurfaceText = await taskSurface.textContent();
  assert.match(
    taskSurfaceText ?? "",
    /Active work|No task rows available from the local task bridge/u,
    "renderer did not show real task projection data or the real task empty state"
  );

  // The shipped relation graph consumes the same daemon/service bridge as the
  // task projection. The hermetic authored ledger exercises the focused ego
  // graph, claim coverage, semantic-axis filters, fact expansion, and the
  // genealogy multi-view without a renderer-side mock.
  // Scope to the workspace nav (sidebar) — the permanent multi-view switcher
  // also exposes a 关系图 button (dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability).
  await page.getByRole("complementary").getByRole("button", { name: "关系图" }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  const focusCard = page.locator(".react-flow__node-decisionFocus");
  await focusCard.waitFor({ timeout: 10_000 });
  await focusCard.getByText("dec_gui_smoke", { exact: true }).waitFor();
  await focusCard.locator('[title="已佐证"]').waitFor();
  assert.equal(await focusCard.locator('[title="无证据 (风险)"]').count(), 2);
  await page.locator(".react-flow__node-task").waitFor();
  await page.locator(".react-flow__node-decision").waitFor();
  assert.equal(await page.locator(".react-flow__node-task").count(), 1);
  assert.equal(await page.locator(".react-flow__node-decision").count(), 1);
  assert.equal(await page.locator(".react-flow__node-fact").count(), 0, "facts start folded into claim badges");
  assert.equal(await page.locator(".react-flow__edge").count(), 2);
  assert.equal(await page.getByText("MOCK", { exact: true }).count(), 0, "triadic views must not be mock-backed");

  // GUI usability (dec_01KXA7811SVVT8P66HNDFZQ7DF): the renderer ships a
  // permanent multi-view switcher (graph/genealogy), a left FocusSwitcher
  // sidebar (search + entity list), a focus history bar with back/forward,
  // and the ReactFlow colorMode hookup so the MiniMap inherits dark theme
  // instead of painting a white SVG box.
  await page.getByTestId("multi-view-switcher").waitFor();
  const focusSwitcher = page.getByTestId("focus-switcher");
  await focusSwitcher.waitFor();
  await focusSwitcher.getByRole("searchbox").waitFor();
  await focusSwitcher.getByText("Expose the triadic projection to the GUI", { exact: false }).waitFor();
  await focusSwitcher.getByText("Render the real triadic projection", { exact: false }).waitFor();
  const focusHistoryBar = page.getByTestId("focus-history-bar");
  await focusHistoryBar.waitFor();
  // Default-picked focus is on the graph but not yet in history; back/forward disabled.
  assert.equal(await focusHistoryBar.getByRole("button", { name: "上一个焦点" }).isDisabled(), true);
  assert.equal(await focusHistoryBar.getByRole("button", { name: "下一个焦点" }).isDisabled(), true);
  // The MiniMap must render once colorMode flows in (regression: previously the
  // missing colorMode prop left it painting a stark white box on dark theme).
  await page.locator(".react-flow__minimap").waitFor({ timeout: 10_000 });
  // Breadcrumb shows the focused decision (the layout-picked default).
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  // Evidence: default-focus graph with MiniMap and breadcrumb visible.
  await captureGraphEvidence(page, "01-graph-default-focus-minimap");

  const assocToggle = page.getByRole("button", { name: /关联.*relates.*implements/u });
  assert.match(await assocToggle.getAttribute("class") ?? "", /opacity-60/u, "assoc must default off");
  await assocToggle.click();
  await page.locator(".react-flow__node-task").nth(1).waitFor();
  assert.equal(await page.locator(".react-flow__edge").count(), 3, "enabling assoc reveals its edge");
  await assocToggle.click();
  await page.locator(".react-flow__node-task").nth(1).waitFor({ state: "detached" });
  assert.equal(await page.locator(".react-flow__edge").count(), 2, "disabling assoc hides its edge again");

  // Per-claim expand (#4): each claim row is independently clickable via its
  // data-claim-id attribute, instead of the legacy whole-card "toggle all".
  // The smoke fixture has CH1 with the only evidence fact (F-ABCDEFGH); CH2/RJ1
  // have no evidence so clicking them is a no-op.
  const ch1Row = focusCard.locator("[data-claim-id='CH1']");
  await ch1Row.waitFor();
  await ch1Row.click();
  const expandedFact = page.locator('.react-flow__node-fact[data-id="fact/task-gui-smoke/F-ABCDEFGH"]');
  await expandedFact.waitFor({ timeout: 10_000 });
  assert.equal((await expandedFact.textContent())?.trim(), "F");
  assert.equal(await page.locator(".react-flow__edge").count(), 3, "expanding a fact badge reveals its evidence edge");
  await expandedFact.click();
  await expandedFact.waitFor({ state: "detached" });

  // Regression (#1 P1): clicking a task node used to crash the drawer because
  // GraphView passed `n.data` instead of `n.data.raw` to GraphDrawer, and
  // CloseoutBadge read `CLOSEOUT_META[undefined]`. Now the drawer should open
  // and render task-specific badges (status / closeout / engine).
  // dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability: single click selects + opens
  // the drawer WITHOUT changing the focus, so the focused decision card stays
  // central. The drawer exposes an explicit "设为焦点" button.
  const taskNode = page.locator(".react-flow__node-task").first();
  await taskNode.click();
  const taskDrawer = page.locator("aside");
  await taskDrawer.getByText("task-gui-smoke", { exact: true }).waitFor();
  // Smoke fixture: status=active → closeoutReadiness=not_required → engine=local.
  await taskDrawer.getByText("Active", { exact: true }).waitFor();
  await taskDrawer.getByText("无需收口", { exact: true }).waitFor();
  await taskDrawer.getByText("local", { exact: true }).waitFor();
  // Single click did NOT change focus: the focused decision card is still
  // centered (the decisionFocus node stays rendered) and the breadcrumb still
  // shows the focused decision, not the selected task.
  await page.locator(".react-flow__node-decisionFocus").waitFor();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  await taskDrawer.getByRole("button", { name: "设为焦点" }).waitFor();
  // Evidence: single-click opened the drawer; breadcrumb still shows the focus.
  await captureGraphEvidence(page, "02-click-opens-drawer-no-focus-change");
  // Close the drawer so it does not crowd subsequent interactions; the focus
  // must remain on dec_gui_smoke after Esc.
  await taskDrawer.getByRole("button", { name: /退出抽屉|退出聚焦/u }).click();

  // Focus switcher: type-to-search narrows the list, and clicking a hit
  // changes focus (driving both layout and history).
  const switcherInput = focusSwitcher.getByRole("searchbox");
  await switcherInput.fill("ancestor");
  await focusSwitcher.getByText("Earlier GUI projection decision", { exact: false }).waitFor();
  await focusSwitcher.getByText("Expose the triadic projection to the GUI", { exact: false }).waitFor({ state: "detached" });
  // Evidence: switcher search narrows the list.
  await captureGraphEvidence(page, "03-focus-switcher-search");
  await switcherInput.clear();
  // Pick the ancestor decision through the switcher (verifies setFocusId).
  await focusSwitcher.getByRole("button").filter({ hasText: "Earlier GUI projection decision" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_ancestor", { exact: true })
    .waitFor()
    .catch(async () => {
      const bodyText = await page.locator("body").innerText().catch(() => "<empty>");
      throw new Error(
        `breadcrumb did not show dec_gui_ancestor after switcher click.\n`
        + `consoleFailures:\n${consoleFailures.join("\n")}\n`
        + `bodyText (first 2000 chars):\n${bodyText.slice(0, 2000)}`,
      );
    });
  // History now has [ancestor] — back stays disabled because there is nothing
  // earlier in the user-navigated stack. Set a second focus to exercise back.
  await focusSwitcher.getByRole("button").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  assert.equal(await focusHistoryBar.getByRole("button", { name: "上一个焦点" }).isDisabled(), false);
  // Evidence: history now has two entries with back/forward enabled.
  await captureGraphEvidence(page, "04-focus-history-back-forward-enabled");
  // Back returns to the ancestor; forward restores the smoke decision.
  await focusHistoryBar.getByRole("button", { name: "上一个焦点" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_ancestor", { exact: true }).waitFor();
  // Evidence: after back, breadcrumb shows the ancestor.
  await captureGraphEvidence(page, "05-focus-history-back-to-ancestor");
  assert.equal(await focusHistoryBar.getByRole("button", { name: "下一个焦点" }).isDisabled(), false);
  await focusHistoryBar.getByRole("button", { name: "下一个焦点" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();

  // Click-then-set-as-focus is the explicit keyboardless way to change focus
  // to a non-decision node. The drawer exposes a "设为焦点" button exactly for
  // this — equivalent to onNodeDoubleClick but discoverable.
  await page.locator(".react-flow__node-task").first().click();
  await page.locator("aside").getByRole("button", { name: "设为焦点" }).click();
  await focusHistoryBar.getByText("task-gui-smoke", { exact: true })
    .waitFor()
    .catch(async () => {
      const bodyText = await page.locator("body").innerText().catch(() => "<empty>");
      throw new Error(
        `breadcrumb did not show task after set-as-focus button.\n`
        + `consoleFailures:\n${consoleFailures.join("\n")}\n`
        + `bodyText (first 2000 chars):\n${bodyText.slice(0, 2000)}`,
      );
    });
  // Evidence: focus switched to a task node via the explicit button.
  await captureGraphEvidence(page, "06-set-as-focus-task");

  const viewSwitcher = page.getByTestId("multi-view-switcher");
  await viewSwitcher.getByRole("button", { name: "演化史", exact: true }).click();
  await page.getByRole("heading", { name: "决策演化史", exact: true }).waitFor();
  await page.getByText(/2 决策参与谱系 · 1 条演化边/u).waitFor();
  await page.locator("button.absolute").filter({ hasText: "Earlier GUI projection decision" }).waitFor();
  await page.locator("button.absolute").filter({ hasText: "Expose the triadic projection to the GUI" }).waitFor();
  await viewSwitcher.getByRole("button", { name: "关系图", exact: true }).click();
  await page.locator(".react-flow__node-decisionFocus").waitFor();

  // Fact triage consumes confidence + coverageRows/factAnchors. The covered
  // low-confidence fact is a candidate (not an orphan) and its context package
  // contains enough identifiers and relation detail to hand to an agent.
  await page.getByRole("button", { name: /事实分诊/u }).click();
  const triageCard = page.locator('[data-fact-ref="fact/task-gui-smoke/F-ABCDEFGH"]');
  await triageCard.waitFor({ timeout: 10_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nCurrent renderer text:\n${await page.locator("body").innerText()}`);
  });
  await triageCard.getByText("低 confidence", { exact: true }).waitFor();
  assert.equal(await triageCard.getByText("孤儿 fact", { exact: true }).count(), 0);
  await triageCard.getByRole("button", { name: /复制上下文/u }).click();
  const triageClipboard = await page.evaluate(() => globalThis.__harnessCopiedText);
  assert.match(triageClipboard, /task-gui-smoke\/F-ABCDEFGH/u);
  assert.match(triageClipboard, /dec_gui_smoke/u);
  assert.match(triageClipboard, /evidenced-by/u);
  assert.match(triageClipboard, /当前问题/u);

  // FactInspector has its own copy affordance and its supporting-decision link
  // lands on the exact decision card rather than merely changing tabs.
  await triageCard.locator('button[title="点击打开 Fact Inspector"]').click();
  await page.getByText("Fact Inspector", { exact: true }).waitFor();
  await page.getByRole("button", { name: /复制上下文/u }).last().click();
  const inspectorClipboard = await page.evaluate(() => globalThis.__harnessCopiedText);
  assert.match(inspectorClipboard, /正在检查此 fact/u);
  await page.getByRole("button", { name: "dec_gui_smoke", exact: true }).click();
  await page.getByRole("heading", { name: "决策池", exact: true }).waitFor();
  const poolFilters = page.locator("select");
  await poolFilters.nth(1).selectOption("high");
  await poolFilters.nth(2).selectOption("high");
  await poolFilters.nth(5).selectOption("agent");
  const focusedDecision = page.locator('#decision-card-dec_gui_smoke[data-focused="true"]');
  await focusedDecision.waitFor({ timeout: 10_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nCurrent renderer text:\n${await page.locator("body").innerText()}`);
  });

  // Entity surfaces can focus the same decision in GraphView.
  await focusedDecision.locator('button[title="在关系图中聚焦此 decision"]').click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });
  await page.locator("aside").getByText("decision/dec_gui_smoke", { exact: true }).waitFor();

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

function writeTriadicLedger(rootDir) {
  const taskDir = path.join(rootDir, "harness/tasks/task-gui-smoke");
  const assocTaskDir = path.join(rootDir, "harness/tasks/task-gui-assoc");
  const decisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_smoke");
  const ancestorDecisionDir = path.join(rootDir, "harness/decisions/decision-dec_gui_ancestor");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(assocTaskDir, { recursive: true });
  mkdirSync(decisionDir, { recursive: true });
  mkdirSync(ancestorDecisionDir, { recursive: true });
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
    "- {fact_id: F-ABCDEFGH, statement: \"The GUI renderer received real triadic rows through the public bridge.\", source: \"GUI E2E\", observedAt: \"2026-07-10T00:30:00.000Z\", confidence: low, memoryClass: semantic, memoryTags: [pattern], provenance: [{runtime: \"codex\", sessionId: \"fg-p1-07-e2e\", boundAt: \"2026-07-10T00:30:00.000Z\"}]}",
    ""
  ].join("\n"));
  writeFileSync(path.join(assocTaskDir, "INDEX.md"), [
    "---",
    "schema: task-package/v2",
    "task_id: task-gui-assoc",
    "title: Render optional association context",
    "lifecycle:",
    "  bindingSchema: lifecycle-binding/v1",
    "  engine: local",
    "  status: active",
    "  ref:",
    "  titleSnapshot: Render optional association context",
    "  url:",
    "  bindingCreatedAt: 2026-07-10T00:10:00.000Z",
    "  bindingFingerprint: sha256:gui-assoc",
    "packageDisposition: active",
    "vertical: software/coding",
    "preset: implementation",
    "---",
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
    "  - {id: \"CH2\", text: \"Keep loose associations optional\"}",
    "rejected:",
    "  - {id: \"RJ1\", text: \"Keep the global hairball\", why_not: \"Focused graph is more legible\"}",
    "claims:",
    "  - {id: \"CH1\", text: \"The public path preserves kernel relation names\", load_bearing: true}",
    "  - {id: \"CH2\", text: \"Loose associations stay optional\", load_bearing: true}",
    "  - {id: \"RJ1\", text: \"The global hairball should remain rejected\", load_bearing: true}",
    "relations:",
    "  - {relation_id: rel_5287143733cccbd9, source: decision/dec_gui_smoke, target: task/task-gui-smoke, type: derives, strength: strong, direction: directed, origin: declared, rationale: \"Decision derived the GUI task\", state: active}",
    "  - {relation_id: rel_f0e4909f80e86478, source: decision/dec_gui_smoke/CH1, target: fact/task-gui-smoke/F-ABCDEFGH, type: evidenced-by, strength: strong, direction: directed, origin: declared, rationale: \"Fact evidences the public projection\", state: active}",
    "  - {relation_id: rel_58f5525aa9196c13, source: decision/dec_gui_smoke/CH2, target: task/task-gui-assoc, type: relates, strength: weak, direction: directed, origin: declared, rationale: \"Optional association exercises the default-off axis\", state: active}",
    "  - {relation_id: rel_6f844b22a6cc8a74, source: decision/dec_gui_smoke/CH2, target: decision/dec_gui_ancestor, type: refines, strength: strong, direction: directed, origin: declared, rationale: \"The focused graph refines the earlier projection\", state: active}",
    "---",
    ""
  ].join("\n"));
  writeFileSync(path.join(ancestorDecisionDir, "decision.md"), [
    "---",
    "schema: decision-package/v1",
    "decision_id: dec_gui_ancestor",
    "_coordinatorWatermark: gui-ancestor-watermark",
    "title: \"Earlier GUI projection decision\"",
    "state: active",
    "riskTier: medium",
    "urgency: medium",
    "vertical: \"software/coding\"",
    "preset: \"architecture-decision\"",
    "applies_to:",
    "  modules: [\"gui\"]",
    "  productLines: []",
    "proposedBy: {kind: \"agent\", id: \"codex\"}",
    "proposedAt: \"2026-07-01T00:00:00.000Z\"",
    "arbiter: {kind: \"human\", id: \"ZeyuLi\"}",
    "decidedAt: \"2026-07-02T00:00:00.000Z\"",
    "provenance:",
    "  - {runtime: \"codex\", sessionId: \"fg-p1-07-ancestor\", boundAt: \"2026-07-01T00:00:00.000Z\"}",
    "question: \"How should the first GUI relation projection render?\"",
    "chosen:",
    "  - {id: \"CH1\", text: \"Render a single global projection\"}",
    "rejected: []",
    "claims:",
    "  - {id: \"CH1\", text: \"The first projection is globally visible\", load_bearing: true}",
    "relations: []",
    "---",
    ""
  ].join("\n"));
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
