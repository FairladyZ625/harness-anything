// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SchedulesView, ScheduleWorkspace } from "../src/renderer/views/SchedulesView.tsx";
import {
  schedulesClient,
  scheduleRef,
  scheduleRefId,
  scheduleRunRef,
  scheduleRunRefOccurrence,
  scheduleRowById,
} from "../src/renderer/schedules-client.ts";
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
      edit: { available: true, code: null, nextAction: null },
      delete: { available: true, code: null, nextAction: null },
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

describe("schedules plane (S4) — matrix list (M1)", () => {
  it("renders the daemon DTO as a filterable matrix without recomputing cadence or availability", async () => {
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
    expect(container.querySelector('[data-testid="schedules-matrix"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).not.toBeNull();
    // The retired 420px inspector is gone: the list pane is the only list surface.
    expect(container.querySelector('[data-testid="schedules-inspector"]')).toBeNull();
  });

  it("filters rows by state, and keeps mode/health facets off until the daemon projects them", async () => {
    const first = dto({
      missed: { count: 0, lastMissedAt: null, lastMissedReason: null },
    }).schedules[0] as ScheduleGuiRowDto;
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(
          {},
          {
            schedules: [
              first,
              {
                ...first,
                scheduleId: "paused-sweep",
                name: "Paused sweep",
                state: "paused",
                lastRun: { ...first.lastRun!, outcome: "failed" },
              },
            ],
          },
        ),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    expect(container.textContent).toContain("2 of 2");
    await click(container, "schedules-filter-state-paused");
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-row-paused-sweep"]')).not.toBeNull();
    await click(container, "schedules-filter-state-all");
    // The renderer does not re-derive health/mode from outcomes: both facets stay
    // disabled until the daemon projects the fields.
    const modeFilter = container.querySelector<HTMLButtonElement>('[data-testid="schedules-filter-mode-detect"]');
    expect(modeFilter?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLElement>('[data-testid="schedules-filter-mode"]')?.getAttribute("data-tip"),
    ).toContain("mode");
    const healthFilter = container.querySelector<HTMLButtonElement>('[data-testid="schedules-filter-health-degraded"]');
    expect(healthFilter?.disabled).toBe(true);
    expect(
      container.querySelector<HTMLElement>('[data-testid="schedules-filter-health"]')?.getAttribute("data-tip"),
    ).toContain("health");
  });

  it("lights the mode/health facets and the spark when the daemon projects the rollup fields", async () => {
    const base = dto().schedules[0] as ScheduleGuiRowDto & Record<string, unknown>;
    const clean = {
      ...base,
      scheduleId: "clean-probe",
      name: "Clean probe",
      health: { recent: ["succeeded", "succeeded"], bucket: "clean" },
    };
    const degraded = {
      ...base,
      scheduleId: "degraded-probe",
      name: "Degraded probe",
      mode: "detect",
      health: { recent: ["succeeded", "failed"], bucket: "degraded" },
    };
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({}, { schedules: [clean, degraded] }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const modeFilter = container.querySelector<HTMLButtonElement>('[data-testid="schedules-filter-mode-detect"]');
    expect(modeFilter?.disabled).toBe(false);
    await click(container, "schedules-filter-mode-detect");
    expect(container.querySelector('[data-testid="schedule-row-clean-probe"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-row-degraded-probe"]')).not.toBeNull();
    await click(container, "schedules-filter-mode-all");
    const healthFilter = container.querySelector<HTMLButtonElement>('[data-testid="schedules-filter-health-degraded"]');
    expect(healthFilter?.disabled).toBe(false);
    await click(container, "schedules-filter-health-degraded");
    expect(container.querySelector('[data-testid="schedule-row-clean-probe"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-row-degraded-probe"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="schedule-spark-degraded-probe"]')).not.toBeNull();
  });

  it("routes a row into the schedule/<id> detail hub through the entity router", async () => {
    const onSelectEntity = vi.fn();
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity,
        onFocusSchedule: noop,
      }),
    );
    await click(container, "schedule-focus-heartbeat-probe");
    expect(onSelectEntity).toHaveBeenCalledWith("schedule/heartbeat-probe");
  });

  it("renders the detail hub for a focused schedule/<id> ref and keeps action blockers from the daemon", async () => {
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(
          {
            executionAvailability: "not-on-this-node",
            claim: { nodeId: "edge-one", assignmentId: "assignment-edge-one" },
            actions: {
              edit: {
                available: false,
                code: "repo_mode_requires_center_ingress",
                nextAction: "Send write commands through the authenticated Fleet assignment ingress.",
              },
              delete: {
                available: false,
                code: "repo_mode_requires_center_ingress",
                nextAction: "Send write commands through the authenticated Fleet assignment ingress.",
              },
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
        focusedEntityRef: "schedule/heartbeat-probe",
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const text = container.textContent ?? "";
    expect(container.querySelector('[data-testid="schedule-detail"]')).not.toBeNull();
    expect(text).toContain("Runs elsewhere");
    expect(text).toContain("edge-one");
    expect(text).toContain("Scan the previous day of pull requests.");
    for (const kind of ["enable", "disable", "runNow"]) {
      const button = container.querySelector<HTMLButtonElement>(`[data-testid="schedule-action-${kind}"]`);
      expect(button?.disabled, `${kind} must be disabled on a center`).toBe(true);
      expect(button?.getAttribute("data-tip")).toContain("Fleet assignment ingress");
    }
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
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        focusedEntityRef: "schedule/heartbeat-probe",
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    await click(container, "schedule-action-disable");
    await flush();
    expect(disable).toHaveBeenCalledWith("repo-a", "heartbeat-probe", expect.stringMatching(/^gui:schedule-disable:/u));
    const receiptNode = container.querySelector('[data-testid="schedule-action-receipt"]');
    expect(receiptNode?.textContent).toContain("schedule-disable");
    expect(receiptNode?.textContent).toContain("applied");
    expect(receiptNode?.textContent).toContain("op-disable-1");
  });

  it("creates through the segmented dialog and edits in the hub's Edit tab, then confirms deletion in Danger", async () => {
    const receipt = (command: string) => ({
        ok: true,
        command,
        outcome: "applied",
        opId: `op-${command}`,
        code: null,
        nextAction: null,
        scheduleId: "heartbeat-probe",
      }),
      create = vi.spyOn(schedulesClient, "create").mockResolvedValue(receipt("schedule-create")),
      update = vi.spyOn(schedulesClient, "update").mockResolvedValue(receipt("schedule-update")),
      remove = vi.spyOn(schedulesClient, "delete").mockResolvedValue(receipt("schedule-delete")),
      onFocusSchedule = vi.fn(),
      focused = await renderSurface(
        createElement(ScheduleWorkspace, {
          repoId: "repo-a",
          data: dto(),
          pending: false,
          focusedEntityRef: "schedule/heartbeat-probe",
          onSelectEntity: noop,
          onFocusSchedule,
        }),
      );
    // Edit happens in the hub now: the header button switches to the Edit tab.
    await click(focused, "schedule-action-edit");
    expect(focused.querySelector('[data-testid="schedule-form-sec-identity"]')).not.toBeNull();
    expect(focused.querySelector('[data-testid="schedule-form-sec-routing"]')).not.toBeNull();
    await setValue(focused, "schedule-form-name", "Edited heartbeat");
    await click(focused, "schedule-form-submit");
    await flush();
    expect(update).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ scheduleId: "heartbeat-probe", name: "Edited heartbeat" }),
      expect.stringMatching(/^gui:schedule-update:/u),
    );

    await click(focused, "schedule-tab-danger");
    await click(focused, "schedule-action-delete");
    expect(remove).not.toHaveBeenCalled();
    expect(focused.querySelector('[data-testid="schedule-delete-confirmation"]')).not.toBeNull();
    await click(focused, "schedule-action-confirm-delete");
    await flush();
    expect(remove).toHaveBeenCalledWith(
      "repo-a",
      "heartbeat-probe",
      expect.stringMatching(/^gui:schedule-delete:/u),
      "Deleted from the Schedules GUI.",
    );
    expect(onFocusSchedule).toHaveBeenCalledWith(null);

    // Create stays a dialog from the list pane.
    const list = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto(),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule,
      }),
    );
    await click(list, "schedule-action-create");
    await setValue(list, "schedule-form-id", "fresh-probe");
    await setValue(list, "schedule-form-name", "Fresh probe");
    await setValue(list, "schedule-form-mission", "Run the fresh probe.");
    expect(list.querySelector('[data-testid="schedule-form-agent"]')?.tagName).toBe("SELECT");
    expect(list.querySelector('[data-testid="schedule-form-instance"]')?.tagName).toBe("SELECT");
    expect(list.querySelector('[data-testid="schedule-form-model"]')?.tagName).toBe("SELECT");
    expect(list.querySelector('[data-testid="schedule-form-effort"]')?.tagName).toBe("SELECT");
    expect(list.querySelector('[data-testid="schedule-form-cwd"]')?.tagName).toBe("SELECT");
    await click(list, "schedule-form-submit");
    await flush();
    expect(create).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({
        scheduleId: "fresh-probe",
        name: "Fresh probe",
        everyMs: 1_800_000,
        agentId: "probe-agent",
        runtimeInstanceId: "codex-schedule",
        mission: "Run the fresh probe.",
      }),
      expect.stringMatching(/^gui:schedule-create:/u),
    );
    expect(onFocusSchedule).toHaveBeenCalledWith("schedule/fresh-probe");
  });

  it("focus resolves from the deep-link ref, including embedded run refs", () => {
    const rows = dto().schedules;
    expect(scheduleRefId("schedule/heartbeat-probe")).toBe("heartbeat-probe");
    expect(scheduleRefId("schedule/heartbeat-probe/runs/occ_1")).toBe("heartbeat-probe");
    expect(scheduleRefId("schedule/")).toBe(null);
    expect(scheduleRefId("session/other")).toBe(null);
    expect(scheduleRef("heartbeat-probe")).toBe("schedule/heartbeat-probe");
    expect(scheduleRunRef("heartbeat-probe", "occ_1")).toBe("schedule/heartbeat-probe/runs/occ_1");
    expect(scheduleRunRefOccurrence("schedule/heartbeat-probe/runs/occ_1")).toBe("occ_1");
    expect(scheduleRunRefOccurrence("schedule/heartbeat-probe")).toBe(null);
    expect(scheduleRunRefOccurrence("schedule/heartbeat-probe/runs/")).toBe(null);
    expect(scheduleRunRefOccurrence(null)).toBe(null);
    expect(scheduleRowById(rows, "heartbeat-probe")?.scheduleId).toBe("heartbeat-probe");
    expect(scheduleRowById(rows, "missing")).toBe(null);
    expect(scheduleRowById(rows, null)).toBe(null);
  });

  it("reads the list through the bridge and reports invalid results", async () => {
    const harness = {
      listSchedules: vi.fn().mockResolvedValue(dto()),
      createSchedule: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
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
    expect(text).toContain("No schedules yet");
    expect(container.querySelector('[data-testid="schedules-view"]')).not.toBeNull();
    // A stale ref for a missing schedule falls back to the list, not an inspector.
    expect(container.querySelector('[data-testid="schedules-inspector"]')).toBeNull();
  });
});

async function setValue(container: HTMLElement, testId: string, value: string): Promise<void> {
  const field = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  if (!field) throw new Error(`missing ${testId}`);
  await act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`missing ${testId}`);
  await act(async () => button.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
