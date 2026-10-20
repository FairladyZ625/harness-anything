// harness-test-tier: fast
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type {
  AgentRuntimeEventsResult,
  AgentRuntimeOverviewResult,
  AgentRuntimeSessionGroupsResult,
  AgentRuntimeSessionResult,
} from "@harness-anything/daemon/protocol";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../src/renderer/api-client-invoke.ts", () => ({ invoke: invokeMock }));

import {
  cachedSessionEventTimeline,
  mergeAgentRuntimeEventPages,
  pollSessionEventsOnce,
  runtimeQueryKeys,
} from "../src/renderer/agent-runtime-client.ts";

/**
 * 增量事件流写缓存(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3):游标只取新事件、按 cursor
 * 去重合并,并就地补丁 session/overview/groups 缓存——不 invalidate,未命中保持原引用。
 */

const REPO = "repo-1",
  RS = "rs-1";

const eventDto = (revision: number, type: string, occurredAt: string) => ({
  cursor: `lifecycle:${revision}`,
  runtimeSessionId: RS,
  type,
  occurredAt,
});

const eventsPage = (
  events: readonly ReturnType<typeof eventDto>[],
  source: number,
  done = true,
): AgentRuntimeEventsResult => ({
  ok: true,
  runtimeSessionId: RS,
  events: [...events],
  cursor:
    done || events.length === 0
      ? `lifecycle:${source}`
      : `lifecycle:${Number(events.at(-1)!.cursor.slice("lifecycle:".length))}`,
  sourceCursor: `lifecycle:${source}`,
  done,
});

const sessionResult = (): AgentRuntimeSessionResult => ({
  ok: true,
  status: "ready",
  session: {
    runtimeSessionId: RS,
    providerSessionId: null,
    instanceId: "inst-1",
    installationId: "install-1",
    kindId: "claude",
    definitionSnapshotRef: "artifact:runtime-definition/test",
    definitionSnapshot: null,
    definitionSnapshotPersisted: true,
    liveness: "unknown",
    semanticState: "unavailable",
    attachCapability: "supported",
    streamCursor: null,
    associations: [{ taskId: "task-a", executionId: "exec-1", holder: null, lease: null }],
    activity: {
      lastObservedAt: "2026-10-20T11:00:00.000Z",
      outcome: null,
      exitCode: null,
      resultRef: null,
      missingEvidence: null,
    },
  },
  result: null,
  settlement: null,
  watermark: 1,
  sourceRevision: 1,
});

const overviewResult = (): AgentRuntimeOverviewResult => ({
  ok: true,
  status: "ready",
  installations: [],
  instances: [],
  sessions: [sessionResult().session],
  watermark: 1,
  sourceRevision: 1,
});

const groupsResult = (): AgentRuntimeSessionGroupsResult => ({
  ok: true,
  status: "ready",
  groups: [
    {
      key: "task-a",
      kind: "task",
      label: "Task A",
      taskId: "task-a",
      latestStatus: "running",
      latestActivityAt: "2026-10-20T11:00:00.000Z",
      runningCount: 1,
      sessionCount: 1,
      roundCount: 1,
      latestRound: {
        runtimeSessionId: RS,
        dispatchId: "d-1",
        agentName: null,
        instanceId: "inst-1",
        status: "running",
        startedAt: "2026-10-20T11:00:00.000Z",
      },
    },
  ],
  sessionAgents: [],
  totals: { groups: 1, sessions: 1 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
});

beforeEach(() => {
  invokeMock.mockReset();
});

describe("事件页纯合并", () => {
  it("无旧页直接采用新页拷贝;重叠页按 cursor 去重、按 revision 升序,元数据以新页为准", () => {
    const first = eventsPage([eventDto(1, "runtime_session_started", "2026-10-20T11:00:00.000Z")], 3, false),
      standalone = mergeAgentRuntimeEventPages(undefined, first);
    expect(standalone.events).toEqual(first.events);
    expect(standalone).not.toBe(first);

    const second = eventsPage(
      [
        eventDto(3, "runtime_session_outcome_observed", "2026-10-20T11:02:00.000Z"),
        eventDto(1, "runtime_session_started", "2026-10-20T11:00:00.000Z"),
      ],
      3,
    );
    const merged = mergeAgentRuntimeEventPages(first, second);
    expect(merged.events.map((event) => event.cursor)).toEqual(["lifecycle:1", "lifecycle:3"]);
    expect(merged.cursor).toBe("lifecycle:3");
    expect(merged.done).toBe(true);
  });
});

describe("pollSessionEventsOnce 增量写缓存", () => {
  it("首轮从 lifecycle:0 拉全量,合并进 events 键,并就地补丁 session/overview/groups", async () => {
    const queryClient = new QueryClient(),
      session = sessionResult(),
      overview = overviewResult(),
      groups = groupsResult();
    queryClient.setQueryData(runtimeQueryKeys.session(REPO, RS), session);
    queryClient.setQueryData(runtimeQueryKeys.overviewAll(REPO), overview);
    queryClient.setQueryData(runtimeQueryKeys.sessionGroupsAll(REPO), groups);
    invokeMock.mockResolvedValueOnce(
      eventsPage([eventDto(1, "runtime_session_started", "2026-10-20T11:01:00.000Z")], 2, false),
    );

    const merged = await pollSessionEventsOnce(queryClient, REPO, RS);

    expect(invokeMock.mock.calls[0]![1]).toMatchObject({
      repoId: REPO,
      runtimeSessionId: RS,
      afterCursor: "lifecycle:0",
    });
    expect(queryClient.getQueryData<AgentRuntimeEventsResult>(runtimeQueryKeys.events(REPO, RS))).toEqual(merged);
    // 三个依赖缓存被就地补丁:started → running/live,时间戳推进
    expect(
      queryClient.getQueryData<AgentRuntimeSessionResult>(runtimeQueryKeys.session(REPO, RS))!.session.semanticState,
    ).toBe("running");
    const patchedOverview = queryClient.getQueryData<AgentRuntimeOverviewResult>(runtimeQueryKeys.overviewAll(REPO))!;
    expect(patchedOverview.sessions[0]!.semanticState).toBe("running");
    expect(
      queryClient.getQueryData<AgentRuntimeSessionGroupsResult>(runtimeQueryKeys.sessionGroupsAll(REPO))!.groups[0]!
        .latestActivityAt,
    ).toBe("2026-10-20T11:01:00.000Z");
  });

  it("无新事件且游标未推进时返回缓存原对象,不重写缓存", async () => {
    const queryClient = new QueryClient(),
      cached = eventsPage([eventDto(1, "runtime_session_started", "2026-10-20T11:00:00.000Z")], 1);
    queryClient.setQueryData(runtimeQueryKeys.events(REPO, RS), cached);
    invokeMock.mockResolvedValueOnce(eventsPage([], 1));

    const returned = await pollSessionEventsOnce(queryClient, REPO, RS);

    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ afterCursor: "lifecycle:1" });
    expect(returned).toBe(cached);
    expect(queryClient.getQueryData(runtimeQueryKeys.events(REPO, RS))).toBe(cached);
  });

  it("增量轮只取新事件,历史事件不重复进入缓存", async () => {
    const queryClient = new QueryClient();
    invokeMock.mockResolvedValueOnce(
      eventsPage([eventDto(1, "runtime_session_started", "2026-10-20T11:00:00.000Z")], 2, false),
    );
    await pollSessionEventsOnce(queryClient, REPO, RS);
    invokeMock.mockResolvedValueOnce(
      eventsPage([eventDto(2, "runtime_session_cancelled", "2026-10-20T11:05:00.000Z")], 2),
    );
    await pollSessionEventsOnce(queryClient, REPO, RS);

    expect(invokeMock.mock.calls[1]![1]).toMatchObject({ afterCursor: "lifecycle:1" });
    const merged = queryClient.getQueryData<AgentRuntimeEventsResult>(runtimeQueryKeys.events(REPO, RS))!;
    expect(merged.events.map((event) => event.cursor)).toEqual(["lifecycle:1", "lifecycle:2"]);
    expect(merged.done).toBe(true);
  });

  it("补丁不触碰未命中的缓存:组数组里其它组保持原引用", async () => {
    const queryClient = new QueryClient(),
      groups = {
        ...groupsResult(),
        groups: [
          {
            key: "task-other",
            kind: "task" as const,
            label: "Other",
            taskId: "task-other",
            latestStatus: "running" as const,
            latestActivityAt: "2026-10-20T10:00:00.000Z",
            runningCount: 1,
            sessionCount: 1,
            roundCount: 1,
            latestRound: null,
          },
          ...groupsResult().groups,
        ],
      };
    queryClient.setQueryData(runtimeQueryKeys.sessionGroupsAll(REPO), groups);
    invokeMock.mockResolvedValueOnce(
      eventsPage([eventDto(1, "runtime_session_exited", "2026-10-20T11:03:00.000Z")], 1),
    );

    await pollSessionEventsOnce(queryClient, REPO, RS);

    const patched = queryClient.getQueryData<AgentRuntimeSessionGroupsResult>(runtimeQueryKeys.sessionGroupsAll(REPO))!;
    expect(patched.groups[0]).toBe(groups.groups[0]); // 未命中:同一引用
    expect(patched.groups[1]).not.toBe(groups.groups[1]); // 命中:新对象
    expect(patched.groups[1]!.latestStatus).toBe("ended-indeterminate");
    expect(patched.groups[1]!.runningCount).toBe(0);
  });
});

describe("缓存时间线读取", () => {
  it("从增量缓存派生 lastTurnActivityAt / lastCacheTouchAt;无缓存为 null", async () => {
    const queryClient = new QueryClient();
    expect(cachedSessionEventTimeline(queryClient, REPO, RS)).toEqual({
      lastTurnActivityAt: null,
      lastCacheTouchAt: null,
    });
    invokeMock.mockResolvedValueOnce(
      eventsPage(
        [
          eventDto(1, "runtime_session_started", "2026-10-20T11:00:00.000Z"),
          eventDto(2, "runtime_session_outcome_observed", "2026-10-20T11:04:00.000Z"),
          eventDto(3, "runtime_session_liveness_changed", "2026-10-20T11:05:00.000Z"),
        ],
        3,
      ),
    );
    await pollSessionEventsOnce(queryClient, REPO, RS);
    expect(cachedSessionEventTimeline(queryClient, REPO, RS)).toEqual({
      lastTurnActivityAt: Date.parse("2026-10-20T11:05:00.000Z"),
      lastCacheTouchAt: Date.parse("2026-10-20T11:04:00.000Z"),
    });
  });
});
