// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readHomeOverview } from "../src/home/home-overview-read.ts";
import { validateHomeOverviewResult } from "../src/home/home-overview-validation.ts";
import { consumeKnownError } from "@harness-anything/kernel";
import type { DaemonHostRegistryContext } from "../src/daemon-host-open.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";
import type { RepoCell, RepoCellStatus } from "../src/repo-cell-types.ts";

function createRepoRow(
  repoId: string,
  options: { displayName?: string; mode?: "local" | "remote-edge"; state?: "enabled" | "disabled" } = {},
) {
  return {
    repoId,
    displayName: options.displayName ?? repoId,
    canonicalRoot: `/tmp/${repoId}`,
    authoredBranch: "main",
    mode: options.mode ?? "local",
    connectionId: "local",
    state: options.state ?? "enabled",
    registeredAt: "2026-09-01T00:00:00.000Z",
  };
}

function createRegistry(repos: readonly ReturnType<typeof createRepoRow>[]) {
  return {
    schema: "harness-daemon-registry/v2",
    connections: [{ id: "local", kind: "local", displayName: "This device", state: "enabled" }],
    repos,
  };
}

test("home overview: aggregates repos, calculates 3 numbers, top matters and handles quiet/offline states", async () => {
  const tempUserRoot = path.join(tmpdir(), `ha-home-test-${Date.now()}`);
  mkdirSync(tempUserRoot, { recursive: true });

  const registryData = createRegistry([
    createRepoRow("repo-active", { displayName: "Active Repo" }),
    createRepoRow("repo-adjudication", { displayName: "Adjudication Repo" }),
    createRepoRow("repo-quiet", { displayName: "Quiet Repo" }),
    createRepoRow("repo-offline", { displayName: "Offline Edge Repo", mode: "remote-edge" }),
    createRepoRow("repo-disabled", { displayName: "Disabled Repo", state: "disabled" }),
  ]);
  writeFileSync(path.join(tempUserRoot, "registry.json"), JSON.stringify(registryData, null, 2));

  const cells = new Map<string, RepoCell>();
  const warming = new Map<string, RepoCellStatus>();
  const unavailable = new Map<string, RepoCellStatus>();

  // Active repo mock cell
  const readPayloads: { method: string; payload: unknown }[] = [];
  const activeCell: Partial<RepoCell> = {
    status: () => ({ state: "attached" }) as RepoCellStatus,
    read: async (method: string, payload: unknown) => {
      readPayloads.push({ method, payload });
      if (method === "repo.agenda.read") {
        return {
          schema: "daemon.agenda/v1",
          todos: [],
          ok: true,
          awaitingYou: [
            {
              relationId: "rel-1",
              sourceRef: "task/task_123",
              title: "待确认设计方案",
              question: "需要你确认主页布局",
            },
          ],
          awaitingRework: [],
          awaitingAdjudication: [],
          underReview: [],
        } as any;
      }
      if (method === "repo.projection.read") {
        return {
          ok: true,
          projection: {
            groups: [
              {
                key: "group-1",
                label: "后台索引重建",
                runningCount: 1,
                latestStatus: "running",
                latestActivityAt: new Date().toISOString(),
                latestRound: { agentName: "Worker-1" },
              },
            ],
          },
        } as any;
      }
      if (method === "repo.tasks.list") {
        return {
          schema: "daemon.tasks-list/v1",
          ok: true,
          rows: [
            {
              taskId: "task_789",
              updatedAt: new Date().toISOString(),
              snapshot: {
                task: { title: "多窗口历史已合入", status: "done" },
              },
            },
          ],
        } as any;
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  cells.set("repo-active", activeCell as RepoCell);

  // 只有待签发桶的仓:计数与事项必须同口径露面,不得「等你 N 却暂无要紧事项」。
  const adjudicationCell: Partial<RepoCell> = {
    status: () => ({ state: "attached" }) as RepoCellStatus,
    read: async (method: string) => {
      if (method === "repo.agenda.read") {
        return {
          schema: "daemon.agenda/v1",
          todos: [],
          ok: true,
          awaitingYou: [],
          awaitingRework: [],
          awaitingAdjudication: [{ taskId: "task_456", title: "索引优化执行" }],
          underReview: [],
        } as any;
      }
      if (method === "repo.projection.read") return { ok: true, projection: { groups: [] } } as any;
      if (method === "repo.tasks.list") return { schema: "daemon.tasks-list/v1", ok: true, rows: [] } as any;
      throw new Error(`Unexpected method ${method}`);
    },
  };
  cells.set("repo-adjudication", adjudicationCell as RepoCell);

  // Quiet repo mock cell
  const quietCell: Partial<RepoCell> = {
    status: () => ({ state: "attached" }) as RepoCellStatus,
    read: async (method: string) => {
      if (method === "repo.agenda.read") {
        return {
          schema: "daemon.agenda/v1",
          todos: [],
          ok: true,
          awaitingYou: [],
          awaitingRework: [],
          awaitingAdjudication: [],
          underReview: [],
        } as any;
      }
      if (method === "repo.projection.read") {
        return { ok: true, projection: { groups: [] } } as any;
      }
      if (method === "repo.tasks.list") {
        return { schema: "daemon.tasks-list/v1", ok: true, rows: [] } as any;
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };
  cells.set("repo-quiet", quietCell as RepoCell);

  // Offline repo mock status in unavailable map
  unavailable.set("repo-offline", {
    state: "unavailable",
    lastError: "边缘节点未连接 (replica_unavailable)",
  } as RepoCellStatus);

  const mockContext = {
    input: { userRoot: tempUserRoot },
    cells,
    warming,
    unavailable,
  } as unknown as DaemonHostRegistryContext;

  const auth = {
    kind: "local",
    local: true,
  } as unknown as DaemonAuthenticationContext;

  try {
    const result = await readHomeOverview({ context: mockContext, auth });
    assert.equal(result.schema, "daemon.gui.home-overview/v1");
    assert.equal(result.ok, true);
    assert.equal(result.repos.length, 5);

    const validationErrors = validateHomeOverviewResult(result);
    assert.deepEqual(validationErrors, []);

    // 1. Active Repo Assertions
    const activeOverview = result.repos.find((r) => r.repoId === "repo-active")!;
    assert.equal(activeOverview.status, "online");
    assert.equal(activeOverview.cellState, "attached");
    assert.equal(activeOverview.waitingCount, 1);
    assert.equal(activeOverview.runningCount, 1);
    assert.equal(activeOverview.deliveredCount, 1);
    assert.equal(activeOverview.isQuiet, false);
    assert.equal(activeOverview.topMatters.length, 3);
    assert.equal(activeOverview.topMatters[0].tag, "等你");
    assert.match(activeOverview.topMatters[0].text, /需要你确认主页布局/);
    assert.equal(activeOverview.topMatters[1].tag, "在跑");
    assert.equal(activeOverview.topMatters[2].tag, "刚交付");

    // 读面契约:投影走 runtime-session-groups(词表名),交付走服务端 updatedAfter 窄化。
    const projectionPayload = readPayloads.find((call) => call.method === "repo.projection.read");
    assert.equal((projectionPayload?.payload as { name?: string })?.name, "runtime-session-groups");
    const taskListPayload = readPayloads.find((call) => call.method === "repo.tasks.list");
    assert.equal((taskListPayload?.payload as { status?: string })?.status, "done");
    assert.match(String((taskListPayload?.payload as { updatedAfter?: string })?.updatedAfter), /^\d{4}-/);

    // 2. 只有待签发桶的仓:计数 1 且事项同口径露面
    const adjudicationOverview = result.repos.find((r) => r.repoId === "repo-adjudication")!;
    assert.equal(adjudicationOverview.status, "online");
    assert.equal(adjudicationOverview.waitingCount, 1);
    assert.equal(adjudicationOverview.topMatters.length, 1);
    assert.equal(adjudicationOverview.topMatters[0].tag, "待签发");
    assert.equal(adjudicationOverview.topMatters[0].taskId, "task_456");

    // 3. Quiet Repo Assertions
    const quietOverview = result.repos.find((r) => r.repoId === "repo-quiet")!;
    assert.equal(quietOverview.status, "online");
    assert.equal(quietOverview.cellState, "attached");
    assert.equal(quietOverview.waitingCount, 0);
    assert.equal(quietOverview.runningCount, 0);
    assert.equal(quietOverview.deliveredCount, 0);
    assert.equal(quietOverview.isQuiet, true);
    assert.equal(quietOverview.topMatters[0].tag, "就绪");

    // 4. Offline Repo Assertions (never quiet, counts null, clear reason)
    const offlineOverview = result.repos.find((r) => r.repoId === "repo-offline")!;
    assert.equal(offlineOverview.status, "unavailable");
    assert.equal(offlineOverview.cellState, "unavailable");
    assert.equal(offlineOverview.waitingCount, null);
    assert.equal(offlineOverview.runningCount, null);
    assert.equal(offlineOverview.deliveredCount, null);
    assert.equal(offlineOverview.isQuiet, false);
    assert.equal(offlineOverview.unavailableReason, "边缘节点未连接 (replica_unavailable)");
    assert.equal(offlineOverview.topMatters[0].tag, "不可达");

    // 5. Disabled Repo Assertions
    const disabledOverview = result.repos.find((r) => r.repoId === "repo-disabled")!;
    assert.equal(disabledOverview.status, "offline");
    assert.equal(disabledOverview.registrationState, "disabled");
  } finally {
    try {
      rmSync(tempUserRoot, { recursive: true, force: true });
    } catch (error) {
      consumeKnownError(error);
    }
  }
});

test("home overview: timeout gracefully degrades slow repo without blocking others", async () => {
  const tempUserRoot = path.join(tmpdir(), `ha-home-timeout-test-${Date.now()}`);
  mkdirSync(tempUserRoot, { recursive: true });

  const registryData = createRegistry([createRepoRow("repo-slow", { displayName: "Slow Repo" })]);
  writeFileSync(path.join(tempUserRoot, "registry.json"), JSON.stringify(registryData, null, 2));

  const cells = new Map<string, RepoCell>();
  const slowCell: Partial<RepoCell> = {
    status: () => ({ state: "attached" }) as RepoCellStatus,
    read: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {} as any;
    },
  };
  cells.set("repo-slow", slowCell as RepoCell);

  const mockContext = {
    input: { userRoot: tempUserRoot },
    cells,
    warming: new Map(),
    unavailable: new Map(),
  } as unknown as DaemonHostRegistryContext;

  const auth = { kind: "local", local: true } as unknown as DaemonAuthenticationContext;

  try {
    const result = await readHomeOverview({ context: mockContext, auth, timeoutMs: 100 });
    assert.equal(result.ok, true);
    const slowRepo = result.repos[0];
    assert.equal(slowRepo.status, "unavailable");
    assert.match(slowRepo.unavailableReason!, /超时/);
    assert.equal(slowRepo.waitingCount, null);
    assert.equal(slowRepo.isQuiet, false);
  } finally {
    try {
      rmSync(tempUserRoot, { recursive: true, force: true });
    } catch (error) {
      consumeKnownError(error);
    }
  }
});
