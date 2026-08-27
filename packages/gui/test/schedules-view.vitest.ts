// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SchedulesView, ScheduleWorkspace } from "../src/renderer/views/SchedulesView.tsx";
import { schedulesClient, scheduleRef, scheduleRefId, scheduleRowById } from "../src/renderer/schedules-client.ts";
import type { ScheduleGuiRowDto, SchedulesListResult } from "../../daemon/src/protocol/schedules-gui-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

function dto(
  overrides: Partial<ScheduleGuiRowDto> = {},
  result: Partial<SchedulesListResult> = {},
): SchedulesListResult {
  const row: ScheduleGuiRowDto = {
    scheduleId: "heartbeat-probe",
    name: "Heartbeat probe",
    state: "armed",
    definitionResidency: "ledger",
    definitionRevision: 7,
    trigger: { kind: "interval", everyMs: 1_800_000, timezone: null, summary: "every 30m" },
    target: {
      agentId: "probe-agent",
      runtimeInstanceId: "codex-schedule",
      model: "gpt-5.6",
      reasoningEffort: "high",
      cwd: null,
    },
    mission: "Scan the previous day of pull requests.",
    executionAvailability: "local",
    claim: { nodeId: null, assignmentId: null },
    nextRunAt: "2026-08-27T08:30:00.000Z",
    actions: {
      enable: { available: false, code: "no_changes", nextAction: "The Schedule is already armed." },
      disable: { available: true, code: null, nextAction: null },
      runNow: { available: true, code: null, nextAction: null },
    },
    activeRun: null,
    lastRun: {
      occurrenceId: "occurrence_prior",
      scheduledFor: "2026-08-27T08:00:00.000Z",
      endedAt: "2026-08-27T08:02:00.000Z",
      outcome: "succeeded",
      nodeId: "local",
      assignmentId: null,
      attemptIndex: 0,
      dispatchId: "dispatch_000000000000000000000001",
      runtimeSessionId: "runtime-prior",
      detail: null,
    },
    missed: { count: 2, lastMissedAt: "2026-08-27T07:00:00.000Z", lastMissedReason: "scheduler_unavailable" },
    automaticEvaluatedThrough: "2026-08-27T08:00:00.000Z",
    updatedAt: "2026-08-27T08:00:00.000Z",
    ...overrides,
  };
  return {
    ok: true,
    status: "ready",
    repoId: "repo-a",
    repoMode: "local",
    viewerNodeId: "local",
    assignmentResolution: "roster",
    schedules: [row],
    watermark: 12,
    sourceRevision: 12,
    ...result,
  };
}

const noop = () => undefined;

async function renderSurface(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, element));
  });
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("schedules plane (S4)", () => {
  it("renders the daemon DTO without recomputing cadence or availability", async () => {
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Heartbeat probe");
    expect(text).toContain("every 30m");
    expect(text).toMatch(/2026-08-27 \d{2}:30/u);
    expect(text).toContain("Runnable here");
    expect(text).toContain("missed 2");
    expect(text).toContain("Scheduler unavailable");
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-action-runNow"]')).not.toBeNull();
  });

  it("keeps run-now disabled with the daemon blocker on a remote center", async () => {
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(
          {
            executionAvailability: "not-on-this-node",
            claim: { nodeId: "edge-one", assignmentId: "assignment-edge-one" },
            actions: {
              enable: {
                available: false,
                code: "repo_mode_requires_center_ingress",
                nextAction: "Send write commands through the authenticated Fleet assignment ingress.",
              },
              disable: {
                available: false,
                code: "repo_mode_requires_center_ingress",
                nextAction: "Send write commands through the authenticated Fleet assignment ingress.",
              },
              runNow: {
                available: false,
                code: "repo_mode_requires_center_ingress",
                nextAction: "Send write commands through the authenticated Fleet assignment ingress.",
              },
            },
          },
          { repoMode: "remote-center", viewerNodeId: null },
        ),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Runs elsewhere");
    expect(text).toContain("edge-one");
    for (const kind of ["enable", "disable", "runNow"]) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="schedule-action-${kind}"]`);
      expect(button?.disabled, `${kind} must be disabled on a center`).toBe(true);
      expect(button?.getAttribute("data-tip")).toContain("Fleet assignment ingress");
    }
    // The center shows no local provider or liveness claims at all.
    expect(text).not.toContain("live");
    expect(text).not.toContain("provider");
  });

  it("shows the active runtime only as the owner's claim, with session deep-links", async () => {
    const onSelectEntity = vi.fn();
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({
          executionAvailability: "claimed-elsewhere",
          claim: { nodeId: "edge-two", assignmentId: "assignment-edge-two" },
          actions: {
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
        }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity,
        onFocusSchedule: noop,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Claimed elsewhere");
    expect(text).toContain("occurrence_now");
    expect(text).toContain("edge-two");
    const runNow = container.querySelector<HTMLButtonElement>('[data-testid="schedule-action-runNow"]');
    expect(runNow?.disabled).toBe(true);
    expect(runNow?.getAttribute("data-tip")).toContain("occurrence_now");
    const sessionLink = container.querySelector<HTMLButtonElement>(
      '[data-testid="schedule-session-link-runtime-active"]',
    );
    expect(sessionLink).not.toBeNull();
    sessionLink?.click();
    expect(onSelectEntity).toHaveBeenCalledWith("session/runtime-active");
    const agentLink = container.querySelector<HTMLButtonElement>('[data-testid="schedule-agent-link-probe-agent"]');
    agentLink?.click();
    expect(onSelectEntity).toHaveBeenCalledWith("agent/probe-agent");
  });

  it("runs enable/disable/run-now through the bridge and surfaces the receipt", async () => {
    const receipt = {
      ok: true,
      command: "schedule-disable",
      outcome: "applied",
      opId: "op-disable-1",
      code: null,
      nextAction: null,
      scheduleId: "heartbeat-probe",
    };
    const disable = vi.spyOn(schedulesClient, "disable").mockResolvedValue(receipt);
    const onFocusSchedule = vi.fn();
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule,
      }),
    );
    container.querySelector<HTMLButtonElement>('[data-testid="schedule-action-disable"]')?.click();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(disable).toHaveBeenCalledWith("repo-a", "heartbeat-probe", expect.stringMatching(/^gui:schedule-disable:/u));
    const receiptNode = container.querySelector('[data-testid="schedule-action-receipt"]');
    expect(receiptNode?.textContent).toContain("schedule-disable");
    expect(receiptNode?.textContent).toContain("applied");
    expect(receiptNode?.textContent).toContain("op-disable-1");
    container.querySelector<HTMLButtonElement>('[data-testid="schedule-focus-heartbeat-probe"]')?.click();
    expect(onFocusSchedule).toHaveBeenCalledWith("schedule/heartbeat-probe");
  });

  it("focus resolves from the deep-link ref and falls back to the first row", () => {
    const rows = dto().schedules;
    expect(scheduleRefId("schedule/heartbeat-probe")).toBe("heartbeat-probe");
    expect(scheduleRefId("schedule/")).toBe(null);
    expect(scheduleRefId("session/other")).toBe(null);
    expect(scheduleRef("heartbeat-probe")).toBe("schedule/heartbeat-probe");
    expect(scheduleRowById(rows, "heartbeat-probe")?.scheduleId).toBe("heartbeat-probe");
    expect(scheduleRowById(rows, "missing")).toBe(null);
    expect(scheduleRowById(rows, null)).toBe(null);
  });

  it("reads the list through the bridge and reports invalid results", async () => {
    const harness = {
      listSchedules: vi.fn().mockResolvedValue(dto()),
      enableSchedule: vi.fn(),
      disableSchedule: vi.fn(),
      runScheduleNow: vi.fn(),
    };
    vi.stubGlobal("window", { harness });
    const result = await schedulesClient.list("repo-a");
    expect(result.schedules[0]?.scheduleId).toBe("heartbeat-probe");
    expect(harness.listSchedules).toHaveBeenCalledWith({ repoId: "repo-a" });
    await expect(
      schedulesClient.list("repo-a") &&
        ((harness.listSchedules = vi.fn().mockResolvedValue({ ok: false })), schedulesClient.list("repo-a")),
    ).rejects.toThrow(/invalid result/u);
    vi.unstubAllGlobals();
  });

  it("mounts the full view with the query hook and empty state", async () => {
    vi.spyOn(schedulesClient, "list").mockResolvedValue({
      ...dto(),
      repoMode: "remote-edge",
      viewerNodeId: "edge-one",
      assignmentResolution: "unavailable",
      schedules: [],
    });
    const container = await renderSurface(
      createElement(SchedulesView, {
        repoId: "repo-a",
        focusedEntityRef: "schedule/heartbeat-probe",
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const text = container.textContent ?? "";
    expect(text).toContain("remote-edge");
    expect(text).toContain("edge-one");
    expect(text).toContain("roster unresolved");
    expect(text).toContain("No schedules yet");
    expect(container.querySelector('[data-testid="schedules-view"]')).not.toBeNull();
  });
});
