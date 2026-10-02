// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  clearPanelWorkspaceLayout,
  readPanelWorkspaceLayout,
  readPanelWorkspaceSelection,
  writePanelWorkspaceLayout,
  writePanelWorkspaceSelection,
  type PanelWorkspaceStorage,
} from "../src/renderer/panel-workspace/panel-workspace-layout.ts";

const slotPrefix = "harness:gui:panel-workspace:";

function storage(seed: Record<string, string> = {}): PanelWorkspaceStorage & { readonly store: Map<string, string> } {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
}

describe("panel workbench layout persistence (task_f82b0d6058966986403ef1b635)", () => {
  it("round-trips panel geometry per workspace slot and keeps other slots intact", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", {
      documents: { x: 16, y: 16, width: 320, height: 640 },
      graph: { x: 352, y: 16, width: 640, height: 640 },
    });
    writePanelWorkspaceLayout(disk, "local/repo-b", { timeline: { x: 0, y: 0, width: 200, height: 100 } });
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      documents: { x: 16, y: 16, width: 320, height: 640 },
      graph: { x: 352, y: 16, width: 640, height: 640 },
    });
    expect(readPanelWorkspaceLayout(disk, "local/repo-b")).toEqual({
      timeline: { x: 0, y: 0, width: 200, height: 100 },
    });
  });

  it("isolates slots by connection target: same repoId under different connections never shares a layout", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 1, y: 2, width: 3, height: 4 } });
    writePanelWorkspaceLayout(disk, "center-2/repo-a", { graph: { x: 5, y: 6, width: 7, height: 8 } });
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { documents: { x: 9, y: 9, width: 90, height: 90 } });
    expect(readPanelWorkspaceLayout(disk, "center-2/repo-a")).toEqual({ graph: { x: 5, y: 6, width: 7, height: 8 } });
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      documents: { x: 9, y: 9, width: 90, height: 90 },
    });
  });

  it("writes each workspace to its own slot key without touching other keys", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 1, y: 1, width: 2, height: 2 } });
    writePanelWorkspaceLayout(disk, "local/repo-b", { timeline: { x: 3, y: 3, width: 4, height: 4 } });
    expect([...disk.store.keys()].sort()).toEqual([`${slotPrefix}center-1/repo-a`, `${slotPrefix}local/repo-b`]);
  });

  it("rounds fractional geometry so stored layouts stay on the pixel grid", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", {
      graph: { x: -12.6, y: 8.2, width: 483.29, height: 99.4 },
    });
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      graph: { x: -13, y: 8, width: 483, height: 99 },
    });
  });

  it("drops damaged geometry entries individually instead of failing the whole layout", () => {
    const disk = storage({
      [`${slotPrefix}center-1/repo-a`]: JSON.stringify({
        schema: "panel-workspace/v1",
        layout: {
          documents: { x: 1, y: 2, width: 3, height: 4 },
          graph: { x: "left", y: 2, width: 3, height: 4 },
          timeline: { x: 1, y: Number.NaN, width: 3, height: 4 },
          "": { x: 1, y: 2, width: 3, height: 4 },
          stray: "not a geometry",
        },
      }),
    });
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      documents: { x: 1, y: 2, width: 3, height: 4 },
    });
  });

  it("falls back to the empty layout on unreadable storage or foreign schema", () => {
    const broken = storage({ [`${slotPrefix}center-1/repo-a`]: "{not json" });
    expect(readPanelWorkspaceLayout(broken, "center-1/repo-a")).toEqual({});
    const foreign = storage({
      [`${slotPrefix}center-1/repo-a`]: JSON.stringify({ schema: "other/v9", layout: {} }),
    });
    expect(readPanelWorkspaceLayout(foreign, "center-1/repo-a")).toEqual({});
    expect(readPanelWorkspaceLayout(null, "center-1/repo-a")).toEqual({});
  });

  it("clears only the requested workspace slot on reset", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 1, y: 1, width: 2, height: 2 } });
    writePanelWorkspaceLayout(disk, "local/repo-b", { graph: { x: 3, y: 3, width: 4, height: 4 } });
    clearPanelWorkspaceLayout(disk, "center-1/repo-a");
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({});
    expect(readPanelWorkspaceLayout(disk, "local/repo-b")).toEqual({ graph: { x: 3, y: 3, width: 4, height: 4 } });
  });

  it("propagates storage write failures instead of pretending the layout was saved", () => {
    const disk = storage();
    disk.store.set("sentinel", "keep");
    const failing: PanelWorkspaceStorage = {
      getItem: disk.getItem,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: disk.removeItem,
    };
    expect(() =>
      writePanelWorkspaceLayout(failing, "center-1/repo-a", { graph: { x: 1, y: 1, width: 2, height: 2 } }),
    ).toThrow("QuotaExceededError");
  });

  it("round-trips the panel selection per workspace slot without touching other slots", () => {
    const disk = storage();
    writePanelWorkspaceSelection(disk, "center-1/repo-a", ["graph", "sessions"]);
    writePanelWorkspaceSelection(disk, "local/repo-b", []);
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toEqual(["graph", "sessions"]);
    // 空集是合法值(显式关掉全部面板),不折叠回 null(那会误恢复默认清单)。
    expect(readPanelWorkspaceSelection(disk, "local/repo-b")).toEqual([]);
    expect(readPanelWorkspaceSelection(disk, "local/repo-c")).toBeNull();
  });

  it("keeps layout and selection in one slot without either write clobbering the other", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 1, y: 2, width: 3, height: 4 } });
    writePanelWorkspaceSelection(disk, "center-1/repo-a", ["graph", "timeline"]);
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      graph: { x: 1, y: 2, width: 3, height: 4 },
    });
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toEqual(["graph", "timeline"]);
    // 之后的几何落盘(拖动结束)也不抹掉已存的选择。
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 9, y: 9, width: 9, height: 9 } });
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toEqual(["graph", "timeline"]);
  });

  it("rebuilds a damaged slot record without losing the surviving field", () => {
    const disk = storage({
      [`${slotPrefix}center-1/repo-a`]: "{not json",
    });
    writePanelWorkspaceSelection(disk, "center-1/repo-a", ["overview"]);
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toEqual(["overview"]);
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({});
  });

  it("drops damaged selection entries instead of failing the whole selection", () => {
    const disk = storage({
      [`${slotPrefix}center-1/repo-a`]: JSON.stringify({
        schema: "panel-workspace/v1",
        layout: {},
        panels: ["graph", "", 7, null, "timeline"],
      }),
    });
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toEqual(["graph", "timeline"]);
  });

  it("reads legacy records without a panels field as null (caller falls back to defaults)", () => {
    const disk = storage({
      [`${slotPrefix}center-1/repo-a`]: JSON.stringify({
        schema: "panel-workspace/v1",
        layout: { graph: { x: 1, y: 1, width: 2, height: 2 } },
      }),
    });
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toBeNull();
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({
      graph: { x: 1, y: 1, width: 2, height: 2 },
    });
  });

  it("clears both layout and selection on reset", () => {
    const disk = storage();
    writePanelWorkspaceLayout(disk, "center-1/repo-a", { graph: { x: 1, y: 1, width: 2, height: 2 } });
    writePanelWorkspaceSelection(disk, "center-1/repo-a", ["graph"]);
    clearPanelWorkspaceLayout(disk, "center-1/repo-a");
    expect(readPanelWorkspaceLayout(disk, "center-1/repo-a")).toEqual({});
    expect(readPanelWorkspaceSelection(disk, "center-1/repo-a")).toBeNull();
  });

  it("propagates selection write failures instead of pretending the choice was saved", () => {
    const disk = storage();
    const failing: PanelWorkspaceStorage = {
      getItem: disk.getItem,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: disk.removeItem,
    };
    expect(() => writePanelWorkspaceSelection(failing, "center-1/repo-a", ["graph"])).toThrow("QuotaExceededError");
  });
});
