import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guiRoot = resolve(repoRoot, "packages/gui");

// The smoke test pins the renderer to zh-CN below, so it must expect zh-CN copy.
// Read it from the catalog rather than hardcoding it: the copy is not the contract,
// the key is. Copy edits must not break this test; a deleted key must.
// The catalog is sharded by namespace (components / graph / model / renderer / views),
// mirroring how i18n/core.ts merges them into one flat key→message map.
const localeDir = resolve(guiRoot, "src/renderer/i18n/locales/zh-CN");
const readLocale = (name) => JSON.parse(readFileSync(resolve(localeDir, name), "utf8"));
const smokeLocale = {
  ...readLocale("components.json"),
  ...readLocale("graph.json"),
  ...readLocale("model.json"),
  ...readLocale("renderer.json"),
  ...readLocale("views.json"),
};

function localeLiteral(key) {
  const template = smokeLocale[key];
  assert.ok(typeof template === "string", `smoke test expects locale key ${key} to exist`);
  // Keep only the leading placeholder-free run so interpolated counts do not couple
  // the assertion to whatever the fixture ledger happens to contain.
  const literal = template.split("{")[0].trim();
  assert.ok(literal.length > 0, `locale key ${key} starts with a placeholder, cannot anchor on it`);
  return literal;
}

// Some assertions need the full interpolated string (e.g. when a {placeholder}
// value is known and stable from the fixture). Use sparingly — prefer localeLiteral
// so copy tweaks don't break the test.
function localeText(key, params = {}) {
  const template = smokeLocale[key];
  assert.ok(typeof template === "string", `smoke test expects locale key ${key} to exist`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

// Build a case-insensitive regex that matches the locale literal for a key,
// tolerating arbitrary whitespace between the leading words. Used for button /
// heading selectors where the accessible name is locale copy, not an English id.
function localeRe(key, flags = "u") {
  return new RegExp(escapeRegex(localeLiteral(key)), flags);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

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
  // Keep the smoke test deterministic across developer and CI host locales.
  // The assertions below intentionally exercise the zh-CN catalog.
  await page.evaluate(() => globalThis.localStorage.setItem("harness-locale", "zh-CN"));
  await page.reload({ waitUntil: "domcontentloaded" });

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
  const activeWorkSummary = localeLiteral("components.appSidebar.activeWorkSummary");
  const emptyState = localeLiteral("components.appSidebar.noTaskRowsFromLocalBridge");
  assert.ok(
    (taskSurfaceText ?? "").includes(activeWorkSummary) || (taskSurfaceText ?? "").includes(emptyState),
    "renderer did not show real task projection data or the real task empty state"
  );

  // The shipped relation graph consumes the same daemon/service bridge as the
  // task projection. The hermetic authored ledger exercises the focused ego
  // graph, claim coverage, semantic-axis filters, fact expansion, and the
  // genealogy multi-view without a renderer-side mock.
  // Scope to the workspace nav (sidebar) — the permanent multi-view switcher
  // also exposes a graph button (dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability).
  await page.getByRole("complementary").getByRole("button", {
    name: localeRe("renderer.shellConfig.graph"),
  }).click();
  await page.locator(".react-flow").waitFor({ timeout: 10_000 });

  // The shipped canvas renders every entity as an `ego` node — the focused one
  // and its neighbours alike. The three-lane layout that once emitted a distinct
  // `decisionFocus` node is a legacy fallback (`graphLayout.ts`: "canvas 缺省时"),
  // unreachable while GraphView supplies a canvas, and `decisionFocus` is not even
  // registered in GraphView's nodeTypes. Asserting on it waited forever on a node
  // the shipped app cannot produce.
  const egoNodes = page.locator(".react-flow__node-ego");
  await egoNodes.first().waitFor({ timeout: 10_000 });

  // Focus decision plus its neighbourhood: the derived task, the fact that
  // evidences it, and the ancestor decision it refines. All from the hermetic
  // authored ledger — no renderer-side mock.
  assert.equal(await egoNodes.count(), 4, "focus decision + task + fact + ancestor decision");
  await page.locator(".react-flow__node-ego", { hasText: "Expose the triadic projection to the GUI" }).waitFor();
  await page.locator(".react-flow__node-ego", { hasText: "Render the real triadic projection" }).waitFor();
  await page.locator(".react-flow__node-ego", { hasText: "The GUI renderer received real triadic rows" }).waitFor();
  await page.locator(".react-flow__node-ego", { hasText: "Earlier GUI projection decision" }).waitFor();
  assert.ok(await page.locator(".react-flow__edge").count() >= 1, "the ego graph draws its relations");
  assert.equal(await page.getByText("MOCK", { exact: true }).count(), 0, "triadic views must not be mock-backed");

  // GUI usability (dec_01KXA7811SVVT8P66HNDFZQ7DF): the renderer ships an
  // entity workspace with a facet tab switcher (graph/genealogy, only shown
  // when a decision is focused), a left FocusSwitcher sidebar (search +
  // entity list), a focus history bar with back/forward, and the ReactFlow
  // colorMode hookup so the MiniMap inherits dark theme instead of painting
  // a white SVG box. The legacy permanent multi-view switcher was retired
  // (G3 §③2): genealogy is now a facet of the entity workspace, not a
  // separate top-level view.
  const focusSwitcher = page.getByTestId("focus-switcher");
  await focusSwitcher.waitFor();
  await focusSwitcher.getByRole("searchbox").waitFor();
  await focusSwitcher.getByText("Expose the triadic projection to the GUI", { exact: false }).waitFor();
  await focusSwitcher.getByText("Render the real triadic projection", { exact: false }).waitFor();
  const focusHistoryBar = page.getByTestId("focus-history-bar");
  await focusHistoryBar.waitFor();
  // Default-picked focus is on the graph but not yet in history; back/forward disabled.
  assert.equal(
    await focusHistoryBar.getByRole("button", {
      name: localeRe("components.focusHistoryBar.previousFocus"),
    }).isDisabled(),
    true,
  );
  assert.equal(
    await focusHistoryBar.getByRole("button", {
      name: localeRe("components.focusHistoryBar.nextFocus"),
    }).isDisabled(),
    true,
  );
  // The MiniMap must render once colorMode flows in (regression: previously the
  // missing colorMode prop left it painting a stark white box on dark theme).
  await page.locator(".react-flow__minimap").waitFor({ timeout: 10_000 });
  // Breadcrumb shows the focused decision (the layout-picked default).
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  // Evidence: default-focus graph with MiniMap and breadcrumb visible.
  await captureGraphEvidence(page, "01-graph-default-focus-minimap");

  // === Filter panel: semantic axis toggles ===
  // GraphFilterPanel overlays the canvas top-left as a collapsed pill by default
  // (constant screen real estate). Expand it to reach the axis toggles.
  const graphCanvas = page.locator(".react-flow");
  const filterToggle = graphCanvas.getByRole("button", { name: localeRe("components.graphFilterPanel.filters") });
  await filterToggle.click();

  // The assoc (relates/implements) axis defaults off — it is the noisiest axis.
  // AXIS_LABEL["assoc"] reads from the locale catalog; AXIS_SUBLABEL is a
  // constant identifying relation kinds (not copy, so it is a valid anchor).
  const assocLabel = localeLiteral("graph.constants.association");
  const assocToggle = page.getByRole("button", {
    name: new RegExp(`${escapeRegex(assocLabel)}.*relates.*implements`, "u"),
  });
  assert.match(await assocToggle.getAttribute("class") ?? "", /opacity-60/u, "assoc must default off");

  // The ego canvas uses a fixed `shown` set per focus (bfsShown in openFocus).
  // Toggling an axis alone does not discover new nodes — re-focus does. So
  // enable assoc, re-focus via the switcher (openFocus re-runs BFS with the
  // now-on assoc axis), and the assoc neighbour must appear with its edge.
  await assocToggle.click();
  await focusSwitcher.getByRole("button").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  const assocTaskNode = page.locator(".react-flow__node-ego", { hasText: "Render optional association context" });
  await assocTaskNode.waitFor({ timeout: 10_000 });
  const edgesWithAssoc = await page.locator(".react-flow__edge").count();
  assert.ok(edgesWithAssoc >= 5, `enabling assoc should add at least one edge (got ${edgesWithAssoc})`);

  // Disabling assoc + re-focus hides the neighbour and its edge again.
  await assocToggle.click();
  await focusSwitcher.getByRole("button").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  await assocTaskNode.waitFor({ state: "detached" });
  assert.ok(
    (await page.locator(".react-flow__edge").count()) < edgesWithAssoc,
    "disabling assoc must hide its edge again",
  );
  // Collapse the filter panel so it does not crowd subsequent interactions.
  await filterToggle.click();
  await captureGraphEvidence(page, "02-assoc-axis-toggle");

  // === Focus decision card content ===
  // The ego canvas expands the focused node into a detail card. The hermetic
  // decision carries chosen options, rejected alternatives, and load-bearing
  // claims — all rendered from real ledger data (no mock).
  const focusDecisionCard = graphCanvas.locator(".react-flow__node-ego", {
    hasText: "Expose the triadic projection to the GUI",
  });
  await focusDecisionCard.getByText("Use the existing daemon/service bridge", { exact: false }).first().waitFor();
  await focusDecisionCard.getByText("Keep loose associations optional", { exact: false }).first().waitFor();
  await focusDecisionCard.getByText("Keep the global hairball", { exact: false }).first().waitFor();
  // The evidence fact neighbour is an ego node on the canvas (not a badge that
  // needs expanding). Its KD letter "F" prefixes the chip text.
  await page.locator(".react-flow__node-ego", { hasText: "The GUI renderer received real triadic rows" }).waitFor();

  // === Task node expand (in-place card, not a drawer) ===
  // dec_01KXA7811SVVT8P66HNDFZQ7DF GUI usability: single click on an ego chip
  // expands it in-place into a detail card (without changing focus). The card
  // renders entity-specific badges. The "set as center" button is the explicit
  // keyboardless way to re-focus to this node.
  const taskChip = graphCanvas.locator(".react-flow__node-ego", { hasText: "Render the real triadic projection" });
  await taskChip.click();
  // Expanded card shows task-specific badges. Smoke fixture:
  // status=active → closeoutReadiness=not_required → engine=local.
  const activeLabel = localeLiteral("components.badges.active");
  const noCloseoutLabel = localeLiteral("components.badges.noNeedCloseUp");
  await taskChip.getByText(activeLabel, { exact: true }).waitFor({ timeout: 10_000 });
  await taskChip.getByText(noCloseoutLabel, { exact: true }).waitFor();
  await taskChip.getByText("local", { exact: true }).waitFor();
  // Single click did NOT change focus: breadcrumb still shows the decision.
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  // The expanded card exposes a "set as center" button (locale-driven).
  await taskChip.getByRole("button", { name: localeRe("graph.egoNode.setAsCenter") }).waitFor();
  await captureGraphEvidence(page, "03-task-expand-inplace");
  // Collapse the task card (keep expanded neighbours, per useEgoCanvas invariant).
  await taskChip.locator(`button[title="${localeLiteral("graph.egoNode.collapseKeepExpandedNeighbors")}"]`).click();

  // === Focus switcher: type-to-search ===
  const switcherInput = focusSwitcher.getByRole("searchbox");
  await switcherInput.fill("ancestor");
  await focusSwitcher.getByText("Earlier GUI projection decision", { exact: false }).waitFor();
  await focusSwitcher.getByText("Expose the triadic projection to the GUI", { exact: false })
    .waitFor({ state: "detached" });
  await captureGraphEvidence(page, "04-focus-switcher-search");
  await switcherInput.clear();

  // Pick the ancestor decision through the switcher (verifies openFocus).
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
  // History now has [ancestor] — back stays disabled. Set a second focus to
  // exercise back/forward.
  await focusSwitcher.getByRole("button").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  const prevFocusLabel = localeLiteral("components.focusHistoryBar.previousFocus");
  const nextFocusLabel = localeLiteral("components.focusHistoryBar.nextFocus");
  assert.equal(await focusHistoryBar.getByRole("button", { name: prevFocusLabel }).isDisabled(), false);
  await captureGraphEvidence(page, "05-focus-history-back-forward-enabled");
  // Back returns to the ancestor; forward restores the smoke decision.
  await focusHistoryBar.getByRole("button", { name: prevFocusLabel }).click();
  await focusHistoryBar.getByText("decision/dec_gui_ancestor", { exact: true }).waitFor();
  await captureGraphEvidence(page, "06-focus-history-back-to-ancestor");
  assert.equal(await focusHistoryBar.getByRole("button", { name: nextFocusLabel }).isDisabled(), false);
  await focusHistoryBar.getByRole("button", { name: nextFocusLabel }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();

  // Click-then-set-as-center is the explicit keyboardless way to focus a
  // non-decision node. Expand the task chip and click its "set as center".
  await taskChip.click();
  await taskChip.getByRole("button", { name: localeRe("graph.egoNode.setAsCenter") }).click();
  await focusHistoryBar.getByText("task-gui-smoke", { exact: true })
    .waitFor()
    .catch(async () => {
      const bodyText = await page.locator("body").innerText().catch(() => "<empty>");
      throw new Error(
        `breadcrumb did not show task after set-as-center button.\n`
        + `consoleFailures:\n${consoleFailures.join("\n")}\n`
        + `bodyText (first 2000 chars):\n${bodyText.slice(0, 2000)}`,
      );
    });
  await captureGraphEvidence(page, "07-set-as-center-task");

  // Re-focus the decision so the lineage facet is available (only decisions
  // have genealogy).
  await focusSwitcher.getByRole("button").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();

  // G3 §③: Genealogy is now a facet (tab) of the EntityWorkspace for decisions,
  // not a permanent top bar. Switching to the lineage facet renders the
  // genealogy timeline; switching back to relations restores the ego canvas.
  const facetTabs = page.getByTestId("entity-facet-tabs");
  await facetTabs.getByRole("button", { name: localeRe("components.entityWorkspace.facetLineage") }).click();
  // The fixture has 2 participating decisions and 1 evolution edge (refines).
  await page.getByText(localeText("views.genealogyTimelineView.headerStats", { participants: 2, edges: 1 })).waitFor();
  await page.locator("button.absolute").filter({ hasText: "Earlier GUI projection decision" }).waitFor();
  await page.locator("button.absolute").filter({ hasText: "Expose the triadic projection to the GUI" }).waitFor();
  await facetTabs.getByRole("button", { name: localeRe("components.entityWorkspace.facetRelations") }).click();
  await graphCanvas.waitFor({ timeout: 10_000 });
  // Focus decision is back as an ego node.
  await page.locator(".react-flow__node-ego", { hasText: "Expose the triadic projection to the GUI" }).waitFor();

  // === Fact triage view ===
  // Navigate via the sidebar (locale-driven nav label).
  await page.getByRole("complementary").getByRole("button", { name: localeRe("renderer.shellConfig.factTriage") }).click();
  const triageCard = page.locator('[data-fact-ref="fact/task-gui-smoke/F-ABCDEFGH"]');
  await triageCard.waitFor({ timeout: 10_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nCurrent renderer text:\n${await page.locator("body").innerText()}`);
  });
  // The covered low-confidence fact is a candidate (not an orphan).
  await triageCard.getByText(localeLiteral("model.factTriage.lowConfidence"), { exact: true }).waitFor();
  assert.equal(await triageCard.getByText(localeLiteral("model.factTriage.orphanFact"), { exact: true }).count(), 0);
  // Copy context produces an agent-ready package with identifiers + relations.
  await triageCard.getByRole("button", { name: localeRe("components.copyContextButton.copyContext") }).click();
  const triageClipboard = await page.evaluate(() => globalThis.__harnessCopiedText);
  assert.match(triageClipboard, /task-gui-smoke\/F-ABCDEFGH/u);
  assert.match(triageClipboard, /dec_gui_smoke/u);
  assert.match(triageClipboard, /evidenced-by/u);
  assert.match(triageClipboard, /当前问题/u);

  // FactInspector has its own copy affordance and its supporting-decision link
  // lands on the exact decision card rather than merely changing tabs.
  await triageCard.locator(`button[title="${localeLiteral("views.factTriageView.clickOpenFactInspector")}"]`).click();
  await page.getByText(localeLiteral("components.factInspector.title"), { exact: true }).waitFor();
  await page.getByRole("button", { name: localeRe("components.copyContextButton.copyContext") }).last().click();
  const inspectorClipboard = await page.evaluate(() => globalThis.__harnessCopiedText);
  assert.match(inspectorClipboard, /正在检查此 fact/u);
  // Supporting-decision link navigates to the decision pool with the decision focused.
  await page.getByRole("button", { name: "dec_gui_smoke", exact: true }).click();
  await page.getByRole("heading", { name: localeRe("renderer.shellConfig.decisionPool"), exact: true }).waitFor();
  const poolFilters = page.locator("select");
  // Narrow by risk + urgency (both high) — uniquely identifies the smoke
  // decision. The originator filter is omitted: the daemon's attribution
  // projection does not populate originator.executor from provenance.runtime
  // for the hermetic fixture, so filtering by "agent" would zero the list.
  await poolFilters.nth(1).selectOption("high");
  await poolFilters.nth(2).selectOption("high");
  const focusedDecision = page.locator('#decision-card-dec_gui_smoke[data-focused="true"]');
  await focusedDecision.waitFor({ timeout: 10_000 }).catch(async (error) => {
    throw new Error(`${error.message}\nCurrent renderer text:\n${await page.locator("body").innerText()}`);
  });

  // Entity surfaces can focus the same decision in GraphView.
  await focusedDecision.locator(
    `button[title="${localeLiteral("views.decisionPoolView.focusDecisionDiagram")}"]`,
  ).click();
  await graphCanvas.waitFor({ timeout: 10_000 });
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();

  // The decision inbox card exposes the same paste-ready context shape.
  await page.getByRole("complementary").getByRole("button", { name: localeRe("renderer.shellConfig.decisionApproval") }).click();
  await page.getByText("Should the GUI consume the public relation graph?", { exact: false }).waitFor();
  await page.getByRole("button", { name: localeRe("components.copyContextButton.copyContext") }).click();
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
    "proposedAt: \"2026-07-10T00:00:00.000Z\"",
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
    "proposedAt: \"2026-07-01T00:00:00.000Z\"",
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
