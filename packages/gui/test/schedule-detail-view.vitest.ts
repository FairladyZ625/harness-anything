// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  ScheduleDetailView,
  ScheduleSquadLanes,
  deriveScheduleRunRows,
  formatDurationMs,
} from "../src/renderer/views/ScheduleDetailView.tsx";
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
    repoId: "repo-a",
    scheduleId: "heartbeat-probe",
    runs,
    totals: {
      runs: runs.length,
      missed: runs.filter((candidate) => candidate.outcome === "missed").length,
      failed: runs.filter((candidate) => candidate.outcome === "failed").length,
    },
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
  squadRunId: null,
  outcome: "failed",
  missedReason: null,
  reportRef: "harness/schedules/heartbeat-probe/runs/occurrence_86b0/report.md",
  detail: "artifact:runtime-result/sha256/86b0",
  ...overrides,
});

async function renderDetail(focusedEntityRef: string | null, data = listResult()): Promise<HTMLElement> {
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
          onSelectEntity: noop,
          onExitRun: noop,
          onExit: noop,
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
  it("renders Overview from the list row: mission, pending mode chip, agent link stays a G10 path", async () => {
    const onSelectEntity = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const data = listResult();
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ScheduleDetailView, {
            repoId: "repo-a",
            row: data.schedules[0] as ScheduleGuiRowDto,
            options: data.options,
            scheduleIds: ["heartbeat-probe"],
            focusedEntityRef: "schedule/heartbeat-probe",
            busy: false,
            receipt: null,
            actionError: null,
            onAction: noop,
            onSave: noop,
            onDelete: noop,
            onSelectEntity,
            onExitRun: noop,
            onExit: noop,
          }),
        ),
      );
    });
    mounted.push({ root, container });
    const text = container.textContent ?? "";
    expect(text).toContain("Heartbeat probe");
    expect(text).toContain("Keep the end-to-end mainline green.");
    expect(text).toContain("mode pending");
    expect(text).toContain("Claimed elsewhere");
    expect(text).toContain("edge-two");
    // Health spark is pending the backend rollup — labeled, not fabricated.
    expect(container.querySelector('[data-testid="schedule-overview-health"]')?.textContent).toContain("pending");
    // G10: the agent id is still a path to the agent entity.
    container.querySelector<HTMLButtonElement>('[data-testid="schedule-agent-link-probe-agent"]')?.click();
    expect(onSelectEntity).toHaveBeenCalledWith("agent/probe-agent");
  });

  it("falls back to the occurrences the list read projects while repo.schedules.runs is pending", async () => {
    const container = await renderDetail("schedule/heartbeat-probe");
    await click(container, "schedule-tab-runs");
    await settle();
    const timeline = container.querySelector('[data-testid="schedule-runs-timeline"]');
    expect(timeline).not.toBeNull();
    // Boundary is labeled; derived rows show running active + settled last + missed aggregate.
    expect(container.querySelector('[data-testid="schedule-runs"]')?.textContent).toContain("repo.schedules.runs");
    expect(container.querySelector('[data-testid="schedule-run-row-occurrence_now"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-run-row-occurrence_prior"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-run-row-aggregate"]')?.textContent).toContain("missed");
    expect(container.querySelector('[data-testid="schedule-run-row-aggregate"]')?.textContent).toContain(
      "Scheduler unavailable",
    );
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
          detail: null,
          claimedAt: null,
          endedAt: null,
          durationMs: null,
          attemptIndex: null,
        }),
        occurrence({ occurrenceId: "occurrence_71d0", outcome: "succeeded", kind: "manual", reportRef: null }),
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
    // No pending-backend banner when the projection answers.
    expect(container.querySelector('[data-testid="schedule-runs"]')?.textContent).not.toContain("repo.schedules.runs");
  });
});

describe("embedded run detail (M4)", () => {
  it("opens a run row into schedule/<id>/runs/<occurrence> — never a session/ jump", async () => {
    const onSelectEntity = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const data = listResult();
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ScheduleDetailView, {
            repoId: "repo-a",
            row: data.schedules[0] as ScheduleGuiRowDto,
            options: data.options,
            scheduleIds: ["heartbeat-probe"],
            focusedEntityRef: "schedule/heartbeat-probe",
            busy: false,
            receipt: null,
            actionError: null,
            onAction: noop,
            onSave: noop,
            onDelete: noop,
            onSelectEntity,
            onExitRun: noop,
            onExit: noop,
          }),
        ),
      );
    });
    mounted.push({ root, container });
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
    const data = listResult();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(ScheduleDetailView, {
            repoId: "repo-a",
            row: data.schedules[0] as ScheduleGuiRowDto,
            options: data.options,
            scheduleIds: ["heartbeat-probe"],
            focusedEntityRef: "schedule/heartbeat-probe/runs/occurrence_now",
            busy: false,
            receipt: null,
            actionError: null,
            onAction: noop,
            onSave: noop,
            onDelete: noop,
            onSelectEntity: noop,
            onExitRun,
            onExit,
          }),
        ),
      );
    });
    mounted.push({ root, container });
    await settle();
    // A deep link straight into the run renders the run detail, not the hub tabs.
    expect(container.querySelector('[data-testid="schedule-run-detail"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-detail-tabs"]')).toBeNull();
    await click(container, "schedule-detail-back");
    expect(onExitRun).toHaveBeenCalledTimes(1);
    expect(onExit).not.toHaveBeenCalled();
  });

  it("embeds the run session and artifacts in-page, session id shown as text", async () => {
    vi.spyOn(schedulesClient, "runs").mockResolvedValue(runsResult([occurrence()]));
    const container = await renderDetail("schedule/heartbeat-probe/runs/occurrence_86b0");
    await settle();
    const detail = container.querySelector('[data-testid="schedule-run-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain("occurrence_86b0");
    expect(detail?.textContent).toContain("edge-sf-2");
    expect(detail?.textContent).toContain("runtime-86b0");
    // The transcript is embedded (dispatch ledger replay container), not a link out.
    expect(container.querySelector('[data-testid="schedule-run-session-occurrence_86b0"]')).not.toBeNull();
    expect(container.querySelector("button[data-testid^='schedule-session-link-']")).toBeNull();
    // Artifacts + routing panel from the occurrence row.
    expect(container.querySelector('[data-testid="schedule-run-artifact-report"]')?.textContent).toContain("report.md");
    expect(detail?.textContent).toContain("decision-packet");
  });

  it("renders the squad lane skeleton from the SquadRunReadResult shape", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleSquadLanes, {
          run: {
            squadRunId: "squadrun_1",
            squadId: "squad_core",
            taskId: "task_1",
            mission: "probe",
            phase: "workers_running",
            error: null,
            currentLeaderRuntimeSessionId: "runtime-leader",
            leaderTurns: [
              {
                turnId: "turn_1",
                trigger: { kind: "initial" },
                dispatchId: "dispatch_a",
                runtimeSessionId: "runtime-leader",
                decision: { kind: "plan", dispatchCount: 2 },
                resultText: null,
                status: "succeeded",
                startedAt: "2026-08-27T08:00:00.000Z",
                endedAt: "2026-08-27T08:01:00.000Z",
              },
            ],
            workerAttempts: [
              {
                attemptId: "attempt_1",
                workerId: "worker_a",
                leaderTurnId: "turn_1",
                dispatchId: "dispatch_b",
                runtimeSessionId: "runtime-worker-a",
                rejection: null,
                status: "running",
                startedAt: "2026-08-27T08:01:00.000Z",
                endedAt: null,
              },
            ],
          },
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="schedule-run-squad-lanes"]')).not.toBeNull();
    expect(text).toContain("turn_1");
    expect(text).toContain("plan");
    expect(text).toContain("worker_a");
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });
});

describe("run-row derivation helpers", () => {
  it("derives only the occurrences the list read already projects", () => {
    const derived = deriveScheduleRunRows(row());
    expect(derived.map((candidate) => candidate.occurrenceId)).toEqual(["occurrence_now", "occurrence_prior", ""]);
    expect(derived[0]?.outcome).toBe("running");
    expect(derived[1]?.outcome).toBe("failed");
    expect(derived[2]?.outcome).toBe("missed");
    // lastRun duration is arithmetic over two daemon timestamps.
    expect(derived[1]?.durationMs).toBe(252_000);
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
