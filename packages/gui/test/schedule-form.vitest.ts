// harness-test-tier: integration
// @vitest-environment happy-dom
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { ScheduleFormDialog, buildCronExpression } from "../src/renderer/components/ScheduleFormDialog.tsx";
import type { ScheduleDefinitionInput } from "../src/renderer/schedules-client.ts";
import type { ScheduleGuiOptionsDto, ScheduleGuiRowDto } from "../../daemon/src/protocol/schedules-gui-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));
afterEach(() => vi.restoreAllMocks());

const mounted: { root: Root; container: HTMLElement }[] = [];

const options: ScheduleGuiOptionsDto = {
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
};

const initialRow: ScheduleGuiRowDto = {
  scheduleId: "heartbeat-probe",
  name: "Heartbeat probe",
  state: "armed",
  definitionResidency: "ledger",
  definitionRevision: 7,
  trigger: { kind: "interval", everyMs: 7_200_000, timezone: null, summary: "every 2h" },
  target: {
    agentId: "probe-agent",
    runtimeInstanceId: "codex-schedule",
    model: "gpt-5.6",
    reasoningEffort: "high",
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
  });

  it("switches to the cron calendar, previews the expression, and blocks the save until interval is restored", async () => {
    const container = await renderForm(initialRow);
    await click(container, "schedule-form-trigger-cron");
    expect(container.querySelector('[data-testid="schedule-form-cron"]')).not.toBeNull();
    await setValue(container, "schedule-form-cron-time", "02:30");
    expect(container.querySelector('[data-testid="schedule-form-cron-expression"]')?.textContent).toContain(
      "30 2 * * *",
    );
    const submit = container.querySelector<HTMLButtonElement>('[data-testid="schedule-form-submit"]');
    expect(submit?.disabled).toBe(true);
    expect(container.textContent).toContain("cron/calendar trigger write path");
    await click(container, "schedule-form-trigger-interval");
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

  it("lets the purpose and routing scaffolding be selected, labeled as not yet persisted", async () => {
    const container = await renderForm(initialRow);
    await click(container, "schedule-form-purpose-remediate");
    expect(
      container
        .querySelector<HTMLButtonElement>('[data-testid="schedule-form-purpose-remediate"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(container.textContent).toContain("mode write path");
    await click(container, "schedule-form-routing-fact");
    expect(container.textContent).toContain("Outcome-routing fields");
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
    await click(container, "schedule-form-submit");
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: "fresh-probe",
        everyMs: 1_800_000,
        mission: "Run the probe {{repo}}.",
      } satisfies Partial<ScheduleDefinitionInput>),
    );
  });
});
