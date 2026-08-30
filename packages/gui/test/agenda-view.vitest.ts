// harness-test-tier: contract
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgendaRead } from "../src/api/renderer-dto.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { AgendaView, agendaSegments } from "../src/renderer/views/AgendaView.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("zh-CN"));

const AT = "2026-08-30T00:00:00.000Z";
const blocking = { state: "clear" as const, blockers: [], warnings: [] };

const taskRow = (taskId: string, pinned: boolean, status: "active" | "planned" | "blocked") => ({
  taskId,
  title: `标题 ${taskId}`,
  status,
  pinned,
  updatedAt: AT,
  leaseExecutionId: pinned ? `execution-${taskId}` : null,
  activeExecutionIds: pinned ? [`execution-${taskId}`] : [],
  blockingAssessment: blocking,
});

/** 一页 `repo.agenda.read`:分组判据来自 daemon,这里只覆盖 GUI 的展示编排。 */
const agenda = (rows: Partial<AgendaRead> = {}): AgendaRead =>
  ({
    schema: "daemon.agenda/v1",
    ok: true,
    command: "agenda",
    status: "ready",
    inFlight: [taskRow("task_active_pin", true, "active")],
    awaitingDecision: [
      {
        kind: "decision",
        decisionId: "dec_01",
        title: "待裁决策",
        riskTier: "medium",
        urgency: "high",
        proposedAt: AT,
      },
      {
        kind: "execution",
        taskId: "task_review",
        title: "待复核",
        pinned: false,
        executionId: "execution_review",
        submittedAt: AT,
        blockingAssessment: blocking,
      },
    ],
    waitingOnOthers: [taskRow("task_wait", false, "blocked")],
    dispatchable: [taskRow("task_ready_pin", true, "planned"), taskRow("task_ready", false, "planned")],
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 12,
    sourceRevision: 12,
    warnings: [],
    summary: "在飞线 (1)",
    ...rows,
  }) as AgendaRead;

describe("agenda segments", () => {
  it("collects pinned tasks across groups and never duplicates a row into two sections", () => {
    const segments = agendaSegments(agenda());
    expect(segments.map((segment) => segment.id)).toEqual([
      "pinned",
      "inFlight",
      "awaitingDecision",
      "dispatchable",
      "waitingOnOthers",
    ]);
    const pinned = segments[0]!;
    expect(pinned.rows.map((row) => (row.kind === "task" ? row.row.taskId : ""))).toEqual([
      "task_active_pin",
      "task_ready_pin",
    ]);
    // pinned 行带来源段标签,其余任务段不再重复出现同一 task。
    expect(segments[1]!.rows).toHaveLength(0);
    expect(segments[3]!.rows.map((row) => (row.kind === "task" ? row.row.taskId : ""))).toEqual(["task_ready"]);
  });

  it("keeps awaiting rows (decisions and submitted executions) whole", () => {
    const rows = agendaSegments(agenda())[2]!.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.kind === "awaiting" ? rows[0]!.row.kind : "").toBe("decision");
    expect(rows[1]!.kind === "awaiting" ? rows[1]!.row.kind : "").toBe("execution");
  });
});

describe("agenda view", () => {
  const makeTask = (taskId: string, pinned: boolean, status: TaskRow["coordinationStatus"]): TaskRow => ({
    taskId,
    title: `标题 ${taskId}`,
    projectId: "p",
    coordinationStatus: status,
    rawStatus: status,
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "core",
    lastKnownAt: AT,
    gates: [],
    docs: [],
    ...(pinned ? { pinned: true } : {}),
  });
  const tasks: TaskRow[] = [
    makeTask("task_active_pin", true, "active"),
    makeTask("task_ready_pin", true, "planned"),
    makeTask("task_ready", false, "planned"),
    makeTask("task_wait", false, "blocked"),
  ];

  it("renders the four CEO sections plus the projection's waiting group", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: agenda(),
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
      }),
    );
    for (const label of ["今天在做", "在飞线", "待裁", "可派队列", "球在别人手里"]) expect(markup).toContain(label);
    // 行内直接给出 lease/execution 与 blocking,不需要点进详情。
    expect(markup).toContain("execution-task_active_pin");
    expect(markup).toContain("blocking=clear");
    expect(markup).toContain("task_active_pin");
    expect(markup).toContain("dec_01");
    expect(markup).toContain("execution_review");
  });

  it("shows the projection watermark and the catching-up state, not a fake total", () => {
    const ready = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: agenda(),
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
      }),
    );
    expect(ready).toContain("r12");
    expect(ready).toContain("已就绪");
    const pending = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: agenda({ status: "pending", page: { sourceLimit: 100, cursor: null, nextCursor: "next" } }),
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
      }),
    );
    expect(pending).toContain("正在追赶");
  });

  it("renders an explicit reading state before the first page lands", () => {
    const markup = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: undefined,
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
      }),
    );
    expect(markup).toContain("正在读取议程投影");
  });

  it("exposes the pin write affordance only when the write channel is wired", () => {
    const withPin = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: agenda(),
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
        onSetPin: () => undefined,
      }),
    );
    expect(withPin).toContain("agenda-pin-toggle-task_ready_pin");
    const withoutPin = renderToStaticMarkup(
      createElement(AgendaView, {
        agenda: agenda(),
        tasks,
        onSelect: () => undefined,
        onNavigateDecision: () => undefined,
      }),
    );
    expect(withoutPin).not.toContain("agenda-pin-toggle-");
    expect(withoutPin).toContain("agenda-pinned-marker");
  });
});

vi.mock("../src/renderer/model/time.ts", () => ({ formatTime: () => "08-30 00:00" }));
