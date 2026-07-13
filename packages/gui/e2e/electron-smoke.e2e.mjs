import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import electronPath from "electron";
import { _electron as electron } from "playwright-core";
import {
  repoRoot,
  guiRoot,
  localeLiteral,
  localeText,
  localeRe,
  escapeRegex,
  captureGraphEvidence,
  writeTriadicLedger,
  closeElectronApp,
  sleep,
} from "./harness-fixture.mjs";

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
  // FocusSwitcher retired (gui-b): the left rail is now a ⌘K trigger +
  // Recent list (empty until the user picks an entity). Search moved into
  // the Cmd+K command palette, which indexes all three primitives.
  const focusSwitcher = page.getByTestId("focus-switcher");
  await focusSwitcher.waitFor();
  await focusSwitcher.getByTestId("focus-switcher-palette-trigger").waitFor();
  // No full-list searchbox anymore — the linear 100+ row list is gone.
  assert.equal(await focusSwitcher.getByRole("searchbox").count(), 0, "FocusSwitcher must not ship a full-list searchbox after gui-b retirement");
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

  // Command palette (gui-b): replaces the FocusSwitcher full-list search.
  // Cmd+K opens a modal that indexes task / decision / fact together.
  // Typing narrows by title/id substring; clicking a hit focuses it in the graph.
  await page.keyboard.press("Meta+K");
  // Some Linux hosts route Meta to Super; fall back to Ctrl+K if the palette
  // did not open under Meta.
  if (await page.getByTestId("command-palette").count() === 0) {
    await page.keyboard.press("Control+K");
  }
  const commandPalette = page.getByTestId("command-palette");
  await commandPalette.waitFor();
  const paletteInput = commandPalette.getByTestId("command-palette-input");
  await paletteInput.waitFor();
  await paletteInput.fill("ancestor");
  await commandPalette.getByText("Earlier GUI projection decision", { exact: false }).waitFor();
  // The unrelated smoke decision must NOT appear under the "ancestor" filter.
  assert.equal(
    await commandPalette.getByTestId("command-palette-item").filter({ hasText: "Expose the triadic projection to the GUI" }).count(),
    0,
    "command palette must narrow hits by substring (smoke decision should be filtered out by 'ancestor')",
  );
  // Evidence: palette search narrows the list (replaces the legacy switcher screenshot).
  await captureGraphEvidence(page, "03-command-palette-search");
  // Pick the ancestor decision through the palette (verifies focusEntityInGraph).
  await commandPalette.getByTestId("command-palette-item").filter({ hasText: "Earlier GUI projection decision" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_ancestor", { exact: true })
    .waitFor()
    .catch(async () => {
      const bodyText = await page.locator("body").innerText().catch(() => "<empty>");
      throw new Error(
        `breadcrumb did not show dec_gui_ancestor after command palette selection.\n`
        + `consoleFailures:\n${consoleFailures.join("\n")}\n`
        + `bodyText (first 2000 chars):\n${bodyText.slice(0, 2000)}`,
      );
    });
  const prevFocusLabel = localeLiteral("components.focusHistoryBar.previousFocus");
  const nextFocusLabel = localeLiteral("components.focusHistoryBar.nextFocus");
  // Recent list in the left rail now reflects the picked ancestor (gui-b:
  // FocusSwitcher shows Recent instead of the full list).
  await focusSwitcher.getByText("Earlier GUI projection decision", { exact: false }).waitFor();
  // History now has [ancestor] — back stays disabled because there is nothing
  // earlier in the user-navigated stack. Set a second focus to exercise back.
  await page.keyboard.press("Meta+K");
  if (await page.getByTestId("command-palette").count() === 0) {
    await page.keyboard.press("Control+K");
  }
  await page.getByTestId("command-palette-input").fill("expose");
  await page.getByTestId("command-palette-item").filter({ hasText: "Expose the triadic projection to the GUI" }).click();
  await focusHistoryBar.getByText("decision/dec_gui_smoke", { exact: true }).waitFor();
  assert.equal(await focusHistoryBar.getByRole("button", { name: prevFocusLabel }).isDisabled(), false);
  // Evidence: history now has two entries with back/forward enabled.
  await captureGraphEvidence(page, "04-focus-history-back-forward-enabled");
  // Fact-in-index proof (gui-b): the legacy FocusSwitcher structurally
  // excluded facts; the command palette must surface them. The smoke fixture
  // has one fact (F-ABCDEFGH, "The GUI renderer received real triadic rows
  // through the public bridge.") — typing its substring must surface a fact
  // hit. Verifies the f: prefix as well.
  await page.keyboard.press("Meta+K");
  if (await page.getByTestId("command-palette").count() === 0) {
    await page.keyboard.press("Control+K");
  }
  const factPalette = page.getByTestId("command-palette");
  await factPalette.getByTestId("command-palette-input").fill("f:renderer received");
  await factPalette.getByText(localeLiteral("components.commandPalette.groupFact"), { exact: true }).waitFor();
  const factItem = factPalette.getByTestId("command-palette-item").filter({ hasText: "renderer received" });
  await factItem.waitFor();
  // data-hit-kind sits on the palette item itself, not on a descendant — locator() would look past it.
  assert.equal(await factItem.getAttribute("data-hit-kind"), "fact", "palette item matching fact substring must be tagged kind=fact");
  // Evidence: fact enters the unified index.
  await captureGraphEvidence(page, "04b-command-palette-fact-in-index");
  // Close the palette without selecting — Esc keyboard path.
  await page.keyboard.press("Escape");
  await page.getByTestId("command-palette").waitFor({ state: "detached" });
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

  // Decision pool title/id search (gui-b): the pool previously had seven select
  // dimensions but no text search. Typing an id prefix must locate the card.
  // Reset filters first, then type the id; only the smoke decision matches.
  await page.getByTestId("decision-pool-reset-filters").click();
  const poolSearch = page.getByTestId("decision-pool-search");
  await poolSearch.fill("dec_gui_smoke");
  assert.equal(
    await page.locator('[id^="decision-card-"]').count(),
    1,
    "decision pool search by id prefix must narrow to exactly one card",
  );
  await page.getByRole("heading", { name: "Expose the triadic projection to the GUI", exact: true }).waitFor();
  // Evidence: id-prefix search pins one decision card.
  await captureGraphEvidence(page, "08-decision-pool-id-search");
  await poolSearch.fill("");
  // Restore the focus highlight on the smoke decision for the next assertions.
  // (The reset above cleared the focused state; the select path re-establishes it.)
  await poolFilters.nth(1).selectOption("high");
  await poolFilters.nth(2).selectOption("high");
  // Do NOT touch the originator filter here: as noted above, the hermetic
  // fixture leaves originator.executor unpopulated, so selecting "agent"
  // empties the list and the focused card disappears.

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

