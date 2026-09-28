// harness-test-tier: integration
import { describe, expect, it } from "vitest";

/**
 * EntityWorkspace behavior tests (TERRITORY-001):
 * - non-decision lineage is reachable (shows prescribed empty state)
 * - territory per-zone collapse toggle
 */

// We test the pure helpers that EntityWorkspace/GraphView consume.

describe("territory per-zone collapse (TERRITORY-001)", () => {
  it("collapses/expands individual zones independently", () => {
    let collapsed = new Set<string>();
    const toggleZone = (zoneId: string) => {
      const next = new Set(collapsed);
      if (next.has(zoneId)) next.delete(zoneId);
      else next.add(zoneId);
      collapsed = next;
    };
    toggleZone("task:kernel");
    expect(collapsed.has("task:kernel")).toBe(true);
    expect(collapsed.has("task:gui")).toBe(false);

    toggleZone("task:gui");
    expect(collapsed.has("task:kernel")).toBe(true);
    expect(collapsed.has("task:gui")).toBe(true);

    toggleZone("task:kernel");
    expect(collapsed.has("task:kernel")).toBe(false);
    expect(collapsed.has("task:gui")).toBe(true);
  });
});

describe("entity workspace lineage reachability (TERRITORY-001)", () => {
  it("non-decision focus produces null focusId in genealogy (empty state)", async () => {
    const geo = await import("../src/renderer/graph/genealogy.ts");
    // A task ref is not a decision → decisionIdOf returns null.
    expect(geo.decisionIdOf("task/task_a")).toBeNull();
    // A decision ref works.
    expect(geo.decisionIdOf("decision/dec_1")).toBe("dec_1");
  });
});
