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
  factHostTaskIds,
  isFactVisibleWithHost,
} from "../src/renderer/graph/territory.ts";
import { NO_WORK, NO_WORK_TITLE } from "../src/renderer/graph/territoryProgress.ts";
import {
  defaultEntityStatusFilter,
  taskPassesStatusFilter,
  decisionPassesStateFilter,
} from "../src/renderer/graph/entityStatusFilter.ts";
import { isTaskArchiveNoise } from "../src/renderer/model/taskFilters.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

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
    lastKnownAt: "2026-08-01T00:00:00.000Z",
    gates: [],
    docs: [],
    ...projectedTaskFields(overrides.coordinationStatus ?? "active", {
      archived: (overrides.packageDisposition ?? "active") !== "active",
    }),
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
    anchor: "fact/F-1",
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
    factRef: f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`,
    taskId: f.taskId,
    factId: f.anchor.split("/").at(-1) ?? "F-1",
    sourcePath: `event:${f.anchor.startsWith("fact/") ? f.anchor : `fact/${f.anchor}`}`,
  };
}

describe("territory task partition", () => {
  // 分组轴 = 工作(dec_5F7E74F1):daemon 工作索引盖在行上的 workId,与 `ha work list` 一一对应。
  it("groups tasks by their work root task", () => {
    const zones = partitionTasks([
      task({ taskId: "root", title: "Work", workId: "root" }),
      task({ taskId: "a", parentTaskId: "root", workId: "root", workTitle: "Work" }),
      task({ taskId: "b", parentTaskId: "root", workId: "root", workTitle: "Work" }),
    ]);
    expect(zones).toHaveLength(1);
    expect(zones[0]!.title).toBe("Work");
    expect(zones[0]!.chips).toHaveLength(3);
    expect(zones[0]!.progress?.total).toBe(3);
  });

  it("uses the daemon's work as the chip groupId; a top-level task in no work gets no zone of its own", () => {
    const zones = partitionTasks([task({ taskId: "a", workId: "w", workTitle: "W" }), task({ taskId: "solo" })]);
    expect(zones.map((zone) => [zone.groupId, zone.chips.map((chip) => chip.groupId)])).toEqual([
      ["w", ["w"]],
      [NO_WORK, [NO_WORK]],
    ]);
  });

  it("sinks the standalone block last and keeps it visible", () => {
    const zones = partitionTasks([
      task({ taskId: "orphan", parentTaskId: "ghost" }),
      task({ taskId: "root", title: "Work", workId: "root" }),
    ]);
    expect(zones.at(-1)!.title).toBe(NO_WORK_TITLE);
    expect(zones.at(-1)!.groupId).toBe(NO_WORK);
    expect(zones.at(-1)!.chips).toHaveLength(1);
  });

  it("counts only tasks in no work (CEO ruling)", () => {
    const partition = partitionForSkel(
      "task",
      [
        task({ taskId: "root", title: "Work", workId: "root" }),
        task({ taskId: "a", parentTaskId: "root", workId: "root" }),
      ],
      [],
      [],
      [],
      [],
    );
    // 已按工作聚簇的 task 不计入独立任务
    expect(partition.noWorkCount).toBe(0);

    const withOrphan = partitionForSkel(
      "task",
      [
        task({ taskId: "root", title: "Work", workId: "root" }),
        task({ taskId: "a", parentTaskId: "root", workId: "root" }),
        task({ taskId: "orphan", parentTaskId: "ghost" }),
      ],
      [],
      [],
      [],
      [],
    );
    // 只有真正落入独立任务块的 orphan task 计入
    expect(withOrphan.noWorkCount).toBe(1);
  });

  it("hides facts when their host task is archived/hidden without degrading to the standalone block", () => {
    const relations: RelationEdge[] = [
      { from: "task/task_archived", to: "fact/F-arch", kind: "produces", provenance: "local-document" },
      { from: "task/task_active", to: "fact/F-act", kind: "produces", provenance: "local-document" },
    ];
    const allTaskIds = new Set(["task_archived", "task_active"]);
    const visibleTaskIds = new Set(["task_active"]); // task_archived 被归档过滤隐藏

    // 宿主被隐藏时, fact 随宿主一起隐藏
    expect(isFactVisibleWithHost("fact/F-arch", visibleTaskIds, allTaskIds, factHostTaskIds(relations))).toBe(false);
    // 宿主可见时, fact 保持可见
    expect(isFactVisibleWithHost("fact/F-act", visibleTaskIds, allTaskIds, factHostTaskIds(relations))).toBe(true);
  });

  it("groups a batch of facts without rescanning relations for each host", () => {
    let inspected = 0;
    const facts: FactRef[] = Array.from({ length: 100 }, (_, index) => ({
      anchor: `fact/F-${index}`,
      category: "finding",
      text: `Fact ${index}`,
      at: "2026-08-01",
    }));
    const relations: RelationEdge[] = facts.map((fact) => ({
      from: "task/host",
      to: fact.anchor,
      provenance: "local-document",
      get kind() {
        inspected += 1;
        return "produces" as const;
      },
    }));
    const zones = partitionFacts(facts, [], [task({ taskId: "host", workId: "work", workTitle: "Work" })], relations);
    expect(zones.map((zone) => [zone.groupId, zone.chips.length])).toEqual([["work", 100]]);
    expect(inspected).toBeLessThanOrEqual(relations.length * 2);
  });

  it("keeps the first task producer and retains facts whose host is absent", () => {
    const relations: RelationEdge[] = [
      { from: "decision/d", to: "fact/F-1", kind: "produces", provenance: "local-document" },
      { from: "task/first", to: "fact/F-1", kind: "produces", provenance: "local-document" },
      { from: "task/second", to: "fact/F-1", kind: "produces", provenance: "local-document" },
      { from: "task/missing", to: "fact/F-2", kind: "produces", provenance: "local-document" },
    ];
    const hosts = factHostTaskIds(relations),
      allTasks = new Set(["first", "second"]),
      visibleTasks = new Set(["second"]);
    expect(hosts.get("fact/F-1")).toBe("first");
    expect(isFactVisibleWithHost("F-1", visibleTasks, allTasks, hosts)).toBe(false);
    expect(isFactVisibleWithHost("fact/F-2", visibleTasks, allTasks, hosts)).toBe(true);
  });

  it("retains standalone facts without host task as visible and counts them in the standalone block", () => {
    const allTaskIds = new Set(["task_active"]);
    const visibleTaskIds = new Set(["task_active"]);
    // 无宿主 fact 保持可见
    expect(isFactVisibleWithHost("fact/F-standalone", visibleTaskIds, allTaskIds, new Map())).toBe(true);

    // 且在分区中计入独立任务块
    const standaloneFact: FactRef = {
      anchor: "fact/F-standalone",
      category: "finding",
      text: "Standalone fact",
      at: "2026-08-01",
      confidence: "high",
    };
    const partition = partitionForSkel(
      "unified",
      [task({ taskId: "root", title: "Work", workId: "root" })],
      [],
      [standaloneFact],
      [],
      [],
    );
    expect(partition.noWorkCount).toBe(1);
  });

  it("places fact in the same work groupId as its host task chip", () => {
    const hostTask = task({ taskId: "task_1", workId: "root_work", workTitle: "Work Root" });
    const workRoot = task({ taskId: "root_work", title: "Work Root", workId: "root_work" });
    const f = fact({ anchor: "fact/F-1", taskId: "task_1" });
    const relations: RelationEdge[] = [
      { from: "task/task_1", to: f.anchor, kind: "produces", provenance: "local-document" },
    ];
    const partition = partitionForSkel("unified", [workRoot, hostTask], [], [f], [anchor(f)], relations);

    const taskZone = partition.zones.find((z) => z.zoneId === "task:root_work");
    const factZone = partition.zones.find((z) => z.zoneId === "fact:root_work");
    expect(taskZone).toBeDefined();
    expect(factZone).toBeDefined();

    const taskChip = taskZone!.chips.find((c) => c.navRef === "task/task_1");
    const factChip = factZone!.chips.find((c) => c.navRef === f.anchor);
    expect(taskChip).toBeDefined();
    expect(factChip).toBeDefined();

    // fact 与宿主 task 落在同一工作键,fact 块标题是工作根的标题
    expect(factChip!.groupId).toBe(taskChip!.groupId);
    expect(factChip!.groupId).toBe("root_work");
    expect(factZone!.title).toBe("Work Root");
  });
});

describe("territory decision partition", () => {
  it("only decisions with no real relation belong in landing, including claim endpoints", () => {
    const decisions = ["task-bound", "fact-bound", "adr-bound", "alone"].map((decisionId) => dec({ decisionId }));
    const relations: RelationEdge[] = [
      { from: "decision/task-bound/CH1", to: "task/t", kind: "derives", provenance: "local-document" },
      { from: "decision/fact-bound/C1", to: "fact/F-1", kind: "evidenced-by", provenance: "local-document" },
      { from: "adr/a", to: "decision/adr-bound", kind: "relates", provenance: "local-document" },
    ];
    const { zones, landing } = partitionDecisions(decisions, relations);
    expect(landing.map((chip) => chip.navRef)).toEqual(["decision/alone"]);
    expect(
      zones
        .flatMap((zone) => zone.chips)
        .map((chip) => chip.navRef)
        .sort(),
    ).toEqual(["decision/adr-bound", "decision/fact-bound", "decision/task-bound"]);
  });
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
  it("groups facts by the host task's work, the standalone block when the host is absent", () => {
    const facts: FactRef[] = [
      { anchor: "fact/F-1", taskId: "task_a", category: "finding", text: "x", at: "2026-08-01", confidence: "high" },
      { anchor: "fact/F-2", taskId: "task_c", category: "finding", text: "y", at: "2026-08-01", confidence: "high" },
      { anchor: "fact/F-3", category: "finding", text: "z", at: "2026-08-01", confidence: "high" },
      { anchor: "fact/F-4", taskId: "gone", category: "finding", text: "w", at: "2026-08-01", confidence: "high" },
    ];
    const anchors: FactAnchorRow[] = [];
    const tasks = [
      task({ taskId: "task_a", title: "Work A", workId: "task_a", workTitle: "Work A" }),
      task({ taskId: "task_b", title: "Work B", workId: "task_b", workTitle: "Work B" }),
      task({ taskId: "task_c", title: "Child", parentTaskId: "task_b", workId: "task_b", workTitle: "Work B" }),
    ];
    const zones = partitionFacts(facts, anchors, tasks, [
      { from: "task/task_a", to: "fact/F-1", kind: "produces", provenance: "local-document" },
      { from: "task/task_c", to: "fact/F-2", kind: "produces", provenance: "local-document" },
      { from: "task/gone", to: "fact/F-4", kind: "produces", provenance: "local-document" },
    ]);
    expect(zones.map((zone) => [zone.title, zone.chips.map((chip) => chip.navRef)])).toEqual([
      ["Work A", ["fact/F-1"]],
      ["Work B", ["fact/F-2"]],
      [NO_WORK_TITLE, ["fact/F-3", "fact/F-4"]],
    ]);
    expect(zones.at(-1)!.groupId).toBe(NO_WORK);
  });

  it("marks invalidated facts in chip sub label", () => {
    const facts: FactRef[] = [
      {
        anchor: "fact/F-1",
        taskId: "task_a",
        category: "finding",
        text: "x",
        at: "2026-08-01",
        confidence: "high",
        invalidated: true,
      },
    ];
    const zones = partitionFacts(facts, [], [task()], []);
    expect(zones[0]!.chips[0]!.sub).toBe("已失效");
  });
});

describe("territory skeleton dispatch", () => {
  it("unified skel returns all entity zones", () => {
    const result = partitionForSkel("unified", [task()], [dec()], [], [], [], []);
    expect(result.zones.length).toBeGreaterThanOrEqual(1);
  });

  it("task skel returns only task zones", () => {
    const result = partitionForSkel("task", [task()], [dec()], [], [], [], []);
    expect(result.zones.every((z) => z.entity === "task")).toBe(true);
  });

  it("fact skel uses anomaly partition", () => {
    const f = fact({ anchor: "fact/F-orphan" });
    const result = partitionForSkel("fact", [task()], [], [f], [anchor(f)], [], []);
    // Orphan fact → should have an anomaly zone.
    expect(result.zones.some((z) => z.zoneId.includes("anomaly:orphan"))).toBe(true);
  });
});

describe("fact anomaly classification (TERRITORY-001)", () => {
  it("classifies a fact targeted by refuted-by as contradictory", () => {
    const f = fact({ anchor: "fact/F-contr" });
    const relations: RelationEdge[] = [
      { from: "decision/dec_1", to: f.anchor, kind: "refuted-by", state: "active", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(f.anchor, f, relations, new Set())).toBe("contradictory");
  });

  it("does not classify a fact as contradictory from a retired or deleted refuted-by edge", () => {
    // retired/deleted 边在管道收口处出局,到达 territory 的模型边全部是当前关系;
    // 这里复刻收口后的空输入,断言不再有 contradictory 分类。
    const f = fact({ anchor: "fact/F-contr" });
    const covered = new Set([f.anchor]);
    expect(classifyFactAnomaly(f.anchor, f, [], covered)).toBe("normal");
  });

  it("classifies a fact with invalidated flag as contradictory", () => {
    const f = fact({ anchor: "fact/F-inval", invalidated: true });
    expect(classifyFactAnomaly(f.anchor, f, [], new Set())).toBe("contradictory");
  });

  it("classifies a fact targeted by supersedes-fact as superseded", () => {
    const f = fact({ anchor: "fact/F-old" });
    const relations: RelationEdge[] = [
      { from: "fact/F-new", to: f.anchor, kind: "supersedes-fact", state: "active", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(f.anchor, f, relations, new Set())).toBe("superseded");
  });

  it("does not classify a fact as superseded when the supersedes-fact edge is retired or deleted", () => {
    // Kernel criterion (packages/kernel/src/domain/fact-liveness.ts): only an
    // ACTIVE incoming supersedes-fact edge retires the fact; retired/deleted 边在
    // 管道收口处出局,到达这里的模型边全部是当前关系。
    const f = fact({ anchor: "fact/F-old" });
    const covered = new Set([f.anchor]);
    expect(classifyFactAnomaly(f.anchor, f, [], covered)).toBe("normal");
  });

  it("classifies a low-confidence fact as low-confidence", () => {
    const f = fact({ anchor: "fact/F-low", confidence: "low" });
    expect(classifyFactAnomaly(f.anchor, f, [], new Set())).toBe("low-confidence");
  });

  it("classifies a fact with no coverage or evidence as orphan", () => {
    const f = fact({ anchor: "fact/F-orphan" });
    expect(classifyFactAnomaly(f.anchor, f, [], new Set())).toBe("orphan");
  });

  it("classifies a covered fact with evidence as normal", () => {
    const f = fact({ anchor: "fact/F-ok" });
    const relations: RelationEdge[] = [
      { from: "decision/dec_1/CH1", to: f.anchor, kind: "evidenced-by", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(f.anchor, f, relations, new Set())).toBe("normal");
  });

  it("classifies a fact with a host task produces relation as normal", () => {
    const f = fact({ anchor: "fact/F-produced" });
    const relations: RelationEdge[] = [
      { from: "task/task_1", to: f.anchor, kind: "produces", provenance: "local-document" },
    ];
    expect(classifyFactAnomaly(f.anchor, f, relations, new Set())).toBe("normal");
  });
});

describe("fact anomaly partition (partitionFactsByAnomaly)", () => {
  it("creates separate zones for contradictory, orphan, low-confidence, superseded", () => {
    const fContr = fact({ anchor: "fact/F-contr", invalidated: true });
    const fOrphan = fact({ anchor: "fact/F-orphan" });
    const fLow = fact({ anchor: "fact/F-low", confidence: "low" });
    const fSuper = fact({ anchor: "fact/F-old" });
    const fOk = fact({ anchor: "fact/F-ok" });
    const relations: RelationEdge[] = [
      { from: "fact/F-new", to: "fact/F-old", kind: "supersedes-fact", state: "active", provenance: "local-document" },
      { from: "decision/dec_1/CH1", to: "fact/F-ok", kind: "evidenced-by", provenance: "local-document" },
    ];
    const coverage: RelationCoverageRow[] = [];
    const zones = partitionFactsByAnomaly([fContr, fOrphan, fLow, fSuper, fOk], [], [task()], relations, coverage);
    const anomalyZones = zones.filter((z) => z.zoneId.includes("anomaly:"));
    expect(anomalyZones.length).toBe(4); // contradictory + orphan + low-confidence + superseded
    expect(anomalyZones.some((z) => z.title.includes("矛盾"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("悬空"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("低置信"))).toBe(true);
    expect(anomalyZones.some((z) => z.title.includes("被取代"))).toBe(true);
    // Normal facts get their own work-based zones.
    const normalZones = zones.filter((z) => z.zoneId.includes("fact:normal:"));
    expect(normalZones.length).toBeGreaterThanOrEqual(1);
  });

  it("orders anomaly zones before normal zones", () => {
    const fOrphan = fact({ anchor: "fact/F-orphan" });
    const fOk = fact({ anchor: "fact/F-ok" });
    const relations: RelationEdge[] = [
      { from: "decision/dec_1/CH1", to: "fact/F-ok", kind: "evidenced-by", provenance: "local-document" },
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
    task({ taskId: "t_active", title: "Active", coordinationStatus: "active" }),
    task({ taskId: "t_done", title: "Done", coordinationStatus: "done" }),
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
    filter.decisionStates.delete("outcome_retired");
    const decisions = [dec(), { ...dec(), decisionId: "dec_2", state: "outcome_retired" } as DecisionRow];
    const visible = decisions.filter((row) => decisionPassesStateFilter(row, filter));
    expect(visible.map((row) => row.decisionId)).toEqual(["dec_1"]);
  });
});

/**
 * 领地降噪(task_b92c5138):cancelled/archived task 默认不渲染,判定与看板共用
 * isTaskArchiveNoise。与实体状态筛选同一条行过滤路径,因此块/进度计数只数可见行
 * —— 不会出现「进度条记了已取消的一笔、屏幕上却没有这个 chip」的空账。
 */
describe("territory hides cancelled/archived tasks behind the board noise rule", () => {
  const rows = [
    task({ taskId: "t_active", title: "Active", coordinationStatus: "active" }),
    task({ taskId: "t_cancelled", title: "Cancelled", coordinationStatus: "cancelled" }),
    task({ taskId: "t_archived", title: "Archived", packageDisposition: "archived" }),
  ];
  // GraphView taskVisible 的降噪子句原样:开关只翻转这一个谓词。
  const visibleWithSwitch = (showArchived: boolean) => rows.filter((row) => showArchived || !isTaskArchiveNoise(row));

  it("drops noise rows from chips by default and the zone progress counts only visible rows", () => {
    const visible = visibleWithSwitch(false);
    expect(visible.map((row) => row.taskId)).toEqual(["t_active"]);
    const partition = partitionForSkel("task", visible, [], [], [], [], []);
    const chips = [...partition.zones.flatMap((zone) => zone.chips), ...partition.landing];
    expect(chips.map((chip) => chip.navRef)).toEqual(["task/t_active"]);
    // 进度/总数跟可见行走,不把已取消的行记进块的「N/total」。
    expect(partition.zones[0]!.progress?.total).toBe(1);
  });

  it("keeps the full set when the switch is on (显示已归档)", () => {
    const visible = visibleWithSwitch(true);
    const partition = partitionForSkel("task", visible, [], [], [], [], []);
    const chips = [...partition.zones.flatMap((zone) => zone.chips), ...partition.landing];
    expect(chips.map((chip) => chip.navRef).sort()).toEqual(["task/t_active", "task/t_archived", "task/t_cancelled"]);
  });
});
