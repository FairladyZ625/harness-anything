// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import type { TaskRow, DecisionRow, FactRef, RelationEdge } from "../src/renderer/model/types.ts";
import type { FactAnchorRow, RelationCoverageRow } from "../src/api/renderer-dto.ts";
import {
  partitionTasks,
  partitionDecisions,
  partitionFacts,
  partitionFactsByAnomaly,
  partitionForSkel,
  classifyFactAnomaly,
} from "../src/renderer/graph/territory.ts";
import { UNPROJECTED_MODULE, resolveTaskModule, isModuleUnprojected } from "../src/renderer/graph/moduleAssignment.ts";
import { defaultEntityStatusFilter, taskPassesStatusFilter, decisionPassesStateFilter } from "../src/renderer/graph/entityStatusFilter.ts";

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

function fact(overrides: Partial<FactRef> = {}): FactRef {
  return {
    anchor: "task_a/F-1",
    taskId: "task_a",
    category: "finding",
    text: "observation",
    at: "2026-08-01T00:00:00.000Z",
    confidence: "high",
    ...overrides,
  };
}

function anchor(f: FactRef = fact()): FactAnchorRow {
  return {
    factRef: `fact/${f.anchor}`,
    taskId: f.taskId,
    factId: f.anchor.split("/").at(-1) ?? "F-1",
    sourcePath: `event:fact/${f.anchor}`,
  };
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
  // 分组轴已从 module 换成 PRD 根 task(老版领地的「每个 PRD 的进度」能力)。
  // module 不再决定摆放,但它的诚实性仍然承重 —— 见下面的 chip 级断言。
  it("groups tasks by their PRD root task", () => {
    const zones = partitionTasks([
      task({ taskId: "root", title: "PRD", rootTaskId: "root" }),
      task({ taskId: "a", parentTaskId: "root", rootTaskId: "root", rootTitle: "PRD" }),
      task({ taskId: "b", parentTaskId: "root", rootTaskId: "root", rootTitle: "PRD" }),
    ]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.title).toBe("PRD");
    expect(zones[0]!.chips).toHaveLength(3);
    expect(zones[0]!.progress?.total).toBe(3);
  });

  it("never fakes a real module for an unassigned task (chip keeps the sentinel)", () => {
    const zones = partitionTasks([task({ taskId: "a", module: "unassigned" })]);
    // 顶层无父任务的 task 自己就是一个 PRD 根,所以成块 —— 但它的 module 仍诚实标未投影。
    expect(zones[0]!.chips[0]!.moduleId).toBe(UNPROJECTED_MODULE);
  });

  it("sinks the 未投影 block last and keeps it visible", () => {
    const zones = partitionTasks([
      task({ taskId: "orphan", parentTaskId: "ghost", module: "unassigned" }),
      task({ taskId: "root", title: "PRD", rootTaskId: "root", module: "kernel" }),
    ]);
    expect(zones.at(-1)!.title).toBe("未投影");
    expect(zones.at(-1)!.moduleId).toBe(UNPROJECTED_MODULE);
    expect(zones.at(-1)!.chips).toHaveLength(1);
  });

  it("counts unprojected at chip level so PRD grouping cannot hide missing modules", () => {
    const partition = partitionForSkel(
      "task",
      [
        task({ taskId: "root", title: "PRD", rootTaskId: "root", module: "kernel" }),
        task({ taskId: "a", parentTaskId: "root", rootTaskId: "root", module: "unassigned" }),
      ],
      [], [], [], [],
    );
    // a 落在真实 PRD 块里,但 module 缺失仍被计入未投影总数(块级计数会漏报)。
    expect(partition.unprojectedCount).toBe(1);
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
      [],
    );
    expect(result.zones.length).toBeGreaterThanOrEqual(1);
  });

  it("task skel returns only task zones", () => {
    const result = partitionForSkel("task", [task()], [dec()], [], [], [], []);
    expect(result.zones.every((z) => z.entity === "task")).toBe(true);
  });

  it("fact skel uses anomaly partition", () => {
    const f = fact({ anchor: "task_a/F-orphan" });
    const result = partitionForSkel("fact", [task()], [], [f], [anchor(f)], [], []);
    // Orphan fact → should have an anomaly zone.
    expect(result.zones.some((z) => z.zoneId.includes("anomaly:orphan"))).toBe(true);
  });
});

describe("fact anomaly classification (TERRITORY-001)", () => {
  it("classifies a fact with invalidated-by edge as contradictory", () => {
    const f = fact({ anchor: "task_a/F-contr" });
    const relations: RelationEdge[] = [
      { from: `fact/${f.anchor}`, to: "decision/dec_1", kind: "invalidated-by", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, relations, new Set())).toBe("contradictory");
  });

  it("classifies a fact with invalidated flag as contradictory", () => {
    const f = fact({ anchor: "task_a/F-inval", invalidated: true });
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, [], new Set())).toBe("contradictory");
  });

  it("classifies a fact targeted by supersedes-fact as superseded", () => {
    const f = fact({ anchor: "task_a/F-old" });
    const relations: RelationEdge[] = [
      { from: "fact/task_a/F-new", to: `fact/${f.anchor}`, kind: "supersedes-fact", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, relations, new Set())).toBe("superseded");
  });

  it("classifies a low-confidence fact as low-confidence", () => {
    const f = fact({ anchor: "task_a/F-low", confidence: "low" });
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, [], new Set())).toBe("low-confidence");
  });

  it("classifies a fact with no coverage or evidence as orphan", () => {
    const f = fact({ anchor: "task_a/F-orphan" });
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, [], new Set())).toBe("orphan");
  });

  it("classifies a covered fact with evidence as normal", () => {
    const f = fact({ anchor: "task_a/F-ok" });
    const relations: RelationEdge[] = [
      { from: "decision/dec_1/CH1", to: `fact/${f.anchor}`, kind: "evidenced-by", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(`fact/${f.anchor}`, f, relations, new Set())).toBe("normal");
  });
});

describe("fact anomaly partition (partitionFactsByAnomaly)", () => {
  it("creates separate zones for contradictory, orphan, low-confidence, superseded", () => {
    const fContr = fact({ anchor: "task_a/F-contr", invalidated: true });
    const fOrphan = fact({ anchor: "task_a/F-orphan" });
    const fLow = fact({ anchor: "task_a/F-low", confidence: "low" });
    const fSuper = fact({ anchor: "task_a/F-old" });
    const fOk = fact({ anchor: "task_a/F-ok" });
    const relations: RelationEdge[] = [
      { from: "fact/task_a/F-new", to: "fact/task_a/F-old", kind: "supersedes-fact", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-ok", kind: "evidenced-by", provenance: "local-document" },
    ];
    const coverage: RelationCoverageRow[] = [];
    const zones = partitionFactsByAnomaly(
      [fContr, fOrphan, fLow, fSuper, fOk],
      [],
      [task()],
      relations,
      coverage,
    );
    const anomalyZones = zones.filter((z) => z.zoneId.includes("anomaly:"));
    expect(anomalyZones.length).toBe(4); // contradictory + orphan + low-confidence + superseded
    expect(anomalyZones.some((z) => z.title.includes("矛盾"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("悬空"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("低置信"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("被取代"))).toBe(true);
    // Normal facts get their own module-based zones.
    const normalZones = zones.filter((z) => z.zoneId.includes("fact:normal:"));
    expect(normalZones.length).toBeGreaterThanOrEqual(1);
  });

  it("orders anomaly zones before normal zones", () => {
    const fOrphan = fact({ anchor: "task_a/F-orphan" });
    const fOk = fact({ anchor: "task_a/F-ok" });
    const relations: RelationEdge[] = [
      { from: "decision/dec_1/CH1", to: "fact/task_a/F-ok", kind: "evidenced-by", provenance: "local-document" },
    ];
    const zones = partitionFactsByAnomaly([fOrphan, fOk], [], [task()], relations, []);
    const orphanIdx = zones.findIndex((z) => z.zoneId.includes("anomaly:orphan"));
    const normalIdx = zones.findIndex((z) => z.zoneId.includes("fact:normal:"));
    expect(orphanIdx).toBeLessThan(normalIdx);
    expect(orphanIdx).toBeGreaterThanOrEqual(0);
  });
});

/**
 * 领地筛选覆盖面(archive 线 territoryLayout/territoryPartition 在领地上同样应用实体状态筛选)。
 *
 * rebuild 线把状态筛选下沉到**行**上:GraphView 先用这两个谓词过滤 tasks/decisions,
 * 再交给 partitionForSkel。因此块计数与可见 chip 天然一致,不会出现「筛选徽章记了一笔、
 * 领地画布纹丝不动」的空筛。本组测试锁的是这条组合链的可观察结果。
 */
describe("territory honours the entity-status filter through the row predicates", () => {
  const rows = [
    task({ taskId: "t_active", title: "Active", coordinationStatus: "active", module: "kernel" }),
    task({ taskId: "t_done", title: "Done", coordinationStatus: "done", module: "kernel" }),
  ];

  function chipNavRefs(tasks: ReadonlyArray<TaskRow>): string[] {
    const partition = partitionForSkel("task", tasks, [], [], [], [], []);
    return [...partition.zones.flatMap((zone) => zone.chips), ...partition.landing].map((chip) => chip.navRef).sort();
  }

  it("drops the tasks whose status is filtered off", () => {
    const filter = defaultEntityStatusFilter();
    filter.taskStatuses.delete("done");
    const visible = rows.filter((row) => taskPassesStatusFilter(row, filter));
    expect(visible.map((row) => row.taskId)).toEqual(["t_active"]);
    expect(chipNavRefs(visible)).not.toContain("task/t_done");
  });

  it("keeps every task under the default all-selected filter", () => {
    const filter = defaultEntityStatusFilter();
    expect(rows.filter((row) => taskPassesStatusFilter(row, filter))).toHaveLength(2);
    expect(chipNavRefs(rows)).toEqual(["task/t_active", "task/t_done"]);
  });

  it("drops the decisions whose state is filtered off", () => {
    const filter = defaultEntityStatusFilter();
    filter.decisionStates.delete("retired");
    const decisions = [dec(), { ...dec(), decisionId: "dec_2", state: "retired" } as DecisionRow];
    const visible = decisions.filter((row) => decisionPassesStateFilter(row, filter));
    expect(visible.map((row) => row.decisionId)).toEqual(["dec_1"]);
  });
});
