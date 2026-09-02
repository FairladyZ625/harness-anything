// harness-test-tier: contract
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENDA_REFRESH_INTERVAL_MS, agendaQuery, readAgenda } from "../src/renderer/agenda-data.ts";
import { harnessClient, type AgendaSuccess } from "../src/renderer/api-client.ts";
import type { AgendaRead } from "../src/api/renderer-dto.ts";

const AT = "2026-08-30T00:00:00.000Z";
const blocking = { state: "clear" as const, blockers: [], warnings: [] };
const row = (taskId: string, pinned = false) => ({
  taskId,
  title: `标题 ${taskId}`,
  status: "active" as const,
  pinned,
  updatedAt: AT,
  leaseExecutionId: null,
  activeExecutionIds: [],
  blockingAssessment: blocking,
});

const page = (over: Partial<AgendaRead> = {}): AgendaSuccess => {
  const full = {
    schema: "daemon.agenda/v1",
    ok: true as const,
    command: "agenda",
    status: "ready" as const,
    inFlight: [],
    awaitingDecision: [],
    waitingOnOthers: [],
    dispatchable: [],
    summary: "在飞线 (0)",
    page: { sourceLimit: 100, cursor: null, nextCursor: null },
    watermark: 3,
    sourceRevision: 3,
    warnings: [],
    ...over,
  };
  return full as unknown as AgendaSuccess;
};

const pages: AgendaSuccess[] = [];
beforeEach(() => {
  pages.length = 0;
  vi.spyOn(harnessClient, "getAgenda").mockImplementation(async (payload) => {
    const requested = pages.shift();
    if (requested === undefined) throw new Error("unexpected agenda read");
    expect(payload.repoId).toBe("repo-a");
    return requested;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("agenda read discipline", () => {
  it("reads exactly one page per refresh and follows the composite cursor until it is exhausted", async () => {
    pages.push(
      page({
        status: "pending",
        dispatchable: [row("task_a"), row("task_b")],
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-next" },
      }),
    );
    const first = await readAgenda("repo-a");
    expect(first.status).toBe("pending");
    expect(first.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b"]);
    expect(first.page.nextCursor).toBe("agenda-next");

    pages.push(
      page({
        dispatchable: [row("task_b"), row("task_c")],
        page: { sourceLimit: 100, cursor: "agenda-next", nextCursor: null },
        watermark: 4,
        sourceRevision: 4,
      }),
    );
    const second = await readAgenda("repo-a", first);
    expect(second.status).toBe("ready");
    // 每 refresh 只发一个请求;合并且按 taskId 去重。
    expect(second.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_a", "task_b", "task_c"]);
    expect(second.watermark).toBe(3);
    expect(second.sourceRevision).toBe(4);

    pages.push(page({ dispatchable: [row("task_z", true)] }));
    const restart = await readAgenda("repo-a", second);
    expect(restart.dispatchable.map(({ taskId }) => taskId)).toEqual(["task_z"]);
  });

  it("reports a pending facet while a page window is still open", async () => {
    pages.push(
      page({
        status: "pending",
        page: { sourceLimit: 100, cursor: null, nextCursor: "agenda-more" },
      }),
    );
    const pending = await readAgenda("repo-a");
    expect(pending.status).toBe("pending");
  });
});

describe("agenda refresh cadence", () => {
  it("polls only to finish an open cursor window; a settled agenda waits for the ledger cut", () => {
    const interval = agendaQuery("repo-a").refetchInterval as (query: {
      readonly state: { readonly data?: Partial<AgendaSuccess> };
    }) => number | false;
    expect(interval({ state: { data: { page: { nextCursor: "c2" } } as Partial<AgendaSuccess> } })).toBe(
      AGENDA_REFRESH_INTERVAL_MS,
    );
    expect(interval({ state: { data: { page: { nextCursor: null } } as Partial<AgendaSuccess> } })).toBe(false);
    expect(interval({ state: {} })).toBe(false);
  });
});
