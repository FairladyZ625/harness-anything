// harness-test-tier: fast
import { expect, it } from "vitest";
import {
  readPanelWorkspaceLayout,
  writePanelWorkspaceLayout,
  clearPanelWorkspaceLayout,
  type PanelWorkspaceStorage,
} from "../src/renderer/panel-workspace/panel-workspace-layout.ts";
function storage(): PanelWorkspaceStorage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}
it("roundtrips selection and rounded geometry as one per-target snapshot", () => {
  const disk = storage();
  writePanelWorkspaceLayout(disk, "center/repo", {
    panels: ["graph"],
    layout: { graph: { x: 1.4, y: 2.7, width: 301.4, height: 200.8 } },
  });
  expect(readPanelWorkspaceLayout(disk, "center/repo")).toEqual({
    panels: ["graph"],
    layout: { graph: { x: 1, y: 3, width: 301, height: 201 } },
  });
  expect(readPanelWorkspaceLayout(disk, "other/repo")).toEqual({ panels: null, layout: {} });
});
it("preserves a deliberately empty canvas and resets only its target", () => {
  const disk = storage();
  writePanelWorkspaceLayout(disk, "a", { panels: [], layout: {} });
  writePanelWorkspaceLayout(disk, "b", { panels: ["graph"], layout: {} });
  expect(readPanelWorkspaceLayout(disk, "a").panels).toEqual([]);
  clearPanelWorkspaceLayout(disk, "a");
  expect(readPanelWorkspaceLayout(disk, "a").panels).toBeNull();
  expect(readPanelWorkspaceLayout(disk, "b").panels).toEqual(["graph"]);
});
it("resets damaged records and filters malformed geometry and identities", () => {
  const disk = storage();
  disk.store.set("harness:gui:panel-workspace:a", "{invalid");
  expect(readPanelWorkspaceLayout(disk, "a")).toEqual({ panels: null, layout: {} });
  disk.store.set(
    "harness:gui:panel-workspace:a",
    JSON.stringify({ schema: "panel-workspace/v1", panels: ["graph", null, ""], layout: { graph: { x: "bad" } } }),
  );
  expect(readPanelWorkspaceLayout(disk, "a")).toEqual({ panels: ["graph"], layout: {} });
});
it("propagates write failures rather than claiming a saved layout", () => {
  const disk = storage();
  disk.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  expect(() => writePanelWorkspaceLayout(disk, "a", { panels: [], layout: {} })).toThrow("QuotaExceededError");
});
