// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  decisionSegmentOf,
  factConclusion,
  factDecisionLinks,
  LOOSE_FACT_GROUP,
  shortenShas,
  workFactGroups,
} from "../src/renderer/model/work-facts-digest.ts";
import type { DecisionRow, FactRef } from "../src/renderer/model/types.ts";

/**
 * 「决策与事实」收束的纯派生判据(业主 2026-09-30:253 条事实平铺没人能看):
 * 结论句截取、40 位 SHA 缩短、按任务分组的新旧排序、决策状态分段与
 * 事实 → 引用它的决策的连接。
 */

const fact = (anchor: string, patch: Partial<FactRef> = {}): FactRef => ({
  anchor,
  category: "finding",
  text: "门禁绿了。",
  at: "2026-09-30T08:00:00.000Z",
  confidence: "high",
  ...patch,
});

const decision = (decisionId: string, patch: Partial<DecisionRow> = {}): DecisionRow =>
  ({
    decisionId,
    title: `D ${decisionId}`,
    state: "proposed",
    question: "承重选择",
    chosen: [],
    rejected: [],
    claims: [],
    judgmentConsents: [],
    capabilities: {},
    claimsOpen: true,
    ...patch,
  }) as DecisionRow;

describe("factConclusion", () => {
  it("cuts at the first terminator and keeps the rest for the drawer", () => {
    expect(factConclusion("门禁绿了。At commit 3c6e7594 下复测三次。")).toBe("门禁绿了");
    expect(factConclusion("首句;分号即止。")).toBe("首句");
    expect(factConclusion("一行\n另一行")).toBe("一行");
    expect(factConclusion("  带空白  。后续")).toBe("带空白");
  });

  it("falls back to the whole statement when the first sentence is empty", () => {
    expect(factConclusion("。取证细节")).toBe("。取证细节");
  });
});

describe("shortenShas", () => {
  it("shortens 40-hex commit SHAs to 7 and leaves everything else alone", () => {
    const sha = "3c6e75936ad4a368edd8be89590ab12c3d4e5f60";
    expect(shortenShas(`At commit ${sha} the suite passed`)).toBe("At commit 3c6e759 the suite passed");
    expect(shortenShas("at base 7e2f225e on 2026-09-30")).toBe("at base 7e2f225e on 2026-09-30");
    expect(shortenShas("无哈希")).toBe("无哈希");
  });
});

describe("workFactGroups", () => {
  it("groups by owning task, orders groups and rows newest first, and titles from the index", () => {
    const groups = workFactGroups({
      facts: [
        fact("fact/F-1", { taskId: "task_old", at: "2026-09-01T00:00:00.000Z" }),
        fact("fact/F-2", { taskId: "task_new", at: "2026-09-30T09:00:00.000Z" }),
        fact("fact/F-3", { taskId: "task_new", at: "2026-09-30T10:00:00.000Z" }),
      ],
      titles: new Map([["task/task_new", "新任务"]]),
    });
    expect(groups.map(({ key }) => key)).toEqual(["task_new", "task_old"]);
    expect(groups[0]).toMatchObject({ title: "新任务", latestAt: "2026-09-30T10:00:00.000Z" });
    expect(groups[0]!.facts.map(({ anchor }) => anchor)).toEqual(["fact/F-3", "fact/F-2"]);
    // 标题查表没命中就如实给 null,由视图退回任务 id。
    expect(groups[1]!.title).toBeNull();
  });

  it("collects facts without an owning task into the related group", () => {
    const groups = workFactGroups({
      facts: [fact("fact/F-rel", { taskId: undefined })],
      titles: new Map(),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: LOOSE_FACT_GROUP, title: null });
  });
});

describe("decisionSegmentOf", () => {
  it("puts proposed first, in_effect second, and everything else into the collapsed segment", () => {
    expect(decisionSegmentOf("proposed")).toBe("pending");
    expect(decisionSegmentOf("in_effect")).toBe("inEffect");
    for (const state of ["superseded", "rejected", "deferred", "outcome_retired", "unknown"] as const)
      expect(decisionSegmentOf(state)).toBe("retired");
  });
});

describe("factDecisionLinks", () => {
  it("joins decision claim edges to fact anchors with in-scope decision titles only", () => {
    const links = factDecisionLinks({
      relations: [
        {
          relationId: "rel-1",
          from: "decision/dec_a/C1",
          to: "fact/F-1",
          kind: "evidenced-by",
          provenance: "local-document",
        },
        {
          relationId: "rel-2",
          from: "decision/dec_b",
          to: "fact/F-1",
          kind: "evidenced-by",
          provenance: "local-document",
        },
        {
          relationId: "rel-3",
          from: "decision/dec_missing",
          to: "fact/F-9",
          kind: "evidenced-by",
          provenance: "local-document",
        },
        {
          relationId: "rel-4",
          from: "task/task_x",
          to: "fact/F-1",
          kind: "produces",
          provenance: "local-document",
        },
      ],
      decisions: [decision("dec_a")],
    });
    // 同一 decision 的 claim 边与整实体边只列一次;投影外的 decision 不补造标题。
    expect(links.get("fact/F-1")).toEqual([{ decisionId: "dec_a", title: "D dec_a" }]);
    expect(links.has("fact/F-9")).toBe(false);
  });
});
