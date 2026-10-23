// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import {
  liveFloorAction,
  liveFloorAskLanes,
  liveFloorDispatchChannel,
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

describe("live floor model", () => {
  it("keeps only live sessions and enriches them from the same dispatch row", () => {
    const rows = liveFloorRows({
      sessions: [session(), session({ runtimeSessionId: "runtime-exited", liveness: "exited" })],
      dispatches: [dispatch()],
      taskTitles: new Map([["task/task-1", "修复现场页面"]]),
      works,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      taskTitle: "修复现场页面",
      workTitle: "现场工作",
      channel: "implementation",
      activityStatus: "progressing",
    });
  });

  it("labels retry attempts as rework and presents readable model names", () => {
    const rows = liveFloorRows({
      sessions: [session()],
      dispatches: [dispatch({ attemptIndex: 1 })],
      taskTitles: new Map([["task/task-1", "返工"]]),
      works,
    });
    expect(rows[0]?.channel).toBe("rework");
    expect(readableModelName("openai/gpt-5.6-terra")).toBe("GPT 5.6 Terra");
    expect(readableModelName('["Deepseek Official","Deepseek V4.1 Flash"]')).toBe("Deepseek V4.1 Flash");
  });

  it("splits reviewer channels by review target and keeps a missing projection distinct from unknown", () => {
    // 同任务两行(评审交付 vs 评审决策)靠通道词分辨,业主不再需要猜是重复。
    expect(liveFloorDispatchChannel(dispatch({ role: "reviewer" }))).toBe("review_task");
    expect(
      liveFloorDispatchChannel(
        dispatch({
          role: "reviewer",
          reviewTarget: { kind: "decision", decisionId: "dec-1", digest: "sha256:0" },
        }),
      ),
    ).toBe("review_decision");
    expect(liveFloorDispatchChannel(dispatch({ role: "reviewer", attemptIndex: 2 }))).toBe("review_task");
    expect(liveFloorDispatchChannel(null)).toBe("unknown");
    // 旧 daemon 派工行没有 activityStatus:那是缺投影(null),不是「状态未知」。
    const legacy = liveFloorRows({
      sessions: [session()],
      dispatches: [dispatch({ activityStatus: undefined })],
      taskTitles: new Map(),
      works,
    });
    expect(legacy[0]?.activityStatus).toBeNull();
  });

  it("humanizes the latest action: verb plus the salient argument, JSON noise dropped", () => {
    const record = (event: unknown) => ({
      kind: "provider_event",
      occurredAt: "2026-10-21T00:01:00.000Z",
      event,
    });
    expect(
      liveFloorAction([
        record({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test --filter live" } }],
          },
        }),
      ]),
    ).toMatchObject({ verb: "run_command", subject: "npm test --filter live" });
    expect(
      liveFloorAction([
        record({
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t2",
                name: "Edit",
                input: { file_path: "/repo/packages/gui/src/renderer/views/live-floor-model.ts" },
              },
            ],
          },
        }),
      ]),
    ).toMatchObject({ verb: "edit_file", subject: "live-floor-model.ts" });
    expect(
      liveFloorAction([
        record({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t3", name: "WebSearch", input: { query: "sqlite wal checkpoint" } }],
          },
        }),
      ]),
    ).toMatchObject({ verb: "browse", subject: "sqlite wal checkpoint" });
    // JSON 里没有可读主体时不硬造:只剩动词,原文进悬停。
    expect(
      liveFloorAction([
        record({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t4", name: "mcp__probe__analyze", input: { imageSource: "x" } }],
          },
        }),
      ]),
    ).toMatchObject({ verb: "tool", subject: null });
    expect(
      liveFloorAction([
        record({
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "先修读面,再补测试。后面再重拍截图。" }] },
        }),
      ]),
    ).toMatchObject({ verb: "message", subject: "先修读面,再补测试。" });
    expect(liveFloorAction([])).toBeNull();
  });

  it("maps ended dispatches onto conclusions, with the review verdict outranking outcome wording", () => {
    const titles = new Map([["task/task-1", "任务一"]]),
      nowMs = Date.parse("2026-10-23T12:00:00.000Z"),
      ended = (patch: Partial<TaskDispatchProjectionRow>) =>
        dispatch({
          endedAt: "2026-10-23T08:00:00.000Z",
          outcome: "succeeded",
          status: "succeeded",
          reportPath: "tasks/task-1/artifacts/reports/dispatch-1.md",
          ...patch,
        }),
      tasks = [
        task({
          taskId: "task-1",
          reviews: [
            {
              schema: "review/v1",
              reviewId: "rev-1",
              taskId: "task-1",
              executionId: "execution-1",
              verdict: "changes_requested",
              actor: { axes: {} } as never,
              capabilityRef: "cap",
              reason: "两个显式交付项未达成",
              evidenceChecked: [],
              commitSha: null,
              iteration: 0,
              contentDigest: "sha256:0",
              submissionDigest: {} as never,
              reviewedAt: "2026-10-23T08:00:00.000Z",
            },
          ],
          executions: [{ executionId: "execution-2", state: "changes_requested" } as never],
        }),
      ];
    const rows = liveFloorEndedRows({
      dispatches: [
        // 评审人结束,评审记录打回 → 评审打回(不是「评审完成」)。
        ended({ dispatchId: "d-review-reject", runtimeSessionId: "runtime-review", role: "reviewer" }),
        // 评审人结束,execution 状态打回(评审记录缺席)→ 评审打回。
        ended({
          dispatchId: "d-exec-reject",
          runtimeSessionId: "runtime-exec-reject",
          role: "reviewer",
          executionId: "execution-2",
        }),
        // 实现者成功但没冻结报告 → 空报告。
        ended({ dispatchId: "d-empty", runtimeSessionId: "runtime-empty", reportPath: undefined }),
        // 实现者成功带报告 → 已交付。
        ended({ dispatchId: "d-delivered", runtimeSessionId: "runtime-delivered" }),
        // 中途断开。
        ended({
          dispatchId: "d-stopped",
          runtimeSessionId: "runtime-stopped",
          outcome: "stopped",
          status: "stopped",
        }),
        // 超出 24h 窗口:不进「刚结束」。
        ended({
          dispatchId: "d-old",
          runtimeSessionId: "runtime-old",
          endedAt: "2026-10-21T08:00:00.000Z",
        }),
      ],
      taskTitles: titles,
      tasks,
      nowMs,
    });
    expect(rows.map((row) => [row.dispatch.dispatchId, row.conclusion])).toEqual([
      ["d-review-reject", "review_rejected"],
      ["d-exec-reject", "review_rejected"],
      ["d-empty", "empty_report"],
      ["d-delivered", "delivered"],
      ["d-stopped", "interrupted"],
    ]);
    expect(rows[0]?.reportPath).toBe("tasks/task-1/artifacts/reports/dispatch-1.md");
  });

  it("buckets pipeline tasks by the daemon stage, keeps unknown daemon words visible, and drops work roots", () => {
    const groups = liveFloorPipelineGroups(
      [
        task({ taskId: "a", title: "在做", deliveryStage: "implementing" }),
        task({ taskId: "b", title: "打回", deliveryStage: "rework" }),
        task({ taskId: "q", title: "排队", deliveryStage: "queued" }),
        task({ taskId: "u", title: "等上游", deliveryStage: "waiting_upstream" }),
        task({ taskId: "f", title: "刚完成", deliveryStage: "done" }),
        task({ taskId: "w", title: "工作根本身", deliveryStage: "implementing" }),
        task({ taskId: "z", title: "更新词", deliveryStage: "gamified" as never }),
        // daemon 判不在流水线:不进任何桶。
        task({ taskId: "n", title: "老终态", deliveryStage: null }),
        // 旧 daemon(未投影):读行自身状态词,终态窗口不在这里重算,没有「完成」桶。
        task({ taskId: "c", title: "老daemon在做", deliveryStage: undefined, canonicalStatus: "active" }),
        task({ taskId: "d", title: "老daemon排队", deliveryStage: undefined, canonicalStatus: "planned" }),
        task({
          taskId: "g",
          title: "老daemon完成",
          deliveryStage: undefined,
          canonicalStatus: "done",
          lastKnownAt: "2026-10-23T00:00:00.000Z",
        }),
        task({
          taskId: "h",
          title: "归档噪音",
          deliveryStage: "implementing",
          visibility: { archived: true, noise: true },
        }),
      ],
      { isWorkRoot: (taskId) => taskId === "w" },
    );
    expect(groups.map(({ key, tasks }) => [key, tasks.map(({ taskId }) => taskId)])).toEqual([
      ["queued", ["q", "d"]],
      ["implementing", ["a", "c"]],
      ["rework", ["b"]],
      ["done", ["f"]],
      ["waiting_upstream", ["u"]],
      // daemon 比本 GUI 新时的未知词:落进可见的「其他」桶,不被顺序过滤吞掉。
      ["other", ["z"]],
    ]);
  });

  it("attaches evidence to every owner-only lane: review reasons, CI receipts, gate counts, decision questions", () => {
    const review = (verdict: string, reason: string, at: string, executionId = "exe-2") => ({
      schema: "review/v1",
      reviewId: `rev-${at}`,
      taskId: "task-2",
      executionId,
      verdict,
      actor: { axes: {} } as never,
      capabilityRef: "cap",
      reason,
      evidenceChecked: [],
      commitSha: null,
      iteration: 0,
      contentDigest: "sha256:0",
      submissionDigest: {} as never,
      reviewedAt: at,
    });
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
        awaitingDecisionReview: [{ decisionId: "dec-2", title: "决策二" }],
        awaitingRework: [{ taskId: "task-2", title: "打回的任务" }],
        awaitingAdjudication: [{ taskId: "task-3", title: "待派审任务", executionId: "exe-3" }],
        pinnedEntities: [{ ref: "task/task-2", title: "置顶任务", pinnedAt: "2026-10-22T00:00:00.000Z" }],
      },
      tasks: [
        task({
          taskId: "task-2",
          reviews: [
            review("approved", "通过", "2026-10-21T01:00:00.000Z"),
            review("changes_requested", "评审打回的依据原文", "2026-10-22T02:00:00.000Z"),
          ],
        }),
        task({
          taskId: "task-3",
          reviews: [review("approved", "交付可派审", "2026-10-22T03:00:00.000Z", "exe-3")],
          executionEvidence: [
            {
              executionId: "exe-3",
              origin: "native",
              outputs: [
                {
                  evidenceId: "e1",
                  locator: "l",
                  substrate: "repository-path",
                  checkerReceiptRef: null,
                  checkerResult: "pass",
                },
                {
                  evidenceId: "e2",
                  locator: "l",
                  substrate: "repository-path",
                  checkerReceiptRef: null,
                  checkerResult: "fail",
                },
              ],
            },
          ],
        }),
        task({
          taskId: "task-consent",
          closeoutBlocker: "consent",
          gates: [
            { name: "g1", ok: true, status: "pass" },
            { name: "g2", ok: true, status: "pass" },
            { name: "g3", ok: null, status: "missing", detail: "缺人签" },
          ],
        }),
      ],
      decisionQuestions: new Map([
        ["dec-1", "要不要把默认分支换成 trunk?"],
        ["dec-2", "评审策略是否要求双人?"],
      ]),
      labels: { gates: "门", ci: "CI" },
    });
    const byKind = new Map(rows.map((row) => [row.key, row]));
    expect(rows[0]).toMatchObject({ kind: "ask", taskId: "task-1", ask: { relationId: "rel-1" } });
    // 打回待重开:依据是最新评审结论原文。
    expect(byKind.get("rework:task-2")?.detail).toBe("评审打回的依据原文");
    // 已交付待派审:评审结论 + CI 收据(过了几项/验了几项)。
    expect(byKind.get("adjudicate:task-3")?.detail).toBe("交付可派审 · CI 1/2");
    // 待裁决/待派评审:依据是提案原文问题。
    expect(byKind.get("decision:dec-1")?.detail).toBe("要不要把默认分支换成 trunk?");
    expect(byKind.get("decision-review:dec-2")?.detail).toBe("评审策略是否要求双人?");
    // 待同意:签到了哪一步(门 x/y)+ 最近一道没过的门的说明。
    expect(byKind.get("consent:task-consent")?.detail).toBe("门 2/3 · 缺人签");
    // 置顶行带 pin 时刻,依据回落到该任务最新评审结论。
    expect(byKind.get("pinned:task/task-2")).toMatchObject({
      at: "2026-10-22T00:00:00.000Z",
      detail: "评审打回的依据原文",
    });
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
