// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GraphFilterPanel, type GraphFilters } from "../src/renderer/components/GraphFilterPanel.tsx";
import { buildEgoGraph, bfsShownFromFocus, layoutEgoCanvas } from "../src/renderer/graph/egoCanvas.ts";
import { defaultAxisFilter, defaultKindFilter } from "../src/renderer/graph/relationVisual.ts";
import { defaultEntityStatusFilter } from "../src/renderer/graph/entityStatusFilter.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

const tasks: TaskRow[] = Array.from({ length: 9 }, (_, index) => ({
  taskId: String(index),
  title: `任务 ${index}`,
  projectId: "p",
  coordinationStatus: "active",
  rawStatus: "active",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "not_required",
  engine: "local",
  source: "local-document",
  lastKnownAt: "2026-10-09T00:00:00Z",
  gates: [],
  docs: [],
  ...(index ? { parentTaskId: "0" } : {}),
  ...projectedTaskFields("active"),
}));
const axes = defaultAxisFilter();
const graph = buildEgoGraph(tasks, [], [], []);
const input = {
  focusId: "0",
  graph,
  relations: [],
  filters: { axes, kinds: defaultKindFilter(), types: null, flowMode: "off" as const },
  shown: bfsShownFromFocus(graph, "0", { up: 1, down: 1 }, axes),
  expanded: new Set(["0"]),
};

describe("reading footprints preserve a usable spotlight", () => {
  it("short tasks do not occupy a blank 300px focus card or 480px tracks", () => {
    const layout = layoutEgoCanvas(input);
    expect(layout.nodes.find((node) => node.id === "0")!.height).toBeLessThan(250);
    const neighbors = layout.nodes.filter((node) => node.id !== "0").sort((a, b) => a.position.y - b.position.y);
    expect(neighbors.at(-1)!.position.y - neighbors[0]!.position.y).toBe(7 * 82);
    const centers = new Map(
      layout.nodes.map((node) => [
        node.id,
        { x: node.position.x + Number(node.width) / 2, y: node.position.y + Number(node.height) / 2 },
      ]),
    );
    const expanded = layoutEgoCanvas({ ...input, centers, expanded: new Set(tasks.map((task) => task.taskId)) });
    for (const node of expanded.nodes)
      expect({ x: node.position.x + Number(node.width) / 2, y: node.position.y + Number(node.height) / 2 }).toEqual(
        centers.get(node.id),
      );
    expect(expanded.nodes.find((node) => node.id === "1")!.zIndex).toBeGreaterThan(neighbors[0]!.zIndex!);
  });
  it("36 collapsed nodes keep the historical 82px neighbor pitch regardless of their reading content", () => {
    const largeTasks = Array.from({ length: 36 }, (_, index) => ({
      ...tasks[index % tasks.length]!,
      taskId: String(index),
      title: "长标题".repeat(80),
      ...(index ? { parentTaskId: "0" } : {}),
    }));
    const graph = buildEgoGraph(largeTasks, [], [], []);
    const largeInput = { ...input, graph, shown: bfsShownFromFocus(graph, "0", { up: 1, down: 1 }, axes) };
    const layout = layoutEgoCanvas(largeInput);
    const neighbors = layout.nodes.filter((node) => node.id !== "0").sort((a, b) => a.position.y - b.position.y);
    expect(neighbors).toHaveLength(35);
    for (let index = 1; index < neighbors.length; index++)
      expect(neighbors[index]!.position.y - neighbors[index - 1]!.position.y).toBe(82);
    expect(neighbors.at(-1)!.position.y - neighbors[0]!.position.y).toBe(34 * 82);
    const expanded = layoutEgoCanvas({ ...largeInput, expanded: new Set(["0", "1"]) });
    for (const node of expanded.nodes) {
      const before = layout.nodes.find((other) => other.id === node.id)!;
      expect([node.position.x + Number(node.width) / 2, node.position.y + Number(node.height) / 2]).toEqual([
        before.position.x + Number(before.width) / 2,
        before.position.y + Number(before.height) / 2,
      ]);
    }
    expect(expanded.nodes.find((node) => node.id === "1")!.zIndex).toBeGreaterThan(
      expanded.nodes.find((node) => node.id === "2")!.zIndex!,
    );
    expect(expanded.nodes.find((node) => node.id === "1")!.zIndex).toBeGreaterThanOrEqual(
      expanded.nodes.find((node) => node.id === "0")!.zIndex!,
    );
  });
});

let root: Root | undefined;
let host: HTMLDivElement;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
});
function Filters() {
  const [filters, setFilters] = useState<GraphFilters>({
    types: new Set(["task", "decision", "fact", "custom-kind"]),
    axes,
    kinds: defaultKindFilter(),
    entityStatus: defaultEntityStatusFilter(),
    density: "focus",
  });
  return createElement(GraphFilterPanel, {
    filters,
    setFilters,
    flowMode: "focus",
    onFlowModeChange: () => {},
    entityTypeOptions: ["task", "decision", "fact", "custom-kind"].map((kind) => ({ kind, label: kind })),
  });
}
async function mountFilters() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(createElement(Filters)));
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
}

describe("progressive graph filters", () => {
  it("keeps the full declared catalog and relation/status controls behind secondary disclosures", async () => {
    await mountFilters();
    const extra = host.querySelector<HTMLDetailsElement>("[data-testid='graph-filter-more-types']");
    expect(extra).not.toBeNull();
    expect(extra!.open).toBe(false);
    expect(extra!.querySelector("[data-testid='graph-filter-entity-type-custom-kind']")).not.toBeNull();
    expect(host.querySelector<HTMLDetailsElement>("[data-testid='graph-filter-kinds']")!.open).toBe(false);
    expect(host.querySelector<HTMLDetailsElement>("[data-testid='graph-filter-status']")!.open).toBe(false);
    await act(async () => {
      extra!.open = true;
      host.querySelector<HTMLButtonElement>("[data-testid='graph-filter-entity-type-custom-kind']")!.click();
    });
    expect(
      host.querySelector("[data-testid='graph-filter-entity-type-custom-kind']")!.getAttribute("aria-pressed"),
    ).toBe("false");
    expect(host.querySelector("[data-testid='graph-filter-entity-type-task']")!.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });
});
