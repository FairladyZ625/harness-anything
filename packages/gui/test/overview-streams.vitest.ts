// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { DecisionStream } from "../src/renderer/components/overview/DecisionStream.tsx";
import { TaskStream } from "../src/renderer/components/overview/TaskStream.tsx";
import { PinnedStream } from "../src/renderer/components/overview/PinnedStream.tsx";
import { RuntimeHealthCard } from "../src/renderer/components/overview/RuntimeHealthCard.tsx";
import { DecisionPreviewDrawer } from "../src/renderer/components/DecisionPreviewDrawer.tsx";
import { streamTime } from "../src/renderer/components/overview/streamParts.tsx";
import { localDateTime, localTime } from "../src/renderer/model/local-time.ts";
import type { WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";

function task(patch: Partial<TaskRow>): TaskRow {
  return {
    taskId: "task_a", title: "Task A", projectId: "proj",
    coordinationStatus: "active", rawStatus: "active", freshness: "fresh",
    packageDisposition: "active", closeoutReadiness: "not_required",
    engine: "local", source: "local-document", module: "kernel",
    createdAt: null, lastKnownAt: "2026-08-01T00:00:00.000Z", gates: [], docs: [],
    ...patch,
  };
}

function decision(patch: Partial<DecisionRow>): DecisionRow {
  return {
    decisionId: "dec_x", title: "D", state: "proposed", question: "Q",
    chosen: [], rejected: [], claims: [], judgmentConsents: [], body: null,
    ...patch,
  };
}

const noop = () => {};
const taskSummary = (patch: Partial<WorkspaceSummaryRead["tasks"]["byStatus"]> = {}): WorkspaceSummaryRead["tasks"] => {
  const byStatus = { planned: 0, active: 0, blocked: 0, in_review: 0, done: 0, cancelled: 0, unknown: 0, ...patch };
  return { total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
};
const decisionSummary = (patch: Partial<WorkspaceSummaryRead["decisions"]["byState"]> = {}): WorkspaceSummaryRead["decisions"] => {
  const byState = { proposed: 0, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0, ...patch };
  const ids = (state: string, count: number) => Array.from({ length: count }, (_, index) => `${state}_${index}`);
  const retiredIds = [...ids("superseded", byState.superseded), ...ids("outcome_retired", byState.outcome_retired)];
  return {
    total: Object.values(byState).reduce((sum, count) => sum + count, 0), inboxCount: byState.proposed, byState,
    groups: [
      { id: "proposed", states: ["proposed"], count: byState.proposed, decisionIds: ids("proposed", byState.proposed) },
      { id: "in_effect", states: ["in_effect"], count: byState.in_effect, decisionIds: ids("in_effect", byState.in_effect) },
      { id: "rejected", states: ["rejected"], count: byState.rejected, decisionIds: ids("rejected", byState.rejected) },
      { id: "deferred", states: ["deferred"], count: byState.deferred, decisionIds: ids("deferred", byState.deferred) },
      { id: "retired", states: ["superseded", "outcome_retired"], count: retiredIds.length, decisionIds: retiredIds }
    ]
  };
};

describe("overview decision stream", () => {
  it("renders only proposed decisions by default with state tabs carrying per-state counts", () => {
    const markup = renderToStaticMarkup(createElement(DecisionStream, {
      decisions: [
        decision({ decisionId: "dec_prop", title: "Proposed one", state: "proposed", riskTier: "high", urgency: "high", proposedAt: "2026-08-21T01:00:00.000Z" }),
        decision({ decisionId: "dec_effect", title: "Effect one", state: "in_effect" }),
      ],
      summary: decisionSummary({ proposed: 7, in_effect: 9 }),
      stateLabel: (state) => state,
      onOpenPreview: noop,
      onOpenInbox: noop,
    }));
    expect(markup).toContain("Proposed one");
    expect(markup).not.toContain("Effect one");
    expect(markup).toContain('data-testid="overview-decision-state-proposed"');
    expect(markup).toMatch(/proposed\s*7/);
    expect(markup).toMatch(/in_effect\s*9/);
    // 行式紧凑:每行一个 button,不再是大卡片。
    expect(markup).toContain('data-testid="decision-stream-rows"');
  });

  it("shows the empty state instead of a blank grid when the selected state has no rows", () => {
    const markup = renderToStaticMarkup(createElement(DecisionStream, {
      decisions: [decision({ decisionId: "dec_effect", state: "in_effect" })],
      summary: decisionSummary({ in_effect: 1 }),
      stateLabel: (state) => state,
      onOpenPreview: noop,
      onOpenInbox: noop,
    }));
    expect(markup).toContain("该状态下暂无决策");
  });
});

describe("overview task stream", () => {
  it("filters to the selected status in place with census counts on every tab (sidebar parity)", () => {
    const tasks = [
      task({ taskId: "task_a1", title: "Active one", coordinationStatus: "active" }),
      task({ taskId: "task_b1", title: "Blocked one", coordinationStatus: "blocked" }),
      task({ taskId: "task_b2", title: "Blocked two", coordinationStatus: "blocked" }),
    ];
    const markup = renderToStaticMarkup(createElement(TaskStream, { tasks, summary: taskSummary({ active: 4, blocked: 7 }), onOpenPreview: noop, onGoBoard: noop }));
    expect(markup).toContain("Active one");
    expect(markup).not.toContain("Blocked one");
    for (const status of ["planned", "active", "blocked", "in_review", "done", "cancelled"]) {
      expect(markup).toContain(`data-testid="overview-status-${status}"`);
    }
    expect(markup).toMatch(/已阻塞\s*7/);
  });

  it("renders newest tasks first inside the internally scrolling body", () => {
    const markup = renderToStaticMarkup(createElement(TaskStream, {
      tasks: [
        task({ taskId: "task_z_hash", title: "Older task", coordinationStatus: "active", createdAt: "2026-08-16T10:00:00.000Z" }),
        task({ taskId: "task_a_hash", title: "Newer task", coordinationStatus: "active", createdAt: "2026-08-18T09:30:00.000Z" }),
      ],
      summary: taskSummary({ active: 2 }),
      onOpenPreview: noop,
      onGoBoard: noop,
    }));
    expect(markup.indexOf("Newer task")).toBeLessThan(markup.indexOf("Older task"));
    expect(markup).toContain('data-testid="task-stream-rows"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("xl:flex-1"); expect(markup).toContain("xl:max-h-none");
  });

  it("converts UTC stream timestamps with the process local timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Asia/Taipei";
      expect(streamTime("2026-08-21T16:04:35.025Z")).toBe("08-22 00:04");
      expect(localDateTime("2026-08-21T16:04:35.025Z")).toBe("2026-08-22 00:04");
      expect(localDateTime("2026-08-21T16:04:35.025Z", true)).toBe("2026-08-22 00:04:35");
      expect(localTime("2026-08-21T16:04:35.025Z", true)).toBe("00:04:35");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("shows the per-status empty state", () => {
    const markup = renderToStaticMarkup(createElement(TaskStream, {
      tasks: [task({ taskId: "task_p", coordinationStatus: "planned" })],
      summary: taskSummary({ planned: 1 }),
      onOpenPreview: noop,
      onGoBoard: noop,
    }));
    expect(markup).toContain("该状态下暂无任务");
  });
});

describe("overview pinned stream", () => {
  it("lists only ledger-pinned tasks regardless of their coordination status", () => {
    const markup = renderToStaticMarkup(createElement(PinnedStream, {
      tasks: [
        task({ taskId: "task_pin_active", title: "Pinned active", pinned: true, coordinationStatus: "active" }),
        task({ taskId: "task_pin_blocked", title: "Pinned blocked", pinned: true, coordinationStatus: "blocked" }),
        task({ taskId: "task_plain", title: "Plain active", coordinationStatus: "active" }),
      ],
      onOpenPreview: noop,
    }));
    expect(markup).toContain("Pinned active");
    expect(markup).toContain("Pinned blocked");
    expect(markup).not.toContain("Plain active");
  });

  it("explains how to pin when nothing is pinned", () => {
    const markup = renderToStaticMarkup(createElement(PinnedStream, { tasks: [task({})], onOpenPreview: noop }));
    expect(markup).toContain("当前没有 pin 的任务");
    expect(markup).toContain("ha task pin");
  });
});

describe("overview runtime health card", () => {
  it("renders the worst lamp, four signal rows and the system exit", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeHealthCard, {
      health: {
        daemon: { state: "responsive", observedAgeSec: 5, uptimeMs: 3_600_000 },
        cell: { state: "attached", queueDepth: 0, problem: null },
        projection: { lag: 0, status: "ready" },
        ledgerChange: { at: "2026-08-21T11:00:00.000Z", ageSec: 3_600 },
      },
      onOpenSystem: noop,
    }));
    expect(markup).toContain('data-testid="runtime-health-card"');
    expect(markup).toContain("运行正常");
    expect(markup).toContain("台账服务");
    expect(markup).toContain("投影落后");
    expect(markup).toContain("最新台账变化");
    expect(markup).toContain("系统页");
  });

  it("renders down state without hiding rows", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeHealthCard, {
      health: {
        daemon: { state: "unresponsive", observedAgeSec: 900, uptimeMs: null },
        cell: { state: "unavailable", queueDepth: null, problem: "cell crashed" },
        projection: { lag: 12, status: "pending" },
        ledgerChange: { at: null, ageSec: null },
      },
      onOpenSystem: noop,
    }));
    expect(markup).toContain("不可用");
    expect(markup).toContain("无响应");
    expect(markup).toContain("cell crashed");
    expect(markup).toContain("12 revisions");
  });
});

describe("decision preview drawer (click opens a drawer, not a page jump)", () => {
  const sample = decision({
    decisionId: "dec_sample",
    title: "Sample decision",
    question: "Which projection feeds the overview?",
    riskTier: "high",
    urgency: "medium",
    chosen: [{ id: "c1", text: "Keep the triadic projection", rationale: "single source" }],
    rejected: [{ id: "r1", text: "Ad-hoc GUI aggregate", whyNot: "numbers would fight" }],
    claims: [{ id: "k1", text: "census stays single-sourced", loadBearing: true, fulfillment: null }],
    proposedBy: { kind: "agent", id: "z" },
  });

  it("renders nothing without a decision", () => {
    expect(renderToStaticMarkup(createElement(DecisionPreviewDrawer, {
      decision: null, tasks: [], relations: [], onClose: noop, onOpenDetail: noop,
    }))).toBe("");
  });

  it("carries the judgment-minimum fields plus an explicit open-details exit", () => {
    const markup = renderToStaticMarkup(createElement(DecisionPreviewDrawer, {
      decision: sample, tasks: [], relations: [], onClose: noop, onOpenDetail: noop,
    }));
    expect(markup).toContain("Which projection feeds the overview?");
    expect(markup).toContain("Keep the triadic projection");
    expect(markup).toContain("Ad-hoc GUI aggregate");
    expect(markup).toContain("census stays single-sourced");
    expect(markup).toContain("打开完整详情");
    // 与 TaskPreviewDrawer 同语汇:fixed 覆盖层 + Esc 可关。
    expect(markup).toContain("fixed inset-0");
  });
});
