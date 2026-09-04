// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScheduleDetailView, deriveScheduleRunRows } from "../src/renderer/views/ScheduleDetailView.tsx";
import { formatDurationMs } from "../src/renderer/components/scheduleRun/runMeta.ts";
import {
  scheduleReportIsJsonReceipt,
  ScheduleRunDetail,
} from "../src/renderer/components/scheduleRun/ScheduleRunDetail.tsx";
import { schedulesClient, type ScheduleRunsResult } from "../src/renderer/schedules-client.ts";
import type { ScheduleGuiRowDto, SchedulesListResult } from "../../daemon/src/protocol/schedules-gui-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

const noop = () => undefined;

function row(overrides: Partial<ScheduleGuiRowDto> = {}): ScheduleGuiRowDto {
  return {
    scheduleId: "heartbeat-probe",
    name: "Heartbeat probe",
    state: "armed",
    mode: "detect",
    definitionResidency: "ledger",
    definitionRevision: 7,
    trigger: { kind: "interval", everyMs: 7_200_000, timezone: null, summary: "every 2h" },
    target: {
      kind: "agent",
      agentId: "probe-agent",
      runtimeInstanceId: "codex-schedule",
      model: "gpt-5.6",
      reasoningEffort: "high",
      cwd: null,
    },
    mission: "Keep the end-to-end mainline green.",
    executionAvailability: "claimed-elsewhere",
    claim: { nodeId: "edge-two", assignmentId: "assignment-edge-two" },
    health: {
      recent: ["succeeded", "failed"],
      bucket: "degraded",
      failedCount: 1,
      lastFailureDetail: "cwd /missing does not exist",
    },
    nextRunAt: "2026-08-27T10:25:00.000Z",
    actions: {
      edit: { available: true, code: null, nextAction: null },
      delete: { available: true, code: null, nextAction: null },
      enable: { available: false, code: "no_changes", nextAction: "The Schedule is already armed." },
      disable: { available: true, code: null, nextAction: null },
      runNow: {
        available: false,
        code: "schedule_single_flight_active",
        nextAction: "Occurrence occurrence_now is already claimed by node edge-two.",
      },
    },
    activeRun: {
      occurrenceId: "occurrence_now",
      kind: "scheduled",
      scheduledFor: "2026-08-27T08:00:00.000Z",
      claimedAt: "2026-08-27T08:00:01.000Z",
      nodeId: "edge-two",
      assignmentId: "assignment-edge-two",
      attemptIndex: 1,
      dispatchId: "dispatch_000000000000000000000002",
      runtimeSessionId: "runtime-active",
    },
    lastRun: {
      occurrenceId: "occurrence_prior",
      scheduledFor: "2026-08-27T06:00:00.000Z",
      endedAt: "2026-08-27T06:04:12.000Z",
      outcome: "failed",
      nodeId: "local",
      assignmentId: null,
      attemptIndex: 0,
      dispatchId: "dispatch_000000000000000000000001",
      runtimeSessionId: "runtime-prior",
      detail: "artifact:runtime-result/sha256/prior",
    },
    missed: { count: 1, lastMissedAt: "2026-08-27T04:00:00.000Z", lastMissedReason: "scheduler_unavailable" },
    automaticEvaluatedThrough: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
    ...overrides,
  };
}

function listResult(
  overrides: Partial<SchedulesListResult> = {},
  rowOverrides: Partial<ScheduleGuiRowDto> = {},
): SchedulesListResult {
  return {
    ok: true,
    status: "ready",
    repoId: "repo-a",
    repoMode: "local",
    viewerNodeId: "local",
    actions: { create: { available: true, code: null, nextAction: null } },
    options: {
      agents: [{ agentId: "probe-agent", name: "Probe Agent", runtimeType: "codex" }],
      instances: [
        {
          instanceId: "codex-schedule",
          name: "Schedule Codex",
          kindId: "codex",
          models: ["gpt-5.6", "gpt-5.6-sol"],
          efforts: ["low", "medium", "high", "xhigh"],
        },
      ],
      cwd: [".", "packages/gui"],
    },
    schedules: [row(rowOverrides)],
    watermark: 12,
    sourceRevision: 12,
    ...overrides,
  };
}

function runsResult(runs: ScheduleRunsResult["runs"]): ScheduleRunsResult {
  return {
    ok: true,
    status: "ready",
    scheduleId: "heartbeat-probe",
    runs,
    totals: {
      runs: runs.length,
      missed: runs.filter((candidate) => candidate.outcome === "missed").length,
      failed: runs.filter((candidate) => candidate.outcome === "failed").length,
    },
    truncated: false,
    watermark: 3,
    sourceRevision: 3,
  };
}

const occurrence = (
  overrides: Partial<ScheduleRunsResult["runs"][number]> = {},
): ScheduleRunsResult["runs"][number] => ({
  occurrenceId: "occurrence_86b0",
  kind: "scheduled",
  scheduledFor: "2026-08-27T08:25:00.000Z",
  claimedAt: "2026-08-27T08:25:01.000Z",
  endedAt: "2026-08-27T08:31:03.000Z",
  durationMs: 362_000,
  nodeId: "edge-sf-2",
  attemptIndex: 1,
  dispatchId: "dispatch_000000000000000000000009",
  runtimeSessionId: "runtime-86b0",
  outcome: "succeeded",
  missedReason: null,
  reportRef: "artifact:runtime-result/sha256/86b0",
  reportText: "# Probe report\n\nAll six steps completed.\n",
  detail: null,
  outputs: { facts: ["F-86B0"], decisions: ["dec_86b0"], tasks: [] },
  ...overrides,
});

async function renderDetail(
  focusedEntityRef: string | null,
  data = listResult(),
  onSelectEntity: (ref: string) => void = noop,
  handlers: { readonly onExitRun?: () => void; readonly onExit?: () => void } = {},
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const theRow = data.schedules[0] as ScheduleGuiRowDto;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(ScheduleDetailView, {
          repoId: "repo-a",
          row: theRow,
          options: data.options,
          scheduleIds: data.schedules.map((candidate) => candidate.scheduleId),
          focusedEntityRef,
          busy: false,
          receipt: null,
          actionError: null,
          onAction: noop,
          onSave: noop,
          onDelete: noop,
          onSelectEntity,
          onExitRun: handlers.onExitRun ?? noop,
          onExit: handlers.onExit ?? noop,
        }),
      ),
    );
  });
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  await act(async () => button.click());
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("schedule detail hub (M2)", () => {
  it("renders Overview from the list row: mission, mode badge, daemon health rollup, agent link stays a G10 path", async () => {
    const onSelectEntity = vi.fn();
    const container = await renderDetail("schedule/heartbeat-probe", listResult(), onSelectEntity);
    const text = container.textContent ?? "";
    expect(text).toContain("Heartbeat probe");
    expect(text).toContain("Keep the end-to-end mainline green.");
    expect(text).toContain("Detect");
    expect(text).toContain("Claimed elsewhere");
    expect(text).toContain("edge-two");
    // 健康度 rollup 是 daemon 事实:spark + 失败计数 + 最近失败原因直接渲染,无占位。
    expect(container.querySelector('[data-testid="schedule-health-spark"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-health-spark"]')?.children).toHaveLength(2);
    expect(container.querySelector('[data-testid="schedule-overview-health"]')?.textContent).toContain("1 failed");
    expect(container.querySelector('[data-testid="schedule-health-last-failure"]')?.textContent).toContain(
      "cwd /missing does not exist",
    );
    // G10: the agent id is still a path to the agent entity.
    container.querySelector<HTMLButtonElement>('[data-testid="schedule-agent-link-probe-agent"]')?.click();
    expect(onSelectEntity).toHaveBeenCalledWith("agent/probe-agent");
  });

  it("falls back to the occurrences the list row carries when the runs read fails, labeled as an error", async () => {
    vi.spyOn(schedulesClient, "runs").mockRejectedValue(new Error("bridge unavailable"));
    const container = await renderDetail("schedule/heartbeat-probe");
    await click(container, "schedule-tab-runs");
    await settle();
    const timeline = container.querySelector('[data-testid="schedule-runs-timeline"]');
    expect(timeline).not.toBeNull();
    // A failed read is a real error, not a pending-backend notice.
    const banner = container.querySelector('[data-testid="schedule-runs-read-error"]');
    expect(banner?.textContent).toContain("Run history read failed");
    expect(banner?.textContent).toContain("bridge unavailable");
    expect(container.querySelector('[data-testid="schedule-run-row-occurrence_now"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-run-row-occurrence_prior"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-run-row-aggregate"]')?.textContent).toContain("missed");
  });

  it("renders daemon-projected occurrence rows in daemon order, missed rows visible", async () => {
    vi.spyOn(schedulesClient, "runs").mockResolvedValue(
      runsResult([
        occurrence({ occurrenceId: "occurrence_3f9c", outcome: "running", endedAt: null, durationMs: null }),
        occurrence({
          occurrenceId: "occurrence_5a22",
          outcome: "missed",
          missedReason: "scheduler_unavailable",
          nodeId: null,
          dispatchId: null,
          runtimeSessionId: null,
          reportRef: null,
          reportText: null,
          detail: null,
          claimedAt: null,
          endedAt: null,
          durationMs: null,
          attemptIndex: null,
          outputs: { facts: [], decisions: [], tasks: [] },
        }),
        occurrence({
          occurrenceId: "occurrence_71d0",
          outcome: "succeeded",
          kind: "manual",
          reportRef: null,
          reportText: null,
        }),
      ]),
    );
    const container = await renderDetail("schedule/heartbeat-probe");
    await click(container, "schedule-tab-runs");
    await settle();
    const rows = [...container.querySelectorAll("li[data-testid^='schedule-run-row-']")];
    expect(rows.map((element) => element.getAttribute("data-testid"))).toEqual([
      "schedule-run-row-occurrence_3f9c",
      "schedule-run-row-occurrence_5a22",
      "schedule-run-row-occurrence_71d0",
    ]);
    const missedRow = container.querySelector('[data-testid="schedule-run-row-occurrence_5a22"]');
    expect(missedRow?.textContent).toContain("Missed");
    expect(missedRow?.textContent).toContain("not executed");
    expect(missedRow?.textContent).toContain("Scheduler unavailable");
    // No read-error banner when the projection answers.
    expect(container.querySelector('[data-testid="schedule-runs-read-error"]')).toBeNull();
  });
});

describe("embedded run detail (M4)", () => {
  it("opens a run row into schedule/<id>/runs/<occurrence> — never a session/ jump", async () => {
    const onSelectEntity = vi.fn();
    const container = await renderDetail("schedule/heartbeat-probe", listResult(), onSelectEntity);
    await click(container, "schedule-tab-runs");
    await settle();
    await click(container, "schedule-run-open-occurrence_now");
    // The run opens inside the schedule hub; the retired session/<id> jump is gone.
    expect(onSelectEntity).toHaveBeenCalledWith("schedule/heartbeat-probe/runs/occurrence_now");
    expect(onSelectEntity).not.toHaveBeenCalledWith(expect.stringMatching(/^session\//u));
  });

  it("returns from an embedded run to the hub's Runs tab via the location patch", async () => {
    const onExitRun = vi.fn();
    const onExit = vi.fn();
    const container = await renderDetail("schedule/heartbeat-probe/runs/occurrence_now", listResult(), noop, {
      onExitRun,
      onExit,
    });
    await settle();
    // A deep link straight into the run renders the run detail, not the hub tabs.
    expect(container.querySelector('[data-testid="schedule-run-detail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-detail-tabs"]')).toBeNull();
    await click(container, "schedule-detail-back");
    expect(onExitRun).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("embeds the report markdown, links dispatch/session and outputs, and shows failure detail", async () => {
    const onSelectEntity = vi.fn();
    vi.spyOn(schedulesClient, "runs").mockResolvedValue(
      runsResult([
        occurrence({
          outcome: "failed",
          reportText: "# Probe report\n\nFailed at step `sessions`.\n",
          detail: "renderer_console_error: Content Security Policy",
          outputs: { facts: ["F-86B0"], decisions: ["dec_86b0"], tasks: ["task_86b0"] },
        }),
      ]),
    );
    const container = await renderDetail("schedule/heartbeat-probe/runs/occurrence_86b0", listResult(), onSelectEntity);
    await settle();
    const detail = container.querySelector('[data-testid="schedule-run-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain("occurrence_86b0");
    // The transcript is embedded (dispatch ledger replay container), not a link out.
    expect(container.querySelector('[data-testid="schedule-run-session-occurrence_86b0"]')).not.toBeNull();
    // Failure detail is the daemon settle reason, shown in full.
    expect(container.querySelector('[data-testid="schedule-run-failure-detail"]')?.textContent).toContain(
      "renderer_console_error",
    );
    // The report renders inline through the artifacts-page markdown reader.
    const report = container.querySelector('[data-testid="schedule-run-report"]');
    expect(report).not.toBeNull();
    expect(report?.querySelector('[data-testid="doc-reader"]')).not.toBeNull();
    expect(report?.textContent).toContain("Probe report");
    // Dispatch + runtime session are entities: both route to the sessions view.
    await click(container, "schedule-run-dispatch-link");
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-86b0");
    await click(container, "schedule-run-session-link");
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-86b0");
    // Outputs are entities too: each routes through the entity navigator.
    await click(container, "schedule-run-output-fact-F-86B0");
    expect(onSelectEntity).toHaveBeenCalledWith("fact/F-86B0");
    await click(container, "schedule-run-output-decision-dec_86b0");
    expect(onSelectEntity).toHaveBeenCalledWith("decision/dec_86b0");
    await click(container, "schedule-run-output-task-task_86b0");
    expect(onSelectEntity).toHaveBeenCalledWith("task/task_86b0");
    // No placeholder sentences anywhere on the page.
    const text = detail?.textContent ?? "";
    expect(text).not.toMatch(/pending the backend|projection is pending|once wired|待后端|接线后/u);
  });

  it("renders a JSON receipt as a collapsed, untruncated code block", async () => {
    const receipt = `${JSON.stringify(
      {
        schema: "e2e-probe-journey/v1",
        outcome: "failed",
        failedStep: "sessions",
        message: "sessions-view did not render",
        screenshotPath: "/tmp/gui-e2e/failure.png",
        consoleFailures: [],
      },
      null,
      2,
    )}\n`;
    expect(scheduleReportIsJsonReceipt("# a report")).toBe(false);
    expect(scheduleReportIsJsonReceipt(receipt)).toBe(true);
    vi.spyOn(schedulesClient, "runs").mockResolvedValue(
      runsResult([occurrence({ reportText: receipt, detail: "probe failed" })]),
    );
    const container = await renderDetail("schedule/heartbeat-probe/runs/occurrence_86b0");
    await settle();
    const block = container.querySelector('[data-testid="schedule-run-report-json"]');
    expect(block).not.toBeNull();
    expect(block?.textContent).toContain("e2e-probe-journey/v1");
    expect(block?.textContent).toContain("screenshotPath");
    expect(block?.textContent).toContain("/tmp/gui-e2e/failure.png");
    // Markdown reader is not used for a JSON receipt.
    expect(container.querySelector('[data-testid="schedule-run-report"] [data-testid="doc-reader"]')).toBeNull();
  });

  it("renders real empty states when a failed occurrence has no dispatch, report, or outputs", async () => {
    vi.spyOn(schedulesClient, "runs").mockResolvedValue(
      runsResult([
        occurrence({
          outcome: "failed",
          dispatchId: null,
          runtimeSessionId: null,
          reportRef: null,
          reportText: null,
          detail: "Runtime instance gui-e2e-instance is not configured.",
          outputs: { facts: [], decisions: [], tasks: [] },
        }),
      ]),
    );
    const container = await renderDetail("schedule/heartbeat-probe/runs/occurrence_86b0");
    await settle();
    expect(container.querySelector('[data-testid="schedule-run-session-empty"]')?.textContent).toContain(
      "No dispatch for this occurrence",
    );
    expect(container.querySelector('[data-testid="schedule-run-report-empty"]')?.textContent).toContain("No report");
    expect(container.querySelector('[data-testid="schedule-run-outputs-empty"]')?.textContent).toContain(
      "produced no facts / decisions / tasks",
    );
    expect(container.querySelector('[data-testid="schedule-run-failure-detail"]')?.textContent).toContain(
      "not configured",
    );
    // No dispatch link when the occurrence never linked one.
    expect(container.querySelector('[data-testid="schedule-run-dispatch-link"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-run-session-link"]')).toBeNull();
  });

  it("renders the run detail body directly (component contract)", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ScheduleRunDetail, {
            repoId: "repo-a",
            row: row(),
            occurrence: occurrence(),
            onRefetchRuns: noop,
            onSelectEntity: noop,
          }),
        ),
      );
    });
    mounted.push({ root, container });
    expect(container.querySelector('[data-testid="schedule-run-detail"]')).not.toBeNull();
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });
});

describe("run-row derivation helpers", () => {
  it("derives only the occurrences the list read already carries", () => {
    const derived = deriveScheduleRunRows(row());
    expect(derived.map((candidate) => candidate.occurrenceId)).toEqual(["occurrence_now", "occurrence_prior", ""]);
    expect(derived[0]?.outcome).toBe("running");
    expect(derived[1]?.outcome).toBe("failed");
    expect(derived[2]?.outcome).toBe("missed");
    // lastRun duration is arithmetic over two daemon timestamps.
    expect(derived[1]?.durationMs).toBe(252_000);
    // Derived rows carry the empty daemon projections, not undefined fields.
    expect(derived[1]?.reportText).toBeNull();
    expect(derived[1]?.outputs).toEqual({ facts: [], decisions: [], tasks: [] });
    expect(
      deriveScheduleRunRows(
        row({ activeRun: null, missed: { count: 0, lastMissedAt: null, lastMissedReason: null } }),
      ).map((candidate) => candidate.occurrenceId),
    ).toEqual(["occurrence_prior"]);
  });

  it("formats durations for the timeline", () => {
    expect(formatDurationMs(null)).toBe("—");
    expect(formatDurationMs(45_000)).toBe("45s");
    expect(formatDurationMs(252_000)).toBe("4m12s");
    expect(formatDurationMs(360_000)).toBe("6m");
    expect(formatDurationMs(7_200_000)).toBe("2h");
    expect(formatDurationMs(9_000_000)).toBe("2h30m");
  });
});
