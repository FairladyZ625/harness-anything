// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import {
  ScheduleFormDialog,
  buildCronExpression,
  parseCronCalendar,
} from "../src/renderer/components/ScheduleFormDialog.tsx";
import type { ScheduleDefinitionInput } from "../src/renderer/schedules-client.ts";
import type { ScheduleGuiOptionsDto, ScheduleGuiRowDto } from "../../daemon/src/protocol/schedules-gui-contract.ts";
import { validateDaemonRpcCall } from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

const options: ScheduleGuiOptionsDto = {
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
};

const initialRow: ScheduleGuiRowDto = {
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
    fast: true,
    cwd: null,
  },
  mission: "Keep the mainline green.",
  executionAvailability: "local",
  claim: { nodeId: null, assignmentId: null },
  nextRunAt: null,
  actions: {
    edit: { available: true, code: null, nextAction: null },
    delete: { available: true, code: null, nextAction: null },
    enable: { available: false, code: null, nextAction: null },
    disable: { available: true, code: null, nextAction: null },
    runNow: { available: true, code: null, nextAction: null },
  },
  activeRun: null,
  lastRun: null,
  missed: { count: 0, lastMissedAt: null, lastMissedReason: null },
  automaticEvaluatedThrough: "2026-08-27T08:00:00.000Z",
  updatedAt: "2026-08-27T08:00:00.000Z",
};

async function renderForm(initial: ScheduleGuiRowDto | null): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(ScheduleFormDialog, {
        options,
        scheduleIds: ["other-schedule"],
        initial,
        busy: false,
        error: null,
        onCancel: () => undefined,
        onSubmit: () => undefined,
      }),
    );
  });
  mounted.push({ root, container });
  return container;
}

afterEach(async () => {
  for (const { root } of mounted.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = "";
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

describe("calendar → cron builder (Q5 leaning b)", () => {
  it("builds daily and weekly expressions from the calendar UI inputs", () => {
    expect(buildCronExpression("daily", "02:30", new Set())).toBe("30 2 * * *");
    expect(buildCronExpression("daily", "23:59", new Set())).toBe("59 23 * * *");
    expect(buildCronExpression("weekly", "02:30", new Set([1]))).toBe("30 2 * * 1");
    // Sunday sorts last (cron 0) even when picked first.
    expect(buildCronExpression("weekly", "02:30", new Set([0, 1, 3]))).toBe("30 2 * * 1,3,0");
    expect(buildCronExpression("weekly", "02:30", new Set())).toBeNull();
    expect(buildCronExpression("daily", "24:00", new Set())).toBeNull();
    expect(buildCronExpression("daily", "2:3", new Set())).toBeNull();
    expect(buildCronExpression("daily", " 08:05 ", new Set())).toBe("5 8 * * *");
  });
});

describe("segmented guided form (M5)", () => {
  it("renders all six segments with the executor squad option reserved and the downstream toggle locked off", async () => {
    const container = await renderForm(initialRow);
    for (const section of [
      "schedule-form-sec-identity",
      "schedule-form-sec-trigger",
      "schedule-form-sec-executor",
      "schedule-form-sec-purpose",
      "schedule-form-sec-routing",
      "schedule-form-sec-mission",
    ]) {
      expect(container.querySelector(`[data-testid="${section}"]`)).not.toBeNull();
    }
    const squad = container.querySelector<HTMLButtonElement>('[data-testid="schedule-form-executor-squad"]');
    expect(squad?.disabled).toBe(true);
    expect(squad?.getAttribute("title")).toContain("reserved");
    const downstream = container.querySelector<HTMLElement>('[data-testid="schedule-form-routing-downstream"]');
    expect(downstream?.textContent).toContain("Trigger downstream schedule");
    expect(downstream?.getAttribute("data-tip")).toContain("ruling");
    // The ternary loop is the default route; report is locked on.
    const report = container.querySelector<HTMLElement>('[data-testid="schedule-form-routing-report"]');
    expect(report?.textContent).toContain("Write report");
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="schedule-form-fast"] button')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("switches to the cron calendar, previews the expression, and keeps the save armed", async () => {
    const container = await renderForm(initialRow);
    await click(container, "schedule-form-trigger-cron");
    expect(container.querySelector('[data-testid="schedule-form-cron"]')).not.toBeNull();
    await setValue(container, "schedule-form-cron-time", "02:30");
    expect(container.querySelector('[data-testid="schedule-form-cron-expression"]')?.textContent).toContain(
      "30 2 * * *",
    );
    // The cron write path is wired: a valid calendar selection no longer blocks the save.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="schedule-form-submit"]')?.disabled).toBe(false);
  });

  it("selects weekly weekdays and reflects them in the expression", async () => {
    const container = await renderForm(initialRow);
    await click(container, "schedule-form-trigger-cron");
    const frequency = container.querySelector<HTMLSelectElement>('[data-testid="schedule-form-cron-frequency"]');
    await act(async () => {
      frequency!.value = "weekly";
      frequency!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(container, "schedule-form-cron-weekday-1"); // deselect the default Monday
    await click(container, "schedule-form-cron-weekday-3");
    await click(container, "schedule-form-cron-weekday-0");
    expect(container.querySelector('[data-testid="schedule-form-cron-expression"]')?.textContent).toContain(
      "30 2 * * 3,0",
    );
  });

  it("lets the purpose choice be re-selected and keeps the not-yet-landed routing boundary stated", async () => {
    const container = await renderForm(initialRow);
    await click(container, "schedule-form-purpose-remediate");
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="schedule-form-purpose-remediate"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    await click(container, "schedule-form-routing-fact");
    expect(container.textContent).toContain("outcome-routing write path");
  });

  it("inserts mission templates and variable slots, and keeps the interval payload shape", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: null,
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    await setValue(container, "schedule-form-id", "fresh-probe");
    await setValue(container, "schedule-form-name", "Fresh probe");
    // Variable slot chip appends a token to the mission scaffold.
    const variableChip = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "{{lastReport}}",
    );
    await act(async () => variableChip?.click());
    const mission = container.querySelector<HTMLTextAreaElement>('[data-testid="schedule-form-mission"]');
    expect(mission?.value).toContain("{{lastReport}}");
    await setValue(container, "schedule-form-mission", "Run the probe {{repo}}.");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="schedule-form-fast"] button')?.click(),
    );
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "fresh-probe",
        everyMs: 1_800_000,
        mission: "Run the probe {{repo}}.",
        fast: true,
      } satisfies Partial<ScheduleDefinitionInput>),
    );
  });
  it("offers only the instances the selected agent's runtime type can run", async () => {
    const mixed: ScheduleGuiOptionsDto = {
      ...options,
      agents: [...options.agents, { agentId: "any-agent", name: "Any Agent", runtimes: [] }],
      instances: [
        ...options.instances,
        {
          instanceId: "claude-schedule",
          name: "Schedule Claude",
          kindId: "claude",
          models: ["claude-fable-5"],
          efforts: ["low", "medium", "high"],
        },
      ],
    };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options: mixed,
          scheduleIds: [],
          initial: null,
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit: () => undefined,
        }),
      );
    });
    mounted.push({ root, container });
    const instanceOptions = () =>
      [...container.querySelectorAll<HTMLSelectElement>('[data-testid="schedule-form-instance"] option')].map(
        (option) => option.value,
      );
    // probe-agent declares runtimes codex, so the claude instance is not offered.
    expect(instanceOptions()).toEqual(["codex-schedule"]);
    const agent = container.querySelector<HTMLSelectElement>('[data-testid="schedule-form-agent"]');
    await act(async () => {
      agent!.value = "any-agent";
      agent!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(instanceOptions()).toEqual(["codex-schedule", "claude-schedule"]);
  });
});

describe("interval round-trip (schedule duration vocabulary)", () => {
  it("re-saves a 90s interval unchanged instead of rounding it to the nearest minute", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: {
            ...initialRow,
            trigger: { ...initialRow.trigger, kind: "interval", everyMs: 90_000, summary: "every 90s" },
          } as ScheduleGuiRowDto,
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    // 只改 mission,不碰时长控件:保存不得改写 everyMs。
    await setValue(container, "schedule-form-mission", "Keep the mainline green, again.");
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ everyMs: 90_000 }));
  });

  it("blocks a sub-minute interval through the shared vocabulary, matching the preload floor", async () => {
    const container = await renderForm(null);
    await setValue(container, "schedule-form-id", "fresh-probe");
    await setValue(container, "schedule-form-name", "Fresh probe");
    await setValue(container, "schedule-form-mission", "Run the probe.");
    await setValue(container, "schedule-form-every", "30");
    const unit = container.querySelector<HTMLSelectElement>('[data-testid="schedule-form-unit"]');
    await act(async () => {
      unit!.value = "s";
      unit!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // 30s < the daemon's 60s floor: parseScheduleDuration returns null and the save stays disabled.
    expect(container.querySelector<HTMLButtonElement>('[data-testid="schedule-form-submit"]')?.disabled).toBe(true);
  });
});

// The wired write path: the object submit() actually produces (not a hand-written
// fixture) must clear the two gates every GUI mutation really crosses — the preload
// boundary and the daemon's schedule.* shape validation — for update and for a cron
// create. Negative controls pin the same gates shut: a payload without `mode` is
// still rejected by the daemon shape, and an interval+cron combination is still
// rejected by the preload closure.
describe("real submit() payloads clear the preload and daemon gates", () => {
  const preloadGate = (method: "createSchedule" | "updateSchedule", payload: Record<string, unknown>) =>
    assertPreloadPayload(method, { repoId: "repo-a", ...payload, idempotencyKey: "retry-1" });
  const daemonGate = (method: "repo.schedule.create" | "repo.schedule.update", payload: Record<string, unknown>) =>
    validateDaemonRpcCall({
      method,
      params: { repo: { repoId: "repo-a" }, payload: { ...payload, idempotencyKey: "retry-1" } },
    });

  async function renderSpyForm(
    initial: ScheduleGuiRowDto | null,
  ): Promise<{ readonly container: HTMLElement; readonly onSubmit: ReturnType<typeof vi.fn> }> {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial,
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    return { container, onSubmit };
  }

  async function chooseSelect(container: HTMLElement, testId: string, value: string): Promise<void> {
    const select = container.querySelector<HTMLSelectElement>(`[data-testid="${testId}"]`);
    if (!select) throw new Error(`missing ${testId}`);
    await act(async () => {
      select.value = value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("sends the stored mode and interval trigger on update, and both gates accept it", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const remediateRow: ScheduleGuiRowDto = { ...initialRow, mode: "remediate" };
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: remediateRow,
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    await chooseSelect(container, "schedule-form-model", "gpt-5.6-sol");
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as ScheduleDefinitionInput;
    expect(payload.mode).toBe("remediate");
    expect(payload.model).toBe("gpt-5.6-sol");
    expect(payload.everyMs).toBe(7_200_000);
    expect(payload.cronExpression).toBeUndefined();
    expect(() => preloadGate("updateSchedule", payload as Record<string, unknown>)).not.toThrow();
    expect(daemonGate("repo.schedule.update", payload as Record<string, unknown>)).toEqual([]);
  });

  it("sends mode + cronExpression + timezone (no everyMs) on a cron create, and both gates accept it", async () => {
    const { container, onSubmit } = await renderSpyForm(null);
    await setValue(container, "schedule-form-id", "nightly-digest");
    await setValue(container, "schedule-form-name", "Nightly digest");
    await setValue(container, "schedule-form-mission", "Digest the day.");
    await click(container, "schedule-form-trigger-cron");
    await setValue(container, "schedule-form-cron-time", "02:30");
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as ScheduleDefinitionInput;
    expect(payload.mode).toBe("detect");
    expect(payload.everyMs).toBeUndefined();
    expect(payload.cronExpression).toBe("30 2 * * *");
    expect(payload.timezone).toBe("UTC");
    expect(() => preloadGate("createSchedule", payload as Record<string, unknown>)).not.toThrow();
    expect(daemonGate("repo.schedule.create", payload as Record<string, unknown>)).toEqual([]);
  });

  it("still rejects a payload without mode at the daemon gate and an interval+cron mix at the preload gate", async () => {
    const { container, onSubmit } = await renderSpyForm(null);
    await setValue(container, "schedule-form-id", "nightly-digest");
    await setValue(container, "schedule-form-name", "Nightly digest");
    await setValue(container, "schedule-form-mission", "Digest the day.");
    await click(container, "schedule-form-trigger-cron");
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    const withMode = { ...payload, mode: payload.mode ?? "detect" },
      { mode: _mode, ...withoutMode } = withMode;
    // Missing mode stays a hard reject at the daemon shape even after the wiring.
    expect(daemonGate("repo.schedule.create", withoutMode)).not.toEqual([]);
    // An interval and cron trigger in one payload never crosses the preload boundary.
    expect(() =>
      preloadGate("updateSchedule", { ...withMode, everyMs: 90_000, cronExpression: "30 2 * * *", timezone: "UTC" }),
    ).toThrow(/invalid/u);
  });
});

describe("cron round-trip on edit", () => {
  const cronRow = (expression: string): ScheduleGuiRowDto => ({
    ...initialRow,
    trigger: { kind: "cron", everyMs: null, expression, timezone: "Asia/Shanghai", summary: expression },
  });

  it("parses the builder's own shapes and refuses anything the calendar cannot represent", () => {
    expect(parseCronCalendar("30 2 * * *")).toEqual({ frequency: "daily", time: "02:30", weekdays: [] });
    expect(parseCronCalendar("30 2 * * 1,3,0")).toEqual({
      frequency: "weekly",
      time: "02:30",
      weekdays: [1, 3, 0],
    });
    expect(parseCronCalendar("*/5 * * * *")).toBeNull();
    expect(parseCronCalendar("30 2 1 * *")).toBeNull();
    expect(parseCronCalendar("60 2 * * *")).toBeNull();
    expect(parseCronCalendar("30 2 * * 7")).toBeNull();
    // parse(build(x)) inverts for both shapes the calendar emits.
    for (const built of [
      buildCronExpression("daily", "08:05", new Set()),
      buildCronExpression("weekly", "23:59", new Set([0, 2, 5])),
    ]) {
      const parsed = parseCronCalendar(built!),
        again = buildCronExpression(parsed!.frequency, parsed!.time, new Set(parsed!.weekdays));
      expect(again).toBe(built);
    }
  });

  it("prefills the calendar from a stored builder-shaped cron and resaves it unchanged", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: cronRow("30 2 * * 1,3"),
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    // The cron segment is selected and the stored expression/timezone are prefilled.
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="schedule-form-trigger-cron"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.querySelector<HTMLInputElement>('[data-testid="schedule-form-cron-time"]')?.value).toBe("02:30");
    expect(container.querySelector<HTMLInputElement>('[data-testid="schedule-form-cron-timezone"]')?.value).toBe(
      "Asia/Shanghai",
    );
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({ mode: "detect", cronExpression: "30 2 * * 1,3", timezone: "Asia/Shanghai" });
    expect(payload).not.toHaveProperty("everyMs");
  });

  it("carries a calendar-unrepresentable stored expression verbatim until a calendar control is touched", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: cronRow("*/5 * * * *"),
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cronExpression: "*/5 * * * *" }));
    onSubmit.mockClear();
    // Touching the calendar hands the expression back to the builder.
    await setValue(container, "schedule-form-cron-time", "09:15");
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ cronExpression: "15 9 * * *" }));
  });

  it("keeps a stored model that the instance no longer lists instead of silently clearing it", async () => {
    const onSubmit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ScheduleFormDialog, {
          options,
          scheduleIds: [],
          initial: { ...initialRow, target: { ...initialRow.target, model: "gpt-5.6-max" } },
          busy: false,
          error: null,
          onCancel: () => undefined,
          onSubmit,
        }),
      );
    });
    mounted.push({ root, container });
    const modelSelect = container.querySelector<HTMLSelectElement>('[data-testid="schedule-form-model"]');
    expect(modelSelect?.value).toBe("gpt-5.6-max");
    expect([...(modelSelect?.options ?? [])].some((option) => option.value === "gpt-5.6-max")).toBe(true);
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.6-max" }));
  });
});
