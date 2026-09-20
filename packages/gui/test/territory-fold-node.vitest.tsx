// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TerritoryChipNode } from "../src/renderer/graph/nodes/TerritoryNode.tsx";
import type { TerritoryFoldFlowNode } from "../src/renderer/graph/territoryLayout.ts";

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of mounted.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const mounted: Root[] = [];

async function mount(node: React.ReactNode) {
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  mounted.push(root);
  await act(async () => {
    root.render(node);
  });
  return container;
}

describe("TerritoryChipNode (fold variants)", () => {
  it("deferred fold button triggers onRevealZone and has nodrag / cursor-pointer", async () => {
    const onFold = vi.fn();
    const onRevealZone = vi.fn();
    const node: TerritoryFoldFlowNode = {
      id: "territory-fold:deferred:zone_test",
      type: "territoryChip",
      position: { x: 0, y: 0 },
      data: {
        chip: null,
        fold: {
          zoneId: "zone_test",
          hidden: 2,
          deferred: true,
        },
        onFold,
        onRevealZone,
      },
    };

    const container = await mount(
      createElement(TerritoryChipNode, { ...node, selected: false, dragging: false, zIndex: 0 }),
    );
    const button = container.querySelector<HTMLButtonElement>("[data-testid='territory-fold']");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("▸ 重点外 2 项 —— 点击展开本块");
    expect(button?.getAttribute("type")).toBe("button");
    expect(button?.classList.contains("nodrag")).toBe(true);
    expect(button?.classList.contains("cursor-pointer")).toBe(true);

    await act(async () => {
      button?.click();
    });

    expect(onRevealZone).toHaveBeenCalledWith("zone_test");
    expect(onFold).not.toHaveBeenCalled();
  });

  it("cap fold button triggers onFold for normal truncation", async () => {
    const onFold = vi.fn();
    const onRevealZone = vi.fn();
    const node: TerritoryFoldFlowNode = {
      id: "territory-fold:cap:zone_test",
      type: "territoryChip",
      position: { x: 0, y: 0 },
      data: {
        chip: null,
        fold: {
          zoneId: "zone_test",
          hidden: 15,
          deferred: false,
        },
        onFold,
        onRevealZone,
      },
    };

    const container = await mount(
      createElement(TerritoryChipNode, { ...node, selected: false, dragging: false, zIndex: 0 }),
    );
    const button = container.querySelector<HTMLButtonElement>("[data-testid='territory-fold']");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("▸ 还有 15 项 —— 点击展开");

    await act(async () => {
      button?.click();
    });

    expect(onFold).toHaveBeenCalledWith("zone_test");
    expect(onRevealZone).not.toHaveBeenCalled();
  });
});
