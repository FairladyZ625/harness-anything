// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import {
  liveFloorActionSummary,
  liveFloorAskLanes,
  liveFloorEndedRows,
  liveFloorPipelineGroups,
  liveFloorReportDocPath,
  liveFloorRows,
  readableModelName,
} from "../src/renderer/views/live-floor-model.ts";
import { NO_WORKS, type WorkIndex } from "../src/renderer/model/work-collections.ts";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { readLiveFloorPreferences, writeLiveFloorPreferences } from "../src/renderer/live-floor-preferences.ts";

const session = (patch: Partial<AgentRuntimeSessionDto> = {}): AgentRuntimeSessionDto => ({
  runtimeSessionId: "runtime-live",
  providerSessionId: null,
  instanceId: "instance",
  installationId: "installation",
  kindId: "codex",
  definitionSnapshotRef: "artifact:definition",
  definitionSnapshot: {
    schema: "agent-definition-snapshot/v1",
    configVersion: 1,
    instanceId: "instance",
    installationId: "installation",
    kindId: "codex",
    providerId: "provider",
    model: "openai/gpt-5.6-terra",
    reasoningEffort: null,
    baseUrl: null,
    authMode: "api-key",
  },
  definitionSnapshotPersisted: true,
  liveness: "live",
  semanticState: "running",
  attachCapability: "supported",
  streamCursor: null,
  associations: [{ taskId: "task-1", executionId: "execution-1", holder: null, lease: null }],
  activity: {
    lastObservedAt: "2026-10-21T00:00:00.000Z",
    outcome: null,
    exitCode: null,
    resultRef: null,
    missingEvidence: null,
  },
  ...patch,
});

const dispatch = (patch: Partial<TaskDispatchProjectionRow> = {}): TaskDispatchProjectionRow =>
  ({
    dispatchId: "dispatch-1",
    taskId: "task-1",
    executionId: "execution-1",
    runtimeSessionId: "runtime-live",
    instanceId: "instance",
    attemptGroupId: "attempt",
    attemptIndex: 0,
    provider: { instance: "instance", model: "openai/gpt-5.6-terra" },
    classification: null,
    reason: null,
    fallbackState: null,
    nextDispatchId: null,
    providerSessionId: null,
    eventStreamRef: null,
    startedAt: "2026-10-21T00:00:00.000Z",
    endedAt: null,
    outcome: null,
    status: "running",
    role: "implementation",
    activityStatus: "progressing",
    ...patch,
  }) as TaskDispatchProjectionRow;

const works: WorkIndex = {
  ...NO_WORKS,
  ready: true,
  hasWorks: true,
  workOf: (taskId) => (taskId === "task-1" ? { taskId: "work-1", title: "现场工作" } : null),
};

describe("live floor model", () => {
  it("keeps only live sessions and enriches them from the same dispatch row", () => {
    const rows = liveFloorRows({
      sessions: [session(), session({ runtimeSessionId: "runtime-exited", liveness: "exited" })],
      dispatches: [dispatch()],
      taskTitles: new Map([["task/task-1", "修复现场页面"]]),
      works,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ taskTitle: "修复现场页面", workTitle: "现场工作", role: "implementation" });
  });

  it("labels retry attempts as rework and presents readable model names", () => {
    const rows = liveFloorRows({
      sessions: [session()],
      dispatches: [dispatch({ attemptIndex: 1 })],
      taskTitles: new Map([["task/task-1", "返工"]]),
      works,
    });
    expect(rows[0]?.role).toBe("rework");
    expect(readableModelName("openai/gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(readableModelName('["Deepseek Official","Deepseek V4.1 Flash"]')).toBe("Deepseek V4.1 Flash");
  });

  it("summarizes the latest tool call from existing transcript records", () => {
    expect(
      liveFloorActionSummary([
        {
          kind: "provider_event",
          occurredAt: "2026-10-21T00:01:00.000Z",
          event: { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "rg" }] } },
        },
      ]),
    ).toBe("rg");
  });

  it("maps ended sessions onto their conclusions, with empty reports outranking success", () => {
    const ended = (
        outcome: AgentRuntimeSessionDto["activity"]["outcome"],
        missingEvidence: AgentRuntimeSessionDto["activity"]["missingEvidence"],
      ) =>
        session({
          runtimeSessionId: `runtime-${outcome}-${missingEvidence}`,
          liveness: "exited",
          activity: {
            lastObservedAt: "2026-10-21T08:00:00.000Z",
            outcome,
            exitCode: 0,
            resultRef: null,
            missingEvidence,
          },
        }),
      titles = new Map([["task/task-1", "任务一"]]),
      rows = liveFloorEndedRows({
        sessions: [
          ended("succeeded", null),
          ended("succeeded", "result"),
          ended("stopped", null),
          ended("stopped", "exit-code-and-result"),
        ],
        dispatches: [
          dispatch(),
          dispatch({
            dispatchId: "dispatch-review",
            runtimeSessionId: "runtime-succeeded-null",
            role: "reviewer",
            reportPath: "tasks/task-1/artifacts/reports/dispatch-review.md",
          }),
        ],
        taskTitles: titles,
      });
    // 同一结束时刻按输入序稳定排:评审成功的会话是「评审完成」,缺结果证据的「成功」是空报告。
    expect(rows.map((row) => row.conclusion)).toEqual(["review_done", "empty_report", "interrupted", "empty_report"]);
    expect(rows[0]?.reportPath).toBe("tasks/task-1/artifacts/reports/dispatch-review.md");
  });

  it("buckets pipeline tasks by the daemon delivery stage and keeps off-path rows by status", () => {
    const task = (patch: Partial<TaskRow>): TaskRow =>
      ({
        taskId: patch.taskId ?? "task-x",
        title: patch.title ?? "任务",
        projectId: "repo",
        coordinationStatus: "active",
        freshness: "fresh",
        packageDisposition: "active",
        closeoutReadiness: "not_required",
        lastKnownAt: "2026-10-21T00:00:00.000Z",
        gates: [],
        board: { columnId: "open", rank: 2 },
        visibility: { archived: false, noise: false },
        capabilities: [],
        risk: { flagged: false },
        phase: { index: 1, reason: null, steps: ["planned", "active", "submitted", "in_review", "done"] },
        docs: [],
        ...patch,
      }) as TaskRow;
    const now = Date.parse("2026-10-22T00:00:00.000Z"),
      groups = liveFloorPipelineGroups(
        [
          task({ taskId: "a", title: "在做", deliveryStage: "implementing" }),
          task({ taskId: "b", title: "打回", deliveryStage: "rework" }),
          task({ taskId: "c", title: "老daemon在做", deliveryStage: null, canonicalStatus: "active" }),
          task({ taskId: "d", title: "排队", deliveryStage: null, canonicalStatus: "planned" }),
          task({ taskId: "e", title: "等上游", deliveryStage: null, canonicalStatus: "blocked" }),
          task({
            taskId: "f",
            title: "刚完成",
            deliveryStage: null,
            canonicalStatus: "done",
            lastKnownAt: "2026-10-20T00:00:00.000Z",
          }),
          task({
            taskId: "g",
            title: "老完成",
            deliveryStage: null,
            canonicalStatus: "done",
            lastKnownAt: "2026-09-01T00:00:00.000Z",
          }),
          task({
            taskId: "h",
            title: "归档噪音",
            deliveryStage: "implementing",
            visibility: { archived: true, noise: true },
          }),
        ],
        now,
      );
    expect(groups.map(({ key, tasks }) => [key, tasks.map(({ taskId }) => taskId)])).toEqual([
      ["implementing", ["a", "c"]],
      ["rework", ["b"]],
      ["done", ["f"]],
      ["queued", ["d"]],
      ["waiting_upstream", ["e"]],
    ]);
  });

  it("assembles owner-only ask lanes from the agenda groups and attestation lanes", () => {
    const rows = liveFloorAskLanes({
      agenda: {
        awaitingYou: [
          {
            relationId: "rel-1",
            relationRevision: 3,
            sourceRef: "task/task-1",
            title: "任务一",
            status: "active",
            personId: "person-owner",
            askKind: "consent",
            question: "可以合并吗?",
            askedAt: "2026-10-21T09:00:00.000Z",
            askedBy: "agent-sol",
          },
        ],
        awaitingDecision: [{ decisionId: "dec-1", title: "决策一" }],
        awaitingDecisionReview: [],
        awaitingRework: [{ taskId: "task-2", title: "打回的任务" }],
        awaitingAdjudication: [],
        pinnedEntities: [{ ref: "task/task-3", title: "置顶任务" }],
      },
      tasks: [],
    });
    expect(rows.map(({ kind, title }) => [kind, title])).toEqual([
      ["ask", "任务一"],
      ["decision", "决策一"],
      ["rework", "打回的任务"],
      ["pinned", "置顶任务"],
    ]);
    expect(rows[0]?.taskId).toBe("task-1");
    expect(rows[0]?.ask?.relationId).toBe("rel-1");
  });

  it("strips the package prefix so dispatch report paths reach the task document read", () => {
    expect(liveFloorReportDocPath("tasks/task-1/artifacts/reports/dispatch-9.md", "tasks/task-1")).toBe(
      "artifacts/reports/dispatch-9.md",
    );
    expect(liveFloorReportDocPath("tasks/task-1/artifacts/reports/dispatch-9.md", undefined)).toBe(
      "artifacts/reports/dispatch-9.md",
    );
    expect(liveFloorReportDocPath("tasks/task-1/closeout.md", "tasks/task-2")).toBeNull();
  });

  it("round-trips the scope preference and falls back to the project scope", () => {
    const store = new Map<string, string>(),
      storage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      };
    expect(readLiveFloorPreferences(storage).scope).toBe("project");
    writeLiveFloorPreferences(storage, { scope: "all" });
    expect(readLiveFloorPreferences(storage).scope).toBe("all");
    storage.setItem("harness:gui:live-floor-preferences", "{not json");
    expect(readLiveFloorPreferences(storage).scope).toBe("project");
  });
});
