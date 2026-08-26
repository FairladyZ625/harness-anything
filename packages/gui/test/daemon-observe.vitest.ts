// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DaemonObserveView } from "../src/renderer/views/DaemonObserveView.tsx";
import {
  applyObserveTailError,
  applyObserveTailPage,
  filterObserveRows,
  initialObserveTail,
  observeTailRequest,
  observeEventRow,
} from "../src/renderer/daemon-observe-model.ts";
import { harnessClient, type SystemRepoRow } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * G6-B daemon 观察页行为判据:
 *  - 模型面:`observe.tail` 三 kind 分页 → 行流;gap 留标记行并重置游标;
 *    unavailable 不冒充空列表;过滤命中行文本与悬停 detail(payload 内文)。
 *  - 视图面:暂停停发请求、续跑恢复;过滤即时收窄;repo-log ↔ daemon-log
 *    切换发对应 kind;unavailable/gap 横幅给出机器原因;实体 chip 以
 *    repo 作用域引用回 App(跨仓跳转由既有导航处理)。
 * 自动尾随滚动与「回到底部」是像素级行为,由 Electron 亲验截图覆盖,不在 DOM 断言里拼凑。
 */

const REPO_ID = "g6b-probe",
  AT = "2026-08-26T00:00:00.000Z",
  TASK_ID = "task_g6b0001",
  DECISION_ID = "dec_g6b0002",
  SESSION_ID = "runtime_g6b0003";

const REPO_ROW: SystemRepoRow = {
  repoId: REPO_ID,
  displayName: "G6B Probe Repo",
  canonicalRoot: "/tmp/g6b-probe",
  authoredBranch: "main",
  registrationState: "enabled",
  cellState: "attached",
  generation: 1,
  queueDepth: 0,
  lockState: "not_applicable",
  recoveryMs: null,
  lastError: null,
  unavailableReason: null,
};

const EVENT_PAGE: ObserveTailRead = {
  schema: "daemon.observe-tail/v3",
  ok: true,
  repoId: REPO_ID,
  mode: "local",
  kind: "events",
  direction: "history",
  status: "ready",
  items: [
    {
      schema: "task-event/v1",
      eventId: "ev-g6b-1",
      workspaceRevision: 11,
      opId: "op-g6b",
      type: "task_created",
      actor: { kind: "agent", id: "agent_g6b" },
      source: { channel: "cli" },
      occurredAt: AT,
      taskId: TASK_ID,
      payload: { task: { title: "G6B 观察页探针任务" } },
    },
    {
      schema: "decision-event/v1",
      eventId: "ev-g6b-2",
      workspaceRevision: 12,
      opId: "op-g6b",
      type: "decision_proposed",
      actor: { kind: "agent", id: "agent_g6b" },
      source: { channel: "cli" },
      occurredAt: AT,
      decisionId: DECISION_ID,
      payload: { title: "G6B 探针决策" },
    },
    {
      schema: "agent-runtime-event/v1",
      eventId: "ev-g6b-3",
      workspaceRevision: 13,
      opId: "op-g6b",
      type: "runtime_session_started",
      actor: { kind: "agent", id: "agent_g6b" },
      source: { channel: "cli" },
      occurredAt: AT,
      payload: { runtimeSessionId: SESSION_ID },
    },
  ],
  historyCursor: { kind: "events", revision: 11 },
  liveCursor: { kind: "events", revision: 13 },
  sourceCursor: { kind: "events", revision: 13 },
  done: true,
};

function logPage(kind: "repo-log" | "daemon-log"): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: REPO_ID,
    mode: "local",
    kind,
    direction: "history",
    status: "ready",
    items: [
      {
        schema: kind === "repo-log" ? "daemon-request-log/v1" : "daemon-conn-log/v1",
        at: AT,
        method: "repo.tasks.list",
        event: "request",
        ok: true,
        durationMs: 4,
      },
    ],
    historyCursor: { kind, fileId: "file-g6b", offset: 0 },
    liveCursor: { kind, fileId: "file-g6b", offset: 88 },
    sourceCursor: { kind, fileId: "file-g6b", offset: 88 },
    done: true,
  };
}

setActiveLocale("zh-CN");

const mounted: { root: Root; container: HTMLElement }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

async function typeInto(field: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mountObserve(props: {
  readonly repoId?: string;
  readonly onNavigateEntity?: (ref: string) => void;
}): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(DaemonObserveView, {
        repoId: props.repoId ?? REPO_ID,
        repos: [REPO_ROW],
        onBack: () => undefined,
        onNavigateEntity: props.onNavigateEntity ?? (() => undefined),
      }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

afterEach(() => {
  while (mounted.length > 0) {
    const { root, container } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
  vi.restoreAllMocks();
});

describe("G6-B observe 模型:分页 → 行流", () => {
  it("事件页产出带实体引用的行,按 eventId 去重不因重放翻倍", () => {
    const first = applyObserveTailPage(initialObserveTail(), EVENT_PAGE),
      replayed = applyObserveTailPage(first, EVENT_PAGE);
    expect(first.rows).toHaveLength(3);
    expect(first.status).toBe("live");
    expect(first.caughtUp).toBe(true);
    expect(replayed.rows).toHaveLength(3);
    expect(first.rows[0]!.refs.map((chip) => chip.ref)).toEqual([`task/${TASK_ID}`]);
    expect(first.rows[1]!.refs.map((chip) => chip.ref)).toEqual([`decision/${DECISION_ID}`]);
    expect(first.rows[2]!.refs.map((chip) => chip.ref)).toEqual([`session/${SESSION_ID}`]);
  });

  it("日志页产出方法行,repo-log 与 daemon-log 同一形状", () => {
    for (const kind of ["repo-log", "daemon-log"] as const) {
      const state = applyObserveTailPage(initialObserveTail(), logPage(kind));
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]!.type).toBe("repo.tasks.list");
      expect(state.rows[0]!.text).toBe("4ms");
      expect(state.rows[0]!.ok).toBe(true);
      expect(state.liveCursor).toEqual({ kind, fileId: "file-g6b", offset: 88 });
      expect(state.historyCursor).toEqual({ kind, fileId: "file-g6b", offset: 0 });
    }
  });

  it("history gap 在流顶留标记并停止向更老的保留集翻页", () => {
    const seeded = applyObserveTailPage(initialObserveTail(), EVENT_PAGE),
      gapped = applyObserveTailPage(seeded, {
        schema: "daemon.observe-tail/v3",
        ok: true,
        repoId: REPO_ID,
        mode: "local",
        kind: "repo-log",
        direction: "history",
        status: "gap",
        items: [],
        historyCursor: null,
        liveCursor: null,
        sourceCursor: null,
        done: false,
        gap: { reason: "cursor-file-not-retained", requestedFileId: "file-gone" },
      });
    expect(gapped.status).toBe("gap");
    expect(gapped.historyCursor).toBeNull();
    expect(gapped.rows).toHaveLength(4);
    expect(gapped.rows.at(0)!.gapMarker).toEqual({ reason: "cursor-file-not-retained", requestedFileId: "file-gone" });
  });

  it("unavailable 保留机器原因,不以空列表冒充追平", () => {
    const state = applyObserveTailPage(initialObserveTail(), {
      schema: "daemon.observe-tail/v3",
      ok: true,
      repoId: REPO_ID,
      mode: "remote-edge",
      kind: "events",
      direction: "history",
      status: "unavailable",
      items: [],
      historyCursor: null,
      liveCursor: null,
      sourceCursor: null,
      done: false,
      unavailable: { reason: "edge-mirror-has-no-events", centerRevision: 42 },
    });
    expect(state.status).toBe("unavailable");
    expect(state.unavailable).toEqual({ reason: "edge-mirror-has-no-events", centerRevision: 42 });
    expect(state.rows).toHaveLength(0);
    const errored = applyObserveTailError(state, "socket gone");
    expect(errored.status).toBe("error");
    expect(errored.error).toBe("socket gone");
  });

  it("过滤命中行文本、实体引用与悬停 detail(payload 内文仍可检索)", () => {
    const state = applyObserveTailPage(initialObserveTail(), EVENT_PAGE),
      rows = state.rows;
    expect(filterObserveRows(rows, "探针决策")).toHaveLength(1);
    expect(filterObserveRows(rows, DECISION_ID)).toHaveLength(1);
    // 文本列不渲染 payload JSON(G10 不变量),但关键字仍要能命中悬停 detail。
    expect(filterObserveRows(rows, "runtime_session_started")).toHaveLength(1);
    expect(filterObserveRows(rows, "不存在的关键字")).toHaveLength(0);
  });

  it("历史页插到顶部且 live follow 追加到底部,不删除已加载历史", () => {
    const event = (revision: number) => ({
        ...(EVENT_PAGE.items[0] as object),
        eventId: `ev-g6b-${revision}`,
        workspaceRevision: revision,
      }),
      latest = applyObserveTailPage(initialObserveTail(), EVENT_PAGE),
      withHistory = applyObserveTailPage(latest, {
        ...EVENT_PAGE,
        items: [event(9), event(10)] as never,
        historyCursor: { kind: "events", revision: 9 },
        liveCursor: { kind: "events", revision: 10 },
        done: false,
      }),
      followed = applyObserveTailPage(withHistory, {
        ...EVENT_PAGE,
        direction: "follow",
        items: [event(14)] as never,
        historyCursor: null,
        liveCursor: { kind: "events", revision: 14 },
        sourceCursor: { kind: "events", revision: 14 },
        done: true,
      });
    expect(withHistory.rows.map((row) => row.revision)).toEqual([9, 10, 11, 12, 13]);
    expect(followed.rows.map((row) => row.revision)).toEqual([9, 10, 11, 12, 13, 14]);
    expect(followed.historyCursor).toEqual({ kind: "events", revision: 9 });
    expect(followed.liveCursor).toEqual({ kind: "events", revision: 14 });
  });

  it("事件行摘要不把 payload JSON 倒进文本列,实体事件只给 kind", () => {
    const entity = observeEventRow({
      schema: "entity-event/v1",
      eventId: "ev-g6b-entity",
      workspaceRevision: 20,
      opId: "op-g6b",
      type: "entity_upserted",
      actor: { kind: "agent", id: "agent_g6b" },
      source: { channel: "cli" },
      occurredAt: AT,
      payload: { entityKind: "agent", entityId: "agent_g6b" },
    } as never);
    expect(entity.text).toBe("agent");
    expect(entity.text).not.toContain("entityId");
    expect(entity.detail).toContain("agent_g6b");
  });

  it("请求组装显式区分反向 history 与正向 follow", () => {
    expect(observeTailRequest(REPO_ID, "repo-log", "history", { kind: "repo-log", fileId: "f", offset: 3 })).toEqual({
      repoId: REPO_ID,
      kind: "repo-log",
      direction: "history",
      cursor: { kind: "repo-log", fileId: "f", offset: 3 },
    });
    expect(observeTailRequest(REPO_ID, "events", "history", null)).toEqual({
      repoId: REPO_ID,
      kind: "events",
      direction: "history",
    });
    expect(observeTailRequest(REPO_ID, "events", "follow", { kind: "events", revision: 13 })).toEqual({
      repoId: REPO_ID,
      kind: "events",
      direction: "follow",
      cursor: { kind: "events", revision: 13 },
    });
    expect(observeTailRequest(REPO_ID, "events", "follow", { kind: "daemon-log", fileId: "f", offset: 3 })).toEqual({
      repoId: REPO_ID,
      kind: "events",
      direction: "history",
    });
  });
});

describe("G6-B observe 视图:两栏实况", () => {
  function mockTail(pages: {
    readonly events?: readonly ObserveTailRead[];
    readonly "repo-log"?: readonly ObserveTailRead[];
    readonly "daemon-log"?: readonly ObserveTailRead[];
  }) {
    const calls: string[] = [];
    vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => {
      const { kind, direction } = payload as {
        readonly kind: "events" | "repo-log" | "daemon-log";
        readonly direction: "history" | "follow";
      };
      calls.push(kind);
      const script = pages[kind] ?? [];
      const page = (script[Math.min(calls.filter((call) => call === kind).length - 1, script.length - 1)] ??
        logPage("repo-log")) as ObserveTailRead;
      return direction === "follow"
        ? ({ ...page, direction, items: [], historyCursor: null, done: true } as ObserveTailRead)
        : page;
    });
    return calls;
  }

  it("挂载即读三 kind 可用面:事件行与日志行渲染,实体 chip 带 repo 作用域跳转", async () => {
    const calls = mockTail({ events: [EVENT_PAGE], "repo-log": [logPage("repo-log")] }),
      navigated: string[] = [];
    const container = await mountObserve({ onNavigateEntity: (ref) => navigated.push(ref) });
    expect(calls).toContain("events");
    expect(calls).toContain("repo-log");
    expect(container.querySelectorAll('[data-testid="observe-row"]').length).toBeGreaterThanOrEqual(4);
    const chip = container.querySelector('[data-testid="observe-pane-events"] [data-testid="observe-row"] button');
    expect(chip).not.toBeNull();
    await act(async () => {
      chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(navigated).toEqual([`repo/${REPO_ID}/task/${TASK_ID}`]);
  });

  it("事件栏触顶用 historyCursor 请求上一页并把旧行插到顶部", async () => {
    const payloads: unknown[] = [],
      older = {
        ...EVENT_PAGE,
        items: [
          {
            ...(EVENT_PAGE.items[0] as object),
            eventId: "ev-g6b-old",
            workspaceRevision: 10,
          },
        ],
        historyCursor: { kind: "events" as const, revision: 10 },
        liveCursor: { kind: "events" as const, revision: 10 },
        done: true,
      } satisfies ObserveTailRead;
    vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => {
      payloads.push(payload);
      if (payload.kind === "events") {
        if (payload.direction === "history" && payload.cursor) return older;
        if (payload.direction === "follow")
          return { ...EVENT_PAGE, direction: "follow", items: [], historyCursor: null, done: true };
        return { ...EVENT_PAGE, done: false };
      }
      const page = logPage(payload.kind);
      return payload.direction === "follow"
        ? { ...page, direction: "follow", items: [], historyCursor: null, done: true }
        : page;
    });
    const container = await mountObserve({}),
      body = container.querySelector('[data-testid="observe-body-events"]') as HTMLDivElement;
    Object.defineProperties(body, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    body.scrollTop = 0;
    await act(async () => {
      body.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(payloads).toContainEqual({
      repoId: REPO_ID,
      kind: "events",
      direction: "history",
      cursor: { kind: "events", revision: 11 },
    });
    const revisions = Array.from(
      container.querySelectorAll('[data-testid="observe-pane-events"] [data-testid="observe-row"]'),
      (row) => row.textContent,
    );
    expect(revisions[0]).toContain("#10");
  });

  it("暂停停发 tail 请求,续跑立即恢复读取", async () => {
    const calls = mockTail({ events: [EVENT_PAGE], "repo-log": [logPage("repo-log")] });
    const container = await mountObserve({}),
      eventsCalls = () => calls.filter((kind) => kind === "events").length,
      settle = (ms: number) =>
        act(async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, ms);
          });
        }),
      pauseButton = () => container.querySelector('[data-testid="observe-pause-events"]') as HTMLButtonElement;
    // 追平后轮询间隔 1s:先跨过一个完整间隔证明循环在滚,再暂停跨间隔证明真的停发。
    await settle(1_300);
    expect(eventsCalls()).toBeGreaterThanOrEqual(2);
    await act(async () => {
      pauseButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(pauseButton().getAttribute("aria-pressed")).toBe("true");
    await settle(1_500);
    const frozen = eventsCalls();
    expect(frozen).toBeGreaterThanOrEqual(2);
    await act(async () => {
      pauseButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await settle(50);
    expect(eventsCalls()).toBeGreaterThan(frozen);
  });

  it("关键字过滤即时收窄两栏可见行", async () => {
    mockTail({ events: [EVENT_PAGE], "repo-log": [logPage("repo-log")] });
    const container = await mountObserve({});
    const filter = container.querySelector('[data-testid="observe-filter-events"]') as HTMLInputElement;
    await typeInto(filter, "探针决策");
    const visible = container.querySelectorAll('[data-testid="observe-pane-events"] [data-testid="observe-row"]');
    expect(visible).toHaveLength(1);
    expect(visible[0]!.textContent).toContain(DECISION_ID);
  });

  it("repo-log ↔ daemon-log 切换:右栏改发对应 kind,daemon-log 标注全局", async () => {
    const calls = mockTail({
      events: [EVENT_PAGE],
      "repo-log": [logPage("repo-log")],
      "daemon-log": [logPage("daemon-log")],
    });
    const container = await mountObserve({});
    expect(calls).not.toContain("daemon-log");
    await act(async () => {
      (container.querySelector('[data-testid="observe-kind-daemon-log"]') as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    expect(calls).toContain("daemon-log");
    const tip = container.querySelector('[data-testid="observe-kind-daemon-log"]') as HTMLButtonElement;
    expect(tip.getAttribute("data-tip")).toContain("全局");
  });

  it("unavailable 与 gap 按机器原因显式呈现,不显示空列表冒充", async () => {
    mockTail({
      events: [
        {
          schema: "daemon.observe-tail/v3",
          ok: true,
          repoId: REPO_ID,
          mode: "remote-edge",
          kind: "events",
          direction: "history",
          status: "unavailable",
          items: [],
          historyCursor: null,
          liveCursor: null,
          sourceCursor: null,
          done: false,
          unavailable: { reason: "edge-mirror-has-no-events", centerRevision: 7 },
        },
      ],
      "repo-log": [
        {
          schema: "daemon.observe-tail/v3",
          ok: true,
          repoId: REPO_ID,
          mode: "local",
          kind: "repo-log",
          direction: "history",
          status: "gap",
          items: [],
          historyCursor: null,
          liveCursor: null,
          sourceCursor: null,
          done: false,
          gap: { reason: "cursor-offset-out-of-range", requestedFileId: "file-rotated" },
        },
      ],
    });
    const container = await mountObserve({});
    const unavailable = container.querySelector('[data-testid="observe-unavailable-events"]');
    expect(unavailable?.textContent).toContain("edge");
    expect(container.querySelector('[data-testid="observe-empty-events"]')).toBeNull();
    const gap = container.querySelector('[data-testid="observe-gap-repo-log"]');
    expect(gap?.textContent).toContain("file-rotated");
    expect(container.querySelector('[data-testid="observe-empty-repo-log"]')).toBeNull();
  });
});
