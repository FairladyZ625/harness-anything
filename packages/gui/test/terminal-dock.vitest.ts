// harness-test-tier: fast
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { TerminalSessionManager } from "../src/renderer/components/terminal/TerminalSessionManager.tsx";
import { TerminalDock } from "../src/renderer/components/terminal/TerminalDock.tsx";
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
  it("renders bottom position with horizontal height and top border", () => {
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
    expect(html).toContain("h-80");
    expect(html).not.toContain("border-l");
    expect(html).not.toContain("w-96");
  });

  it("renders right position with fixed width and left border", () => {
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
    expect(html).toContain("w-96");
    expect(html).not.toContain("h-80");
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
    expect(html).not.toContain("w-96");
    expect(html).not.toContain("border-l");
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
