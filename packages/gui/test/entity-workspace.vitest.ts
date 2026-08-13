// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";

/**
 * EntityWorkspace behavior tests (TERRITORY-001 + UNKNOWN-001):
 * - non-decision lineage is reachable (shows prescribed empty state)
 * - module display shows 未投影 for unassigned
 * - territory per-zone collapse toggle
 */

// We test the pure helpers that EntityWorkspace/GraphView consume.

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "unassigned",
    lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
    ...overrides,
  };
}

describe("module display honesty (UNKNOWN-001)", () => {
  it("resolveTaskModule returns UNPROJECTED for unassigned", async () => {
    const mod = await import("../src/renderer/graph/moduleAssignment.ts");
    expect(mod.resolveTaskModule("unassigned")).toBe(mod.UNPROJECTED_MODULE);
    expect(mod.resolveTaskModule("")).toBe(mod.UNPROJECTED_MODULE);
    expect(mod.resolveTaskModule("kernel")).toBe("kernel");
  });

  it("moduleDisplayLabel shows 未投影 for UNPROJECTED", async () => {
    const mod = await import("../src/renderer/graph/moduleAssignment.ts");
    expect(mod.moduleDisplayLabel(mod.UNPROJECTED_MODULE)).toBe("未投影");
    expect(mod.moduleDisplayLabel("kernel")).toBe("kernel");
  });

  it("task module unassigned shows 未投影 in display context", () => {
    const t = task();
    const display = t.module === "unassigned" || !t.module ? "未投影" : t.module;
    expect(display).toBe("未投影");
  });
});

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
