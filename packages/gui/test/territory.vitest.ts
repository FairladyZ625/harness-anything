// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import type { FactAnchorRow } from "../src/api/renderer-dto.ts";
import {
  partitionTasks,
  partitionDecisions,
  partitionFacts,
  partitionForSkel,
} from "../src/renderer/graph/territory.ts";
import { UNPROJECTED_MODULE, resolveTaskModule, isModuleUnprojected } from "../src/renderer/graph/moduleAssignment.ts";

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: "task_a",
    title: "Task A",
    projectId: "proj",
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "kernel",
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...overrides,
  };
}

function dec(overrides: Partial<DecisionRow> = {}): DecisionRow {
  return {
    decisionId: "dec_1",
    title: "D1",
    state: "active",
    question: "Q?",
    chosen: [],
    rejected: [],
    claims: [],
    proposedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as DecisionRow;
}

describe("module assignment honesty (未投影)", () => {
  it("treats unassigned/empty/unknown module as unprojected", () => {
    expect(isModuleUnprojected("unassigned")).toBe(true);
    expect(isModuleUnprojected("")).toBe(true);
    expect(isModuleUnprojected(undefined)).toBe(true);
    expect(isModuleUnprojected("kernel")).toBe(false);
  });

  it("resolves placeholder modules to UNPROJECTED sentinel", () => {
    expect(resolveTaskModule("unassigned")).toBe(UNPROJECTED_MODULE);
    expect(resolveTaskModule("kernel")).toBe("kernel");
  });
});

describe("territory task partition", () => {
  it("groups tasks by real module", () => {
    const zones = partitionTasks([
      task({ taskId: "a", module: "kernel" }),
      task({ taskId: "b", module: "kernel" }),
      task({ taskId: "c", module: "gui" }),
    ]);
    expect(zones).toHaveLength(2);
    const kernel = zones.find((z) => z.title === "kernel")!;
    expect(kernel.chips).toHaveLength(2);
  });

  it("puts unassigned-module tasks into a 未投影 zone, not a real module", () => {
    const zones = partitionTasks([task({ taskId: "a", module: "unassigned" })]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.title).toBe("未投影");
    expect(zones[0]!.moduleId).toBe(UNPROJECTED_MODULE);
  });

  it("sorts 未投影 zone last", () => {
    const zones = partitionTasks([
      task({ taskId: "a", module: "unassigned" }),
      task({ taskId: "b", module: "kernel" }),
    ]);
    expect(zones[1]!.title).toBe("未投影");
  });
});

describe("territory decision partition", () => {
  it("groups connected decisions into family zones", () => {
    const decisions = [
      dec({ decisionId: "dec_1" }),
      dec({ decisionId: "dec_2", title: "D2" }),
      dec({ decisionId: "dec_3", title: "D3 lone" }),
    ];
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: "decision/dec_2", kind: "refines", provenance: "local-document" },
    ];
    const { zones, landing } = partitionDecisions(decisions, relations);
    expect(zones).toHaveLength(1); // dec_1 + dec_2 family
    expect(zones[0]!.chips).toHaveLength(2);
    expect(landing).toHaveLength(1); // dec_3 lone
    expect(landing[0]!.navRef).toBe("decision/dec_3");
  });
});

describe("territory fact partition", () => {
  it("groups facts by host task module, 未投影 when host absent", () => {
    const facts: FactRef[] = [
      { anchor: "task_a/F-1", taskId: "task_a", category: "finding", text: "x", at: "2026-08-01", confidence: "high" },
    ];
    const anchors: FactAnchorRow[] = [];
    const tasks = [task({ taskId: "task_a", module: "kernel" })];
    const zones = partitionFacts(facts, anchors, tasks, []);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.title).toBe("kernel");
  });

  it("marks invalidated facts in chip sub label", () => {
    const facts: FactRef[] = [
      { anchor: "task_a/F-1", taskId: "task_a", category: "finding", text: "x", at: "2026-08-01", confidence: "high", invalidated: true },
    ];
    const zones = partitionFacts(facts, [], [task()], []);
    expect(zones[0]!.chips[0]!.sub).toBe("已失效");
  });
});

describe("territory skeleton dispatch", () => {
  it("unified skel returns all entity zones", () => {
    const result = partitionForSkel(
      "unified",
      [task()],
      [dec()],
      [],
      [],
      [],
    );
    expect(result.zones.length).toBeGreaterThanOrEqual(1);
  });

  it("task skel returns only task zones", () => {
    const result = partitionForSkel("task", [task()], [dec()], [], [], []);
    expect(result.zones.every((z) => z.entity === "task")).toBe(true);
  });
});
