// harness-test-tier: fast
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { TerminalSessionManager } from "../src/renderer/components/terminal/TerminalSessionManager.tsx";
import { TerminalDock } from "../src/renderer/components/terminal/TerminalDock.tsx";
import { TerminalPane } from "../src/renderer/components/terminal/TerminalPane.tsx";
import {
  clampDockHeight,
  clampDockWidth,
  DOCK_DEFAULT_HEIGHT,
  DOCK_DEFAULT_WIDTH,
  DOCK_MIN_HEIGHT,
  DOCK_MIN_WIDTH,
  DOCK_RESERVE_HEIGHT,
  DOCK_RESERVE_WIDTH,
} from "../src/renderer/components/terminal/dock-resize.ts";
import { AppSidebar } from "../src/renderer/components/AppSidebar.tsx";
import type { Project, TaskRow } from "../src/renderer/model/types.ts";
import type { ViewId } from "../src/renderer/shell-config.tsx";

// Defect-level DOM smoke: assert the three terminal-dock usability fixes hold
// at the rendered markup level (structure + presence), complementing the
// CSS/layout reasoning in the component source.

const noop = () => {};

describe("defect 1 — terminate confirm bar is not clipped", () => {
  it("renders the manager panel as a flex column so the confirm bar stays visible", () => {
    const html = renderToString(
      createElement(TerminalSessionManager, {
        open: true,
        projectId: "p",
        onClose: noop,
        onAttach: noop,
        onSpawn: noop,
      }),
    );
    // Outer panel must be flex-col (was a plain block with overflow-hidden that
    // clipped the confirm sibling). The list must flex+min-h-0 so it shrinks to
    // leave room for the confirm bar instead of pushing it below max-h-64.
    expect(html).toContain("flex max-h-64 flex-col");
    expect(html).toContain("flex min-h-0 flex-1 flex-col overflow-y-auto");
  });
});

describe("defect 2 — dock supports bottom and right positions", () => {
  it("renders bottom position with a draggable height and top border", () => {
    const html = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "bottom",
        onPositionChange: noop,
      }),
    );
    expect(html).toContain('data-dock-position="bottom"');
    expect(html).toContain("border-t");
    // Size is inline because it is drag-resizable; it must be the height axis.
    expect(html).toContain(`height:${DOCK_DEFAULT_HEIGHT}px`);
    expect(html).not.toContain("border-l");
    expect(html).not.toContain("width:");
  });

  it("renders right position with a draggable width and left border", () => {
    const html = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "right",
        onPositionChange: noop,
      }),
    );
    expect(html).toContain('data-dock-position="right"');
    expect(html).toContain("border-l");
    expect(html).toContain(`width:${DOCK_DEFAULT_WIDTH}px`);
    expect(html).not.toContain("height:");
  });

  it("shows the dock-right toggle control when at bottom", () => {
    const html = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "bottom",
        onPositionChange: noop,
      }),
    );
    expect(html).toContain("Dock to right");
  });

  it("shows the dock-bottom toggle control when at right", () => {
    const html = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "right",
        onPositionChange: noop,
      }),
    );
    expect(html).toContain("Dock to bottom");
  });

  it("collapses to the bottom thin bar when closed regardless of position", () => {
    const html = renderToString(
      createElement(TerminalDock, {
        open: false,
        projectId: "p",
        onToggle: noop,
        position: "right",
        onPositionChange: noop,
      }),
    );
    expect(html).toContain("h-9");
    expect(html).toContain("border-t");
    expect(html).not.toContain("width:");
    expect(html).not.toContain("border-l");
  });
});

describe("defect 4 — dock is drag-resizable", () => {
  const dockHtml = (position: "bottom" | "right", open = true) =>
    renderToString(
      createElement(TerminalDock, {
        open,
        projectId: "p",
        onToggle: noop,
        position,
        onPositionChange: noop,
      }),
    );

  it("exposes a row-resize handle on the top edge when docked at the bottom", () => {
    const html = dockHtml("bottom");
    expect(html).toContain('data-testid="terminal-dock-resize-handle"');
    expect(html).toContain("cursor-row-resize");
    expect(html).toContain('aria-orientation="horizontal"');
  });

  it("exposes a col-resize handle on the left edge when docked at the right", () => {
    const html = dockHtml("right");
    expect(html).toContain('data-testid="terminal-dock-resize-handle"');
    expect(html).toContain("cursor-col-resize");
    expect(html).toContain('aria-orientation="vertical"');
  });

  it("is keyboard reachable so resizing does not require a pointer", () => {
    expect(dockHtml("bottom")).toContain('role="separator"');
    expect(dockHtml("bottom")).toContain('tabindex="0"');
  });

  it("hides the handle when the dock is collapsed", () => {
    expect(dockHtml("bottom", false)).not.toContain('data-testid="terminal-dock-resize-handle"');
  });

  it("clamps height between the floor and a ceiling that reserves the main view", () => {
    expect(clampDockHeight(10, 1000)).toBe(DOCK_MIN_HEIGHT);
    expect(clampDockHeight(400, 1000)).toBe(400);
    // Ceiling = viewport - reserve, so the primary view can never be swallowed.
    expect(clampDockHeight(99_999, 1000)).toBe(1000 - DOCK_RESERVE_HEIGHT);
    // A viewport smaller than the reserve still yields a usable floor.
    expect(clampDockHeight(500, 100)).toBe(DOCK_MIN_HEIGHT);
  });

  it("clamps width between the floor and a ceiling that reserves the sidebar", () => {
    expect(clampDockWidth(10, 2000)).toBe(DOCK_MIN_WIDTH);
    expect(clampDockWidth(600, 2000)).toBe(600);
    expect(clampDockWidth(99_999, 2000)).toBe(2000 - DOCK_RESERVE_WIDTH);
    expect(clampDockWidth(900, 200)).toBe(DOCK_MIN_WIDTH);
  });
});

describe("defect 5 — narrow right dock must not squeeze controls out of reach", () => {
  it("keeps every header control shrink-proof and drops the redundant shortcut hint", () => {
    const right = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "right",
        onPositionChange: noop,
      }),
    );
    // At w-96 the flex row previously compressed these below their hit area.
    expect(right).toContain("size-7 shrink-0");
    // The sidebar entry already shows Ctrl+`; repeating it here stole the width.
    expect(right).not.toContain("Ctrl+`");
    // Header paints above the pane so terminal output cannot cover the buttons.
    expect(right).toContain("relative z-10 flex h-9 shrink-0 items-center gap-1 overflow-hidden bg-surface");
  });

  it("still shows the shortcut hint at the roomier bottom dock", () => {
    const bottom = renderToString(
      createElement(TerminalDock, {
        open: true,
        projectId: "p",
        onToggle: noop,
        position: "bottom",
        onPositionChange: noop,
      }),
    );
    expect(bottom).toContain("Ctrl+`");
  });
});

describe("defect 3 — global terminal toggle in sidebar", () => {
  const baseProject: Project = {
    id: "p",
    name: "Demo",
    path: "/demo",
    preset: "local",
    engines: ["local"],
    watermarkAt: "2026-01-01",
  };

  const commonProps = {
    view: "overview" as ViewId,
    selected: null as TaskRow | null,
    tasksQuery: { isSuccess: true, isError: false, fetchStatus: "idle", status: "success" } as never,
    projectTasks: [] as TaskRow[],
    activeCount: 0,
    project: baseProject,
    projects: [baseProject],
    projectId: "p",
    tasks: [] as TaskRow[],
    projectSwitcherOpen: false,
    onProjectSwitcherToggle: noop,
    onManageAll: noop,
    openProject: noop,
    goto: noop,
    inboxCount: 0,
  };

  it("renders a terminal toggle button with the shortcut hint visible at a glance", () => {
    const html = renderToString(
      createElement(AppSidebar, { ...commonProps, terminalOpen: false, onToggleTerminal: noop }),
    );
    expect(html).toContain('data-testid="sidebar-terminal-toggle"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Open terminal");
    // The Ctrl+` shortcut is surfaced right on the sidebar entry, not buried.
    expect(html).toContain("Ctrl+`");
  });

  it("reflects the open state with aria-pressed and close tooltip", () => {
    const html = renderToString(
      createElement(AppSidebar, { ...commonProps, terminalOpen: true, onToggleTerminal: noop }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Close terminal");
  });
});

describe("defect 5 — pane status bar must not spill over the dock header", () => {
  it("clips its fixed-height status bar so long backend errors cannot escape it", () => {
    const html = renderToString(createElement(TerminalPane, { projectId: "p" }));
    // The bar is a fixed h-7; without overflow-hidden a long daemon error wraps
    // out of the box and paints over the dock controls above it.
    expect(html).toContain("h-7 shrink-0 items-center gap-2 overflow-hidden");
  });
});
