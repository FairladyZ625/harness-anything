// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  createDefaultWorkspaceLayout,
  detachPaneView,
  resetWorkspaceLayout,
  restoreWorkspaceLayout,
  routeOpenIntent,
  serializeWorkspaceLayout
} from "../src/index.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// Pane titles are i18n-backed; pin en-US so this contract is locale-stable under zh developer hosts.
setActiveLocale("en-US");

test("default workspace layout covers task doc terminal and logs across tab split and dock placements", () => {
  const layout = createDefaultWorkspaceLayout("operate");

  assert.deepEqual(layout.panes.map((pane) => pane.kind), ["task", "doc", "terminal", "logs"]);
  assert.deepEqual(new Set(layout.panes.map((pane) => pane.placement)), new Set(["tab", "split", "dock"]));
  assert.equal(layout.activePaneId, "task-task-001");
});

test("triage and review defaults reflect their architecture perspectives", () => {
  const triage = createDefaultWorkspaceLayout("triage");
  assert.deepEqual(triage.panes.map((pane) => pane.kind), ["board", "list", "taskContext", "task", "terminal", "logs"]);
  assert.equal(triage.panes.find((pane) => pane.kind === "taskContext")?.state?.role, "filters");
  assert.equal(triage.panes.find((pane) => pane.kind === "terminal")?.placement, "dock");

  const review = createDefaultWorkspaceLayout("review");
  assert.deepEqual(review.panes.map((pane) => pane.kind), ["review", "doc", "task", "logs", "checker", "terminal"]);
  assert.equal(review.panes.find((pane) => pane.kind === "review")?.state?.role, "queue");
  assert.equal(review.panes.find((pane) => pane.kind === "checker")?.state?.role, "checklist");
});

test("open target router creates deterministic pane descriptors", () => {
  assert.deepEqual(
    routeOpenIntent({
      source: "palette",
      target: { kind: "terminal", projectId: "project-a", taskId: "TASK-9", sessionId: "term-9", cwd: "/workspace" }
    }),
    {
      id: "terminal-term-9",
      kind: "terminal",
      title: "Terminal term-9",
      placement: "dock",
      viewState: "visible",
      projectId: "project-a",
      taskId: "TASK-9",
      terminalSessionId: "term-9",
      source: {
        source: "palette",
        target: { kind: "terminal", projectId: "project-a", taskId: "TASK-9", sessionId: "term-9", cwd: "/workspace" }
      },
      state: { cwd: "/workspace" }
    }
  );

  assert.deepEqual(
    routeOpenIntent({
      source: "doc",
      target: { kind: "url", url: "https://example.invalid/demo" }
    }),
    {
      id: "browser-placeholder-https-example-invalid-demo",
      kind: "browser",
      title: "External URL",
      placement: "external",
      viewState: "visible",
      source: {
        source: "doc",
        target: { kind: "url", url: "https://example.invalid/demo" }
      },
      state: { url: "https://example.invalid/demo", trustPolicy: "not-opened-by-p06" }
    }
  );
});

test("layout persistence restores valid layouts and fails closed on malformed or unsupported panes", () => {
  const fallback = createDefaultWorkspaceLayout("review");
  const valid = createDefaultWorkspaceLayout("triage");

  assert.deepEqual(restoreWorkspaceLayout(serializeWorkspaceLayout(valid), fallback), {
    ok: true,
    layout: valid
  });
  assert.deepEqual(restoreWorkspaceLayout("{", fallback), {
    ok: false,
    error: "invalid_json",
    layout: fallback
  });
  assert.deepEqual(
    restoreWorkspaceLayout(
      JSON.stringify({
        schema: "workspace-layout/v1",
        perspective: "operate",
        activePaneId: "pane-1",
        panes: [{ id: "pane-1", kind: "unknown", title: "Bad", placement: "tab", viewState: "visible" }]
      }),
      fallback
    ),
    {
      ok: false,
      error: "invalid_layout",
      layout: fallback
    }
  );
  assert.deepEqual(
    restoreWorkspaceLayout(
      JSON.stringify({
        schema: "workspace-layout/v1",
        perspective: "operate",
        activePaneId: "pane-1",
        panes: [
          {
            id: "pane-1",
            kind: "browser",
            title: "Embedded browser bypass",
            placement: "tab",
            viewState: "visible",
            state: { url: "https://example.invalid/bypass" }
          }
        ]
      }),
      fallback
    ),
    {
      ok: false,
      error: "invalid_layout",
      layout: fallback
    }
  );
});

test("reset default restores perspective layout without mutating terminal session lifecycle", () => {
  const layout = createDefaultWorkspaceLayout("operate");
  const terminalPane = layout.panes.find((pane) => pane.kind === "terminal");
  assert.ok(terminalPane);

  const detached = detachPaneView(layout, terminalPane.id);
  const detachedTerminal = detached.panes.find((pane) => pane.id === terminalPane.id);
  assert.equal(detachedTerminal?.viewState, "detached");
  assert.equal(detachedTerminal?.terminalSessionId, "term-local-task");
  assert.equal("status" in (detachedTerminal?.state ?? {}), false);

  assert.deepEqual(resetWorkspaceLayout("operate"), createDefaultWorkspaceLayout("operate"));
});
