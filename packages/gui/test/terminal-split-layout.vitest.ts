// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  gridPaneRefs,
  groupPaneRefs,
  layoutSessionIds,
  readTerminalLayout,
  writeTerminalLayout,
  type TerminalGridSnapshot,
  type TerminalRepoLayout,
} from "../src/renderer/terminal-layout.ts";
import { directionalPane, type PaneBox } from "../src/renderer/terminal-pane-focus.ts";

/** dockview `toJSON()` 的真实形状(两个左右并排的 pane),只有 params.sessionId 被渲染层解释。 */
const grid: TerminalGridSnapshot = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["pane-a"], activeView: "pane-a", id: "1" }, size: 420 },
        { type: "leaf", data: { views: ["pane-b"], activeView: "pane-b", id: "2" }, size: 380 },
      ],
      size: 600,
    },
    width: 800,
    height: 600,
    orientation: "HORIZONTAL",
  },
  panels: {
    "pane-a": { id: "pane-a", contentComponent: "terminalPane", params: { sessionId: "s-a" }, title: "pane-a" },
    "pane-b": { id: "pane-b", contentComponent: "terminalPane", params: { sessionId: "s-b" }, title: "pane-b" },
  },
  activeGroup: "2",
};

function storage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("terminal split layout serialization (PLT-TerminalWorkspace W1)", () => {
  it("reads the pane→session mapping out of a dockview snapshot", () => {
    expect(gridPaneRefs(grid)).toEqual([
      { panelId: "pane-a", sessionId: "s-a" },
      { panelId: "pane-b", sessionId: "s-b" },
    ]);
  });

  it("treats the snapshot as authoritative once present and falls back to seeds otherwise", () => {
    expect(groupPaneRefs({ groupId: "g1", seeds: [{ panelId: "seed", sessionId: "s-seed" }], grid })).toHaveLength(2);
    expect(groupPaneRefs({ groupId: "g1", seeds: [{ panelId: "seed", sessionId: "s-seed" }], grid: null })).toEqual([
      { panelId: "seed", sessionId: "s-seed" },
    ]);
    expect(groupPaneRefs({ groupId: "g1", seeds: [], grid: { panels: {} } })).toEqual([]);
  });

  it("round-trips a layout per repository and keeps other repositories intact", () => {
    const disk = storage();
    const repoA: TerminalRepoLayout = { activeGroupId: "g1", groups: [{ groupId: "g1", seeds: [], grid }] };
    const repoB: TerminalRepoLayout = {
      activeGroupId: "g2",
      groups: [{ groupId: "g2", seeds: [{ panelId: "p-1", sessionId: "s-only" }], grid: null }],
    };
    writeTerminalLayout(disk, "repo-a", repoA);
    writeTerminalLayout(disk, "repo-b", repoB);
    expect(readTerminalLayout(disk, "repo-a")).toEqual(repoA);
    expect(readTerminalLayout(disk, "repo-b")).toEqual(repoB);
    expect(layoutSessionIds(readTerminalLayout(disk, "repo-a"))).toEqual(["s-a", "s-b"]);
    // 写入的 JSON 样本本身也是证据:pane 载荷里必须带得回 sessionId。
    const written: unknown = JSON.parse(disk.store.get("harness:gui:terminal-layout") ?? "null");
    expect(JSON.stringify(written)).toContain('"sessionId":"s-a"');
  });

  it("falls back to an empty layout for foreign schemas, corrupt json and unknown repositories", () => {
    expect(readTerminalLayout(storage({ "harness:gui:terminal-layout": "{" }), "repo-a").groups).toEqual([]);
    const foreign = storage({ "harness:gui:terminal-layout": JSON.stringify({ schema: "other/v9", repos: {} }) });
    expect(readTerminalLayout(foreign, "repo-a").groups).toEqual([]);
    const disk = storage();
    writeTerminalLayout(disk, "repo-a", { activeGroupId: "g1", groups: [{ groupId: "g1", seeds: [], grid }] });
    expect(readTerminalLayout(disk, "repo-missing").groups).toEqual([]);
  });

  it("drops groups with no panes and repairs a dangling active group id", () => {
    const disk = storage();
    writeTerminalLayout(disk, "repo-a", {
      activeGroupId: "ghost",
      groups: [
        { groupId: "empty", seeds: [], grid: null },
        { groupId: "g1", seeds: [], grid },
      ],
    });
    const restored = readTerminalLayout(disk, "repo-a");
    expect(restored.groups.map((group) => group.groupId)).toEqual(["g1"]);
    expect(restored.activeGroupId).toBe("g1");
  });
});

describe("terminal pane directional focus (PLT-TerminalWorkspace W1)", () => {
  // 左侧整列 + 右侧上下两块:方向导航必须按几何相邻挑,而不是按插入顺序。
  const boxes: readonly PaneBox[] = [
    { panelId: "left", left: 0, top: 0, right: 400, bottom: 600 },
    { panelId: "right-top", left: 400, top: 0, right: 800, bottom: 300 },
    { panelId: "right-bottom", left: 400, top: 300, right: 800, bottom: 600 },
  ];

  it("prefers the neighbour that overlaps on the orthogonal axis", () => {
    expect(directionalPane(boxes, "left", "right")).toBe("right-top");
    expect(directionalPane(boxes, "right-bottom", "left")).toBe("left");
  });

  it("moves within a column and stops at the edges", () => {
    expect(directionalPane(boxes, "right-top", "down")).toBe("right-bottom");
    expect(directionalPane(boxes, "right-bottom", "up")).toBe("right-top");
    expect(directionalPane(boxes, "left", "up")).toBeNull();
    expect(directionalPane(boxes, "right-top", "right")).toBeNull();
  });

  it("returns nothing when the focused pane is unknown or alone", () => {
    expect(directionalPane(boxes, null, "right")).toBeNull();
    expect(directionalPane(boxes, "missing", "left")).toBeNull();
    expect(directionalPane([boxes[0]], "left", "right")).toBeNull();
  });
});
