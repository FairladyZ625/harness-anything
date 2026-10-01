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
import type { ScheduleGuiRowDto, SchedulesListResult } from "@harness-anything/daemon/protocol";
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
    mode: "detect",
    definitionResidency: "ledger",
    definitionRevision: 7,
    trigger: { kind: "interval", everyMs: 1_800_000, timezone: null, summary: "every 30m" },
    target: {
      kind: "agent",
      agentId: "probe-agent",
      runtimeInstanceId: "codex-schedule",
      model: "gpt-5.6",
      reasoningEffort: "high",
      cwd: null,
    },
    mission: "Scan the previous day of pull requests.",
    executionAvailability: "local",
    claim: { nodeId: null, assignmentId: null },
    health: { recent: ["succeeded"], bucket: "clean", failedCount: 0, lastFailureDetail: null },
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
      agents: [{ agentId: "probe-agent", name: "Probe Agent", runtimes: [{ type: "codex" }] }],
      instances: [
        {
          instanceId: "codex-schedule",
          name: "Schedule Codex",
          kindId: "codex",
          models: ["gpt-5.6", "gpt-5.6-sol"],
          efforts: ["low", "medium", "high", "xhigh"],
        },
      ],
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
    expect(text).toMatch(/08-27 \d{2}:30/u);
    // 正常状态不占标签:「本节点可执行」「已布防」不上卡。
    expect(text).not.toContain("Runnable here");
    expect(text).not.toContain("Armed");
    expect(text).toContain("missed 2");
    expect(container.querySelector('[data-testid="schedules-matrix"]')).not.toBeNull();
    const card = container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')!;
    // 3 个以内的计划都用大卡:结论、运行历史条、下次运行、执行者(agent 名与模型)、任务说明。
    expect(card.getAttribute("data-summary-card")).toBe("large");
    expect(card.querySelector('[data-testid="schedule-verdict-heartbeat-probe"]')?.textContent).toMatch(/^OKlast /u);
    expect(card.querySelectorAll('[data-testid="schedule-spark-heartbeat-probe"] [data-outcome]')).toHaveLength(1);
    expect(card.textContent).toContain("Last 1 runs");
    // 为 0 的计数不显示:没有失败就只报错过数。
    expect(card.textContent).toContain("missed 2 (Scheduler unavailable)");
    expect(card.textContent).not.toContain("failed 0");
    expect(card.textContent).toContain("Probe Agent");
    expect(card.textContent).toContain("gpt-5.6");
    expect(card.textContent).toContain("Scan the previous day of pull requests.");
    // 错过过运行:左侧竖线点亮。
    expect(card.getAttribute("style")).toContain("--status-edge");
    // 「接下来」一行列出已启用计划的下次运行。
    expect(container.querySelector('[data-testid="schedules-upcoming"]')?.textContent).toContain("Heartbeat probe");
    // The retired 420px inspector is gone: the list pane is the only list surface.
    expect(container.querySelector('[data-testid="schedules-inspector"]')).toBeNull();
  });

  it("marks a built-in system preset row with its executor and an undeletable facet", async () => {
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({
          scheduleId: "builtin-ledger-backup",
          name: "Ledger backup",
          trigger: { kind: "cron", everyMs: null, expression: "17 3 * * *", timezone: "UTC", summary: "at 03:17" },
          target: { kind: "builtin", builtinId: "ledger-backup", keepDays: 3, keepMonthly: true },
          mission: "System ledger backup.",
          actions: {
            ...dto().schedules[0]!.actions,
            delete: { available: false, code: "schedule_builtin_protected", nextAction: null },
          },
        }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const row = container.querySelector('[data-testid="schedule-row-builtin-ledger-backup"]');
    expect(row?.textContent).toContain("Built-in");
    expect(row?.textContent).toContain("System preset");
  });

  it("renders unavailable Agent targets and options as row-level grey hints", async () => {
    const hint = "Install agent/ghost-agent, then retry.",
      data = dto(
        {
          target: {
            kind: "agent",
            agentId: "ghost-agent",
            runtimeInstanceId: "codex-schedule",
            model: "gpt-5.6",
            reasoningEffort: "high",
            fast: false,
            cwd: null,
          },
          targetState: "missing",
          targetError: { code: "agent_not_found", hint },
          actions: {
            ...(dto().schedules[0] as ScheduleGuiRowDto).actions,
            runNow: { available: false, code: "schedule_target_unavailable", nextAction: hint },
          },
        },
        {
          options: {
            ...dto().options,
            agents: [
              { agentId: "ghost-agent", state: "missing", error: { code: "agent_not_found", hint } },
              { agentId: "probe-agent", name: "Probe Agent", runtimes: [{ type: "codex" }] },
            ],
          },
        },
      ),
      container = await renderSurface(
        createElement(ScheduleWorkspace, {
          repoId: "repo-a",
          data,
          pending: false,
          focusedEntityRef: null,
          onSelectEntity: noop,
          onFocusSchedule: noop,
        }),
      );
    expect(container.textContent).toContain("Missing");
    expect(container.querySelector(`[data-tip="${hint}"]`)).not.toBeNull();
    expect(container.querySelector('[data-testid="schedules-read-error"]')).toBeNull();
    await click(container, "schedule-action-create");
    expect(container.querySelector('[data-testid="schedule-agent-option-ghost-agent"]')?.textContent).toContain(
      "Missing",
    );
    expect(container.querySelectorAll('[data-testid="schedule-form-agent"] option')).toHaveLength(1);
  });

  it("filters rows by state while mode/health facets read the daemon-projected row fields", async () => {
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
    // 默认就是「全部」:不先藏起来。
    const filters = container.querySelector('[data-testid="schedules-filters"]');
    const allChip = [...filters!.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("All") || b.textContent?.includes("全部"),
    );
    expect(allChip!.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).not.toBeNull();
    // 切换到「已暂停」
    const pausedChip = [...filters!.querySelectorAll("button")].find(
      (b) => b.textContent?.includes("Paused") || b.textContent?.includes("已暂停"),
    );
    await act(async () => pausedChip!.click());
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-row-paused-sweep"]')).not.toBeNull();
    // 切换回「全部」:暂停的计划沉到「已暂停 N」分隔线之后,用小方块照常显示(不折叠成「展开」)。
    await act(async () => allChip!.click());
    expect(container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="schedule-row-paused-sweep"]')?.getAttribute("data-summary-card"),
    ).toBe("tile");
    const divider = container.querySelector('[data-testid="completed-divider"]');
    expect(divider?.textContent).toMatch(/已暂停 1|Paused 1/u);
    expect(container.textContent).not.toContain("个 · 展开");
  });

  it("lights the mode/health facets and the spark when the daemon projects the rollup fields", async () => {
    const base = dto().schedules[0] as ScheduleGuiRowDto & Record<string, unknown>;
    const clean = {
      ...base,
      scheduleId: "clean-probe",
      name: "Clean probe",
      mode: "remediate",
      health: {
        recent: ["succeeded", "succeeded"],
        bucket: "clean",
        failedCount: 0,
        lastFailureDetail: null,
      },
    };
    const degraded = {
      ...base,
      scheduleId: "degraded-probe",
      name: "Degraded probe",
      mode: "detect",
      health: {
        recent: ["succeeded", "failed"],
        bucket: "degraded",
        failedCount: 1,
        lastFailureDetail: "cwd /missing does not exist",
      },
    };
    const olderFailure = {
      ...degraded,
      scheduleId: "degraded-artifact",
      name: "Degraded artifact",
      health: { ...degraded.health, lastFailureDetail: "artifact:runtime-result/old" },
    };
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({}, { schedules: [clean, degraded, olderFailure] }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    // 需要关注的排在前面;降级的卡写出结论与人能读的失败详情,历史条每次结果一个色块。
    const cards = [...container.querySelectorAll('[data-testid^="schedule-row-"]')].map((card) =>
      card.getAttribute("data-testid"),
    );
    expect(cards).toEqual([
      "schedule-row-degraded-artifact",
      "schedule-row-degraded-probe",
      "schedule-row-clean-probe",
    ]);
    // 上次运行没有失败:详情属于更早的一次失败,卡上写明是「最近一次失败」的。
    expect(container.querySelector('[data-testid="schedule-verdict-degraded-probe"]')?.textContent).toMatch(
      /^degraded1 of last 2 failed · last [^M]*Most recent failure: cwd \/missing does not exist$/u,
    );
    expect(container.querySelector('[data-testid="schedule-verdict-degraded-artifact"]')?.textContent).toMatch(
      /^degraded1 of last 2 failed · last [^D]*Detail of the most recent failure is on the schedule page$/u,
    );
    expect(container.querySelector('[data-testid="schedule-row-degraded-probe"]')!.textContent).toContain("failed 1");
    expect(container.querySelector('[data-testid="schedule-row-degraded-probe"]')!.textContent).not.toContain(
      "missed 0",
    );
    expect(
      [...container.querySelectorAll('[data-testid="schedule-spark-degraded-probe"] [data-outcome]')].map((block) =>
        block.getAttribute("data-outcome"),
      ),
    ).toEqual(["succeeded", "failed"]);
    expect(container.querySelector('[data-testid="schedule-row-clean-probe"]')).not.toBeNull();
    const searchInput = container.querySelector<HTMLInputElement>('input[type="search"]');
    await act(async () => {
      searchInput!.value = "detect";
      searchInput!.dispatchEvent(new Event("input", { bubbles: true }));
      searchInput!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector('[data-testid="schedule-row-degraded-probe"]')).not.toBeNull();
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
    // 点卡直接进详情,不设预览抽屉(标准 §5.1)。
    await click(container, "schedule-row-heartbeat-probe");
    expect(onSelectEntity).toHaveBeenCalledWith("schedule/heartbeat-probe");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("runs a schedule from its card without entering the detail, and shows the receipt in place", async () => {
    const onSelectEntity = vi.fn(),
      runNow = vi.spyOn(schedulesClient, "runNow").mockResolvedValue({
        command: "schedule-run-now",
        outcome: "applied",
        opId: "op-run-1",
        nextAction: null,
        scheduleId: "heartbeat-probe",
      });
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
    await click(container, "schedule-run-now-heartbeat-probe");
    await flush();
    expect(runNow).toHaveBeenCalledWith("repo-a", "heartbeat-probe", expect.stringMatching(/^gui:schedule-runNow:/u));
    expect(onSelectEntity).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="schedule-action-receipt"]')?.textContent).toContain("op-run-1");
  });

  it("disables the card's run-now with the daemon's reason, and writes an artifact failure ref as a pointer", async () => {
    const base = dto().schedules[0] as ScheduleGuiRowDto;
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({
          executionAvailability: "not-on-this-node",
          lastRun: { ...base.lastRun!, outcome: "failed" },
          health: {
            recent: ["failed"],
            bucket: "degraded",
            failedCount: 1,
            lastFailureDetail: "artifact:runtime-result/abc",
          },
          actions: {
            ...base.actions,
            runNow: { available: false, code: "repo_mode_requires_center_ingress", nextAction: "Use the center." },
          },
        }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const runNow = container.querySelector<HTMLButtonElement>('[data-testid="schedule-run-now-heartbeat-probe"]')!;
    expect(runNow.disabled).toBe(true);
    expect(runNow.getAttribute("data-tip")).toBe("Use the center.");
    const card = container.querySelector('[data-testid="schedule-row-heartbeat-probe"]')!;
    expect(card.textContent).not.toContain("artifact:");
    expect(card.querySelector('[data-testid="schedule-verdict-heartbeat-probe"]')?.textContent).toMatch(
      /^Failedlast .*Failure detail is on the schedule page$/u,
    );
    expect(card.textContent).toContain("Runs elsewhere");
  });

  it("sizes cards by attention once there are more than six schedules: large, small, then paused tiles", async () => {
    const base = dto({ missed: { count: 0, lastMissedAt: null, lastMissedReason: null } })
      .schedules[0] as ScheduleGuiRowDto;
    const schedules = [
      ...Array.from({ length: 5 }, (_, index) => ({ ...base, scheduleId: `clean-${index}`, name: `Clean ${index}` })),
      { ...base, scheduleId: "late", name: "Late", missed: { ...base.missed, count: 1 } },
      { ...base, scheduleId: "paused-sweep", name: "Paused sweep", state: "paused" as const },
      { scheduleId: "broken", state: "invalid" as const, invalidReason: "cron is unparsable", definitionRevision: 1 },
    ];
    const container = await renderSurface(
      createElement(ScheduleWorkspace, {
        repoId: "repo-a",
        data: dto({}, { schedules }),
        pending: false,
        focusedEntityRef: null,
        onSelectEntity: noop,
        onFocusSchedule: noop,
      }),
    );
    const sizes = (tier: string) =>
      [...container.querySelectorAll(`[data-testid="schedules-tier-${tier}"] [data-summary-card]`)].map(
        (card) => `${card.getAttribute("data-testid")}:${card.getAttribute("data-summary-card")}`,
      );
    // 定义无效的排在需要关注最前,用大卡写出无效原因,不可点进详情。
    expect(sizes("attention")).toEqual(["schedule-row-broken:large", "schedule-row-late:large"]);
    expect(container.querySelector('[data-testid="schedule-row-broken"]')?.textContent).toContain("cron is unparsable");
    expect(container.querySelector('[data-testid="schedule-row-broken"] button')).toBeNull();
    expect(sizes("normal")).toHaveLength(5);
    expect(new Set(sizes("normal").map((entry) => entry.split(":")[1]))).toEqual(new Set(["small"]));
    expect(sizes("paused")).toEqual(["schedule-row-paused-sweep:tile"]);
    // 小卡没有「立即运行」:卡内只有标题这一个可点目标。
    expect(container.querySelectorAll('[data-testid="schedule-row-clean-0"] button')).toHaveLength(1);
    expect(container.querySelector('[data-testid="schedules-upcoming"]')?.textContent).toContain("+1 more");
  });

  it("keeps the detail read-only until Edit is pressed: no edit tab, no live form controls", async () => {
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
    const detail = container.querySelector('[data-testid="schedule-detail"]')!;
    expect(detail.querySelector("#schedule-tab-edit")).toBeNull();
    for (const tabId of ["schedule-tab-overview", "schedule-tab-danger"]) {
      await click(container, tabId);
      expect(detail.querySelector('[data-testid="schedule-form"]'), tabId).toBeNull();
      expect(detail.querySelectorAll("input, textarea, select").length, tabId).toBe(0);
    }
    await click(container, "schedule-action-edit");
    expect(detail.querySelector('[data-testid="schedule-form"]')).not.toBeNull();
    // Outcome routing has no daemon write path, so the form offers no routing controls at all.
    expect(detail.querySelector('[data-testid="schedule-form-sec-routing"]')).toBeNull();
    await click(container, "schedule-form-cancel");
    expect(detail.querySelector('[data-testid="schedule-form"]')).toBeNull();
  });

  it("leaves edit mode after a saved update and shows the receipt", async () => {
    const update = vi.spyOn(schedulesClient, "update").mockResolvedValue({
      command: "schedule-update",
      outcome: "applied",
      opId: "op-update-1",
      nextAction: null,
      scheduleId: "heartbeat-probe",
    });
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
    await click(container, "schedule-action-edit");
    await setValue(container, "schedule-form-name", "Edited heartbeat");
    await click(container, "schedule-form-submit");
    await flush();
    expect(update).toHaveBeenCalledWith(
      "repo-a",
      expect.objectContaining({ scheduleId: "heartbeat-probe", name: "Edited heartbeat" }),
      expect.stringMatching(/^gui:schedule-update:/u),
    );
    expect(container.querySelector('[data-testid="schedule-form"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-action-receipt"]')?.textContent).toContain("op-update-1");
  });

  it("shows the daemon's own rejection text when a save is refused and keeps the draft open", async () => {
    const updateSchedule = vi.fn().mockResolvedValue({
      schema: "command-receipt/v2",
      ok: false,
      command: "schedule-update",
      outcome: "op_rejected",
      opId: "op-rejected-1",
      code: "entity_not_found",
      rejectionExplanation: "Schedule heartbeat-probe does not exist.",
      error: { code: "entity_not_found" },
    });
    Object.assign(window, { harness: { updateSchedule } });
    try {
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
      await click(container, "schedule-action-edit");
      await setValue(container, "schedule-form-name", "Edited heartbeat");
      await click(container, "schedule-form-submit");
      await flush();
      expect(updateSchedule).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[data-testid="schedule-form-error"]')?.textContent).toContain(
        "Schedule heartbeat-probe does not exist.",
      );
      expect(container.querySelector<HTMLInputElement>('[data-testid="schedule-form-name"]')?.value).toBe(
        "Edited heartbeat",
      );
      expect(container.querySelector('[data-testid="schedule-action-receipt"]')).toBeNull();
    } finally {
      Reflect.deleteProperty(window, "harness");
    }
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
              edit: { available: true, code: null, nextAction: null },
              delete: { available: true, code: null, nextAction: null },
              enable: { available: false, code: "no_changes", nextAction: null },
              disable: { available: true, code: null, nextAction: null },
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
    const runNow = container.querySelector<HTMLButtonElement>('[data-testid="schedule-action-runNow"]');
    expect(runNow?.disabled).toBe(true);
    expect(runNow?.getAttribute("data-tip")).toContain("Fleet assignment ingress");
    const disable = container.querySelector<HTMLButtonElement>('[data-testid="schedule-action-disable"]');
    expect(disable).not.toBeNull();
    expect(disable?.disabled).toBe(false);
    expect(disable?.getAttribute("data-tip")).toBeNull();
  });

  it("runs enable/disable/run-now through the bridge and surfaces the receipt", async () => {
    const receipt = {
      command: "schedule-disable",
      outcome: "applied",
      opId: "op-disable-1",
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

  it("creates through the segmented dialog and edits in the hub's edit mode, then confirms deletion in Danger", async () => {
    const receipt = (command: string) => ({
        command,
        outcome: "applied",
        opId: `op-${command}`,
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
    // Edit happens in the hub: the header button enters edit mode.
    await click(focused, "schedule-action-edit");
    expect(focused.querySelector('[data-testid="schedule-form-sec-identity"]')).not.toBeNull();
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
    expect(list.querySelector('[data-testid="schedule-form-cwd"]')).toBeNull();
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

  it("reads the plane through the use-case projection and reports invalid results", async () => {
    const harness = {
      readUseCaseProjection: vi.fn().mockResolvedValue(projectionEnvelope("schedule-plane", "plane", dto())),
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
    expect(harness.readUseCaseProjection).toHaveBeenCalledWith({ repoId: "repo-a", name: "schedule-plane" });
    await expect(
      schedulesClient.list("repo-a") &&
        ((harness.readUseCaseProjection = vi.fn().mockResolvedValue({ ok: false })), schedulesClient.list("repo-a")),
    ).rejects.toThrow(/invalid result/u);
    // A projection envelope naming a different projection is a routing fault, not a render problem.
    harness.readUseCaseProjection = vi
      .fn()
      .mockResolvedValue(projectionEnvelope("runtime-session-groups", "groups", dto()));
    await expect(schedulesClient.list("repo-a")).rejects.toThrow(/answered runtime-session-groups/u);
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
    // 页头只有页名与一句结论;repo mode 与节点 id 不上页头。
    expect(text).not.toContain("remote-edge");
    expect(text).not.toContain("edge-one");
    expect(container.querySelector('[data-testid="schedules-summary"]')?.textContent).toBe("0 schedules");
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
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"], #${testId}`);
  if (!el) throw new Error(`missing ${testId}`);
  const target = el.matches("button") ? el : (el.querySelector("button") ?? el);
  await act(async () => target.click());
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The wire envelope every use-case projection now arrives in. */
function projectionEnvelope(name: string, facet: string, projection: unknown) {
  return { schema: "daemon.use-case-projection/v1", ok: true, name, facet, version: 1, inputs: {}, projection };
}
