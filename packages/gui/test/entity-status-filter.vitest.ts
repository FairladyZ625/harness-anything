import { describe, expect, it } from "vitest";
import { BOARD_COLUMNS, type DecisionState, type SnapshotStatus } from "../src/renderer/model/types.ts";
import {
  DECISION_STATE_FILTER_OPTIONS,
  OTHER_STATUS_BUCKET,
  TASK_STATUS_FILTER_OPTIONS,
  decisionPassesStateFilter,
  defaultEntityStatusFilter,
  edgeEndpointsVisible,
  isEntityStatusFilterNarrowed,
  nodePassesEntityStatusFilter,
  normalizeDecisionStateKey,
  normalizeTaskStatusKey,
  taskPassesStatusFilter,
  taskStatusOffCount,
  decisionStateOffCount,
  computeStatusVisibleNodeIds,
  type EntityStatusFilterState,
} from "../src/renderer/graph/entityStatusFilter.ts";
import {
  defaultKindFilter,
  edgePassesKindFilter,
} from "../src/renderer/graph/relationVisual.ts";
import type { RelationKind } from "../src/renderer/model/types.ts";

describe("entityStatusFilter vocabulary sources", () => {
  it("task status options come from BOARD_COLUMNS (same as TaskFilterBar)", () => {
    expect(TASK_STATUS_FILTER_OPTIONS).toEqual(BOARD_COLUMNS);
    // 列表侧既有词表:planned/active/blocked/in_review/done/cancelled/unknown
    expect(TASK_STATUS_FILTER_OPTIONS).toContain("planned");
    expect(TASK_STATUS_FILTER_OPTIONS).toContain("active");
    expect(TASK_STATUS_FILTER_OPTIONS).toContain("in_review");
    expect(TASK_STATUS_FILTER_OPTIONS).toContain("done");
  });

  it("decision state options cover DecisionState union literals", () => {
    const expected: DecisionState[] = [
      "proposed",
      "active",
      "deferred",
      "rejected",
      "retired",
    ];
    for (const s of expected) {
      expect(DECISION_STATE_FILTER_OPTIONS).toContain(s);
    }
    expect(DECISION_STATE_FILTER_OPTIONS).toHaveLength(expected.length);
  });

  it("default filter is fully selected (no narrowing)", () => {
    const d = defaultEntityStatusFilter();
    expect(isEntityStatusFilterNarrowed(d)).toBe(false);
    expect(taskStatusOffCount(d)).toBe(0);
    expect(decisionStateOffCount(d)).toBe(0);
    // includes OTHER bucket
    expect(d.taskStatuses.has(OTHER_STATUS_BUCKET)).toBe(true);
    expect(d.decisionStates.has(OTHER_STATUS_BUCKET)).toBe(true);
  });
});

describe("normalize unknown status → other bucket", () => {
  it("maps known SnapshotStatus through unchanged", () => {
    for (const s of BOARD_COLUMNS) {
      expect(normalizeTaskStatusKey(s)).toBe(s);
    }
  });

  it("maps unknown / empty / null task status to OTHER", () => {
    expect(normalizeTaskStatusKey("weird-status")).toBe(OTHER_STATUS_BUCKET);
    expect(normalizeTaskStatusKey("")).toBe(OTHER_STATUS_BUCKET);
    expect(normalizeTaskStatusKey(undefined)).toBe(OTHER_STATUS_BUCKET);
    expect(normalizeTaskStatusKey(null)).toBe(OTHER_STATUS_BUCKET);
  });

  it("maps known DecisionState through unchanged", () => {
    for (const s of DECISION_STATE_FILTER_OPTIONS) {
      expect(normalizeDecisionStateKey(s)).toBe(s);
    }
  });

  it("maps unknown decision state to OTHER without throwing", () => {
    expect(normalizeDecisionStateKey("accepted")).toBe(OTHER_STATUS_BUCKET);
    expect(normalizeDecisionStateKey("draft")).toBe(OTHER_STATUS_BUCKET);
    expect(normalizeDecisionStateKey(undefined)).toBe(OTHER_STATUS_BUCKET);
  });
});

describe("nodePassesEntityStatusFilter semantics", () => {
  const onlyActive: EntityStatusFilterState = {
    taskStatuses: new Set(["active"]),
    decisionStates: new Set(["active"]),
  };

  const onlyPlannedTask: EntityStatusFilterState = {
    taskStatuses: new Set(["planned"]),
    decisionStates: defaultEntityStatusFilter().decisionStates,
  };

  it("filters tasks by coordinationStatus", () => {
    expect(
      taskPassesStatusFilter({ coordinationStatus: "active" }, onlyActive),
    ).toBe(true);
    expect(
      taskPassesStatusFilter({ coordinationStatus: "planned" }, onlyActive),
    ).toBe(false);
    expect(
      taskPassesStatusFilter({ coordinationStatus: "planned" }, onlyPlannedTask),
    ).toBe(true);
    expect(
      taskPassesStatusFilter({ coordinationStatus: "done" }, onlyPlannedTask),
    ).toBe(false);
  });

  it("filters decisions by state", () => {
    expect(decisionPassesStateFilter({ state: "active" }, onlyActive)).toBe(true);
    expect(decisionPassesStateFilter({ state: "proposed" }, onlyActive)).toBe(false);
  });

  it("facts always pass (status filter is Task/Decision only)", () => {
    expect(nodePassesEntityStatusFilter("fact", {}, onlyActive)).toBe(true);
    expect(nodePassesEntityStatusFilter("fact", null, onlyActive)).toBe(true);
  });

  it("unknown status lands in OTHER bucket", () => {
    const onlyOther: EntityStatusFilterState = {
      taskStatuses: new Set([OTHER_STATUS_BUCKET]),
      decisionStates: new Set([OTHER_STATUS_BUCKET]),
    };
    expect(
      taskPassesStatusFilter(
        { coordinationStatus: "weird" as SnapshotStatus },
        onlyOther,
      ),
    ).toBe(true);
    expect(
      taskPassesStatusFilter({ coordinationStatus: "active" }, onlyOther),
    ).toBe(false);
    expect(
      decisionPassesStateFilter({ state: "ghost" as DecisionState }, onlyOther),
    ).toBe(true);
    // other bucket closed → unknown rejected, not crash
    const noOther: EntityStatusFilterState = {
      taskStatuses: new Set(["active"]),
      decisionStates: new Set(["active"]),
    };
    expect(
      taskPassesStatusFilter(
        { coordinationStatus: "ghost" as SnapshotStatus },
        noOther,
      ),
    ).toBe(false);
  });

  it("default full selection passes every known + unknown status", () => {
    const all = defaultEntityStatusFilter();
    for (const s of BOARD_COLUMNS) {
      expect(taskPassesStatusFilter({ coordinationStatus: s }, all)).toBe(true);
    }
    expect(
      taskPassesStatusFilter(
        { coordinationStatus: "totally-new" as SnapshotStatus },
        all,
      ),
    ).toBe(true);
    for (const s of DECISION_STATE_FILTER_OPTIONS) {
      expect(decisionPassesStateFilter({ state: s }, all)).toBe(true);
    }
  });
});

describe("kind ∩ status combination (intersection)", () => {
  /**
   * GraphView 边后处理语义:
   *   edge kept ⇔ edgePassesKindFilter(kind) ∧ both endpoints status-visible
   * 这里用纯函数复现组合,不挂 React。
   */
  function edgeSurvivesCombo(opts: {
    kind: RelationKind;
    kinds: ReadonlySet<string>;
    sourceId: string;
    targetId: string;
    visibleNodeIds: ReadonlySet<string>;
  }): boolean {
    if (!edgePassesKindFilter({ kind: opts.kind }, opts.kinds)) return false;
    return edgeEndpointsVisible(opts.sourceId, opts.targetId, opts.visibleNodeIds);
  }

  it("hides edge when kind filtered out even if both ends status-visible", () => {
    const kinds = new Set<RelationKind>(["derives"]);
    const vis = new Set(["task_a", "dec_b"]);
    expect(
      edgeSurvivesCombo({
        kind: "depends-on",
        kinds,
        sourceId: "task_a",
        targetId: "dec_b",
        visibleNodeIds: vis,
      }),
    ).toBe(false);
    expect(
      edgeSurvivesCombo({
        kind: "derives",
        kinds,
        sourceId: "task_a",
        targetId: "dec_b",
        visibleNodeIds: vis,
      }),
    ).toBe(true);
  });

  it("hides edge when one endpoint is status-filtered out even if kind open", () => {
    const kinds = defaultKindFilter();
    const vis = new Set(["task_a"]); // dec_b filtered by status
    expect(
      edgeSurvivesCombo({
        kind: "derives",
        kinds,
        sourceId: "task_a",
        targetId: "dec_b",
        visibleNodeIds: vis,
      }),
    ).toBe(false);
  });

  it("keeps edge only when kind ∩ status both pass", () => {
    const kinds = new Set<RelationKind>(["derives", "depends-on"]);
    const vis = new Set(["task_a", "dec_b", "task_c"]);
    expect(
      edgeSurvivesCombo({
        kind: "derives",
        kinds,
        sourceId: "task_a",
        targetId: "dec_b",
        visibleNodeIds: vis,
      }),
    ).toBe(true);
    // kind not selected
    expect(
      edgeSurvivesCombo({
        kind: "relates",
        kinds,
        sourceId: "task_a",
        targetId: "task_c",
        visibleNodeIds: vis,
      }),
    ).toBe(false);
    // endpoint missing
    expect(
      edgeSurvivesCombo({
        kind: "depends-on",
        kinds,
        sourceId: "task_a",
        targetId: "task_z",
        visibleNodeIds: vis,
      }),
    ).toBe(false);
  });

  it("empty kind set hides everything regardless of status", () => {
    const vis = new Set(["a", "b"]);
    expect(
      edgeSurvivesCombo({
        kind: "derives",
        kinds: new Set(),
        sourceId: "a",
        targetId: "b",
        visibleNodeIds: vis,
      }),
    ).toBe(false);
  });
});

describe("isEntityStatusFilterNarrowed", () => {
  it("detects partial task selection", () => {
    const f: EntityStatusFilterState = {
      taskStatuses: new Set(["active", "planned"]),
      decisionStates: defaultEntityStatusFilter().decisionStates,
    };
    expect(isEntityStatusFilterNarrowed(f)).toBe(true);
    expect(taskStatusOffCount(f)).toBeGreaterThan(0);
  });

  it("detects partial decision selection", () => {
    const f: EntityStatusFilterState = {
      taskStatuses: defaultEntityStatusFilter().taskStatuses,
      decisionStates: new Set(["active"]),
    };
    expect(isEntityStatusFilterNarrowed(f)).toBe(true);
    expect(decisionStateOffCount(f)).toBeGreaterThan(0);
  });
});

describe("computeStatusVisibleNodeIds", () => {
  it("returns null when filter is fully selected (no-op)", () => {
    const nodes = [
      {
        id: "t1",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "active" } },
      },
    ];
    expect(
      computeStatusVisibleNodeIds(nodes, defaultEntityStatusFilter(), ["t1"]),
    ).toBeNull();
  });

  it("hides non-matching task/decision and keeps focus + containers", () => {
    const onlyActive: EntityStatusFilterState = {
      taskStatuses: new Set(["active"]),
      decisionStates: new Set(["active"]),
    };
    const nodes = [
      {
        id: "t_active",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "active" } },
      },
      {
        id: "t_planned",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "planned" } },
      },
      {
        id: "d_active",
        type: "ego",
        data: { entity: "decision", raw: { state: "active" } },
      },
      {
        id: "d_proposed",
        type: "ego",
        data: { entity: "decision", raw: { state: "proposed" } },
      },
      {
        id: "f1",
        type: "ego",
        data: { entity: "fact", raw: {} },
      },
      { id: "zone1", type: "territoryZone", data: {} },
      {
        id: "focus_planned",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "planned" } },
      },
    ];
    const vis = computeStatusVisibleNodeIds(nodes, onlyActive, [
      "focus_planned",
    ]);
    expect(vis).not.toBeNull();
    expect(vis!.has("t_active")).toBe(true);
    expect(vis!.has("t_planned")).toBe(false);
    expect(vis!.has("d_active")).toBe(true);
    expect(vis!.has("d_proposed")).toBe(false);
    expect(vis!.has("f1")).toBe(true); // facts always pass
    expect(vis!.has("zone1")).toBe(true); // container
    expect(vis!.has("focus_planned")).toBe(true); // focus exempt
  });

  it("unknown status on node does not throw; maps via OTHER bucket", () => {
    const onlyOther: EntityStatusFilterState = {
      taskStatuses: new Set([OTHER_STATUS_BUCKET]),
      decisionStates: new Set([OTHER_STATUS_BUCKET]),
    };
    const nodes = [
      {
        id: "t_weird",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "legacy-foo" } },
      },
      {
        id: "t_active",
        type: "ego",
        data: { entity: "task", raw: { coordinationStatus: "active" } },
      },
    ];
    const vis = computeStatusVisibleNodeIds(nodes, onlyOther, []);
    expect(vis!.has("t_weird")).toBe(true);
    expect(vis!.has("t_active")).toBe(false);
  });
});

