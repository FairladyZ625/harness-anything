// @vitest-environment happy-dom
import { beforeAll, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PinnedStream } from "../src/renderer/components/overview/PinnedStream.tsx";
import type { AgendaSuccess } from "../src/renderer/api-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const noop = () => {};
const agenda = (patch: Partial<AgendaSuccess> = {}): AgendaSuccess => ({
  ok: true,
  status: "ready",
  inFlight: [],
  pinnedEntities: [],
  pinnedEntityOverflow: 0,
  awaitingRework: [],
  awaitingAdjudication: [],
  underReview: [],
  awaitingDecision: [],
  waitingOnOthers: [],
  dispatchable: [],
  summary: "",
  page: { sourceLimit: 100, cursor: null, nextCursor: null },
  watermark: 12,
  sourceRevision: 12,
  ...patch,
});
const pinnedTask = {
  taskId: "task_pin_a",
  title: "Pinned task",
  status: "active" as const,
  pinned: true,
  updatedAt: "2026-08-30T01:00:00.000Z",
  leaseExecutionId: "execution-a",
  activeExecutionIds: ["execution-a"],
  blockingAssessment: { state: "clear" as const, blockers: [], warnings: [] },
};
const entity = (ref: string, kind: string, status = "proposed") => ({
  ref,
  kind,
  title: `Title of ${ref}`,
  status,
  pinnedAt: "2026-08-30T04:00:00.000Z",
});

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

async function mount(props: Parameters<typeof PinnedStream>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PinnedStream, props));
  });
  return { container, dispose: () => act(() => root.unmount()) };
}

describe("overview pinned stream: per-kind open routing", () => {
  it("opens the task preview drawer for a pinned task", async () => {
    const opened: string[] = [];
    const { container, dispose } = await mount({
      agenda: agenda({ inFlight: [pinnedTask] }),
      onOpenPreview: (id) => opened.push(id),
      onNavigateEntity: noop,
      onSetPin: noop,
    });
    try {
      const button = container.querySelector<HTMLButtonElement>('button[title^="task/task_pin_a"]');
      expect(button).not.toBeNull();
      button!.click();
      expect(opened).toEqual(["task_pin_a"]);
    } finally {
      dispose();
      container.remove();
    }
  });

  it("routes a pinned decision through the entity navigator", async () => {
    const navigated: string[] = [];
    const { container, dispose } = await mount({
      agenda: agenda({ pinnedEntities: [entity("decision/dec_1", "decision", "in_effect")] }),
      onOpenPreview: noop,
      onNavigateEntity: (ref) => navigated.push(ref),
    });
    try {
      const button = container.querySelector<HTMLButtonElement>('button[title^="decision/dec_1"]');
      expect(button).not.toBeNull();
      button!.click();
      expect(navigated).toEqual(["decision/dec_1"]);
    } finally {
      dispose();
      container.remove();
    }
  });

  it("routes a pinned schedule through the entity navigator to the schedules view target", async () => {
    const navigated: string[] = [];
    const { container, dispose } = await mount({
      agenda: agenda({ pinnedEntities: [entity("schedule/nightly", "schedule", "armed")] }),
      onOpenPreview: noop,
      onNavigateEntity: (ref) => navigated.push(ref),
    });
    try {
      const button = container.querySelector<HTMLButtonElement>('button[title^="schedule/nightly"]');
      expect(button).not.toBeNull();
      button!.click();
      expect(navigated).toEqual(["schedule/nightly"]);
      // schedule 用自己的状态词,不套任务生命周期。
      expect(container.textContent).toContain("已布防");
      expect(container.textContent).not.toContain("计划中");
    } finally {
      dispose();
      container.remove();
    }
  });

  it("routes a declared-kind entity when its kind is registered on the read side", async () => {
    const navigated: string[] = [];
    const { container, dispose } = await mount({
      agenda: agenda({ pinnedEntities: [entity("adr/ADR-1", "adr", "current")] }),
      onOpenPreview: noop,
      onNavigateEntity: (ref) => navigated.push(ref),
      declaredKinds: ["adr"],
    });
    try {
      container.querySelector<HTMLButtonElement>('button[title^="adr/ADR-1"]')!.click();
      expect(navigated).toEqual(["adr/ADR-1"]);
    } finally {
      dispose();
      container.remove();
    }
  });

  it("renders a kind with no detail route as plain text, not a fake button", async () => {
    const navigated: string[] = [];
    const { container, dispose } = await mount({
      agenda: agenda({ pinnedEntities: [entity("policy/policy_x", "policy", "current")] }),
      onOpenPreview: noop,
      onNavigateEntity: (ref) => navigated.push(ref),
    });
    try {
      expect(container.querySelector('button[title^="policy/"]')).toBeNull();
      expect(container.textContent).toContain("Title of policy/policy_x");
      // 无去处行的 pin 图标仍是陈述性标记:它不是按钮,文案给出 CLI 解除路径。
      expect(container.querySelector("button[data-testid^='overview-pin-toggle-']")).toBeNull();
    } finally {
      dispose();
      container.remove();
    }
  });

  it("shows the entity's own status word verbatim when the kind has no status vocabulary", () => {
    const markup = renderToStaticMarkup(
      createElement(PinnedStream, {
        agenda: agenda({ pinnedEntities: [entity("policy/policy_x", "policy", "weird-state")] }),
        onOpenPreview: noop,
        onNavigateEntity: noop,
      }),
    );
    expect(markup).toContain("weird-state");
    expect(markup).not.toContain("计划中");
  });
});
