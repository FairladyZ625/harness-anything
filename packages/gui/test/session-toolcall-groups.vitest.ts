// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import {
  consumeSteering,
  enqueueSteering,
  rejectSteering,
  sessionPlanSteps,
  sessionTranscriptTurns,
  sessionUserMessageTimestamps,
  toolCallGroups,
} from "../src/renderer/session-transcript-model.ts";

/**
 * 转录层新投影(dec_C0AF8CBBFFECF71F4F34FB76F9/CH3):连续工具调用折叠成
 * ToolCallGroup 结构(name/summary/status/durationMs/args/result)、计划步骤提取
 * 与 Steering 待注入队列的消费判定。
 */

type Record0 = Record<string, unknown>;

const assistant = (at: string, parts: readonly Record0[], id = `m-${at}`): Record0 => ({
  kind: "provider_event",
  occurredAt: at,
  event: { type: "assistant", message: { id, content: parts } },
});
const toolUse = (id: string, name: string, input: Record0) => ({ type: "tool_use", id, name, input });
const text = (t: string) => ({ type: "text", text: t });
const toolResult = (toolUseId: string, content: string) => ({
  type: "tool_result",
  tool_use_id: toolUseId,
  content,
});
const userResult = (at: string, parts: readonly Record0[]): Record0 => ({
  kind: "provider_event",
  occurredAt: at,
  event: { type: "user", message: { content: parts } },
});
const userText = (at: string, message: string): Record0 => ({
  kind: "provider_event",
  occurredAt: at,
  event: { type: "user", message: { content: [text(message)] } },
});

describe("连续工具调用折叠", () => {
  it("同一轮连续两次调用聚成一组,乱序回传按 id 配对,durationMs 取 call→result 差", () => {
    const records = [
      assistant("2026-10-20T11:00:00.000Z", [
        toolUse("t1", "Read", { path: "a.ts" }),
        toolUse("t2", "Grep", { q: "x" }),
      ]),
      userResult("2026-10-20T11:00:04.000Z", [toolResult("t2", "found 2")]),
      userResult("2026-10-20T11:00:09.000Z", [toolResult("t1", "file content")]),
    ];
    const groups = toolCallGroups(sessionTranscriptTurns(records));
    expect(groups).toHaveLength(1);
    const [group] = groups!;
    expect(group.calls.map((call) => call.name)).toEqual(["Read", "Grep"]);
    expect(group.calls.map((call) => call.status)).toEqual(["succeeded", "succeeded"]);
    expect(group.calls[0]).toMatchObject({
      name: "Read",
      args: expect.stringContaining("a.ts"),
      result: "file content",
      durationMs: 9_000,
      startedAt: "2026-10-20T11:00:00.000Z",
    });
    expect(group.calls[1]!.durationMs).toBe(4_000);
    expect(group.status).toBe("succeeded");
    expect(group.totalDurationMs).toBe(13_000);
  });

  it("text 打断连续性:打断后开新组,但迟到的结果仍收口进正确条目", () => {
    const records = [
      assistant("2026-10-20T11:00:00.000Z", [
        toolUse("t1", "Read", { path: "a.ts" }),
        text("先看这个文件"),
        toolUse("t2", "Bash", { cmd: "ls" }),
      ]),
      userResult("2026-10-20T11:00:05.000Z", [toolResult("t2", "file list")]),
      userResult("2026-10-20T11:00:08.000Z", [toolResult("t1", "content")]),
    ];
    const groups = toolCallGroups(sessionTranscriptTurns(records));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.calls.map((call) => call.name)).toEqual(["Read"]);
    expect(groups[0]!.calls[0]!.status).toBe("succeeded"); // 迟到的 t1 结果仍收口
    expect(groups[0]!.calls[0]!.durationMs).toBe(8_000);
    expect(groups[1]!.calls.map((call) => call.name)).toEqual(["Bash"]);
  });

  it("未回传的调用保持 running,组状态 running,durationMs 为 null 不虚构", () => {
    const records = [
      assistant("2026-10-20T11:00:00.000Z", [toolUse("t1", "Bash", { cmd: "sleep" })]),
      assistant("2026-10-20T11:00:02.000Z", [text("还在跑")], "m-2"),
    ];
    const groups = toolCallGroups(sessionTranscriptTurns(records));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls[0]).toMatchObject({ name: "Bash", status: "running", durationMs: null, result: null });
    expect(groups[0]!.status).toBe("running");
    expect(groups[0]!.totalDurationMs).toBeNull();
  });

  it("error 回传把配对调用判为 failed,组状态 failed(zcode tool.updated 流)", () => {
    const records = [
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:00.000Z",
        event: {
          type: "model.streaming",
          turnId: "turn-1",
          payload: { kind: "tool_call", toolCallId: "t1", toolName: "Bash", input: { cmd: "boom" } },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:03.000Z",
        event: {
          type: "tool.updated",
          turnId: "turn-1",
          payload: { kind: "error", toolCallId: "t1", error: "exit code 1" },
        },
      },
    ];
    const groups = toolCallGroups(sessionTranscriptTurns(records));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls[0]).toMatchObject({
      name: "Bash",
      status: "failed",
      result: "exit code 1",
      durationMs: 3_000,
    });
    expect(groups[0]!.status).toBe("failed");
  });

  it("无调用 id 的协议按同名顺序配对(codex item 流)", () => {
    const records = [
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:00.000Z",
        event: { type: "turn.started" },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:01.000Z",
        event: { type: "item.started", item: { type: "command_execution", id: "c1", command: "npm test" } },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:02.000Z",
        event: { type: "item.started", item: { type: "command_execution", id: "c2", command: "npm run lint" } },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:10.000Z",
        event: { type: "item.completed", item: { type: "command_execution", id: "c2", aggregated_output: "lint ok" } },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:12.000Z",
        event: { type: "item.completed", item: { type: "command_execution", id: "c1", aggregated_output: "tests ok" } },
      },
    ];
    const groups = toolCallGroups(sessionTranscriptTurns(records));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.calls.map((call) => call.name)).toEqual(["command", "command"]);
    expect(groups[0]!.calls.map((call) => call.status)).toEqual(["succeeded", "succeeded"]);
    expect(groups[0]!.calls.map((call) => call.durationMs)).toEqual([11_000, 8_000]);
  });
});

describe("计划步骤提取", () => {
  it("Claude TodoWrite 的 input.todos 是步骤数组,取最后一次观测", () => {
    const todoWrite = (todos: readonly Record0[]) =>
      assistant("2026-10-20T11:00:00.000Z", [toolUse("t-plan", "TodoWrite", { todos })]);
    const records = [
      todoWrite([
        { content: "写模型", status: "completed" },
        { content: "写测试", status: "in_progress" },
      ]),
      todoWrite([
        { content: "写模型", status: "completed" },
        { content: "写测试", status: "completed" },
        { content: "收口", status: "pending" },
      ]),
    ];
    expect(sessionPlanSteps(records)).toEqual([
      { key: expect.stringContaining("写模型"), content: "写模型", status: "completed" },
      { key: expect.stringContaining("写测试"), content: "写测试", status: "completed" },
      { key: expect.stringContaining("收口"), content: "收口", status: "pending" },
    ]);
  });

  it("codex todo_list 项(items 字段)与状态词归一(done/completed → completed)", () => {
    const records = [
      {
        kind: "provider_event",
        occurredAt: "2026-10-20T11:00:00.000Z",
        event: {
          type: "item.completed",
          item: {
            type: "todo_list",
            items: [
              { text: "第一步", status: "done" },
              { text: "第二步", status: "in_progress" },
            ],
          },
        },
      },
    ];
    expect(sessionPlanSteps(records).map((step) => [step.content, step.status])).toEqual([
      ["第一步", "completed"],
      ["第二步", "in_progress"],
    ]);
  });

  it("没有计划证据返回空数组,不虚构步骤", () => {
    expect(sessionPlanSteps([assistant("2026-10-20T11:00:00.000Z", [text("普通消息")])])).toEqual([]);
  });
});

describe("Steering 待注入队列", () => {
  const T0 = 1_700_000_000_000;

  it("排队后按队列序由其后的用户消息逐条证明注入;一条消息只消费一个条目", () => {
    const queue = enqueueSteering(enqueueSteering([], "s1", "先看登录页", T0), "s2", "再跑测试", T0 + 1_000);
    const consumed = consumeSteering(queue, [T0 + 500, T0 + 2_000]);
    expect(consumed.map((entry) => entry.status)).toEqual(["injected", "injected"]);
    expect(consumed[0]!.settledAtMs).toBe(T0 + 500);
    expect(consumed[1]!.settledAtMs).toBe(T0 + 2_000);
  });

  it("早于排队时刻的消息不能证明注入;证据不足的条目保持 pending", () => {
    const queue = enqueueSteering([], "s1", "插话", T0 + 1_000);
    expect(consumeSteering(queue, [T0]).map((entry) => entry.status)).toEqual(["pending"]);
    expect(consumeSteering(queue, []).map((entry) => entry.status)).toEqual(["pending"]);
  });

  it("reject 显式打回并留原因;已结算的条目不再被消费改写", () => {
    const queue = rejectSteering(enqueueSteering([], "s1", "插话", T0), "s1", "会话已收口", T0 + 100);
    expect(queue[0]).toMatchObject({ status: "rejected", reason: "会话已收口", settledAtMs: T0 + 100 });
    expect(consumeSteering(queue, [T0 + 200])[0]!.status).toBe("rejected");
  });

  it("转录里的用户文本是注入证据,tool_result 回传不是", () => {
    const records = [
      assistant("2026-10-20T11:00:00.000Z", [toolUse("t1", "Read", { path: "a.ts" })]),
      userResult("2026-10-20T11:00:01.000Z", [toolResult("t1", "content")]),
      userText("2026-10-20T11:00:02.000Z", "换个思路,先看测试"),
    ];
    expect(sessionUserMessageTimestamps(records)).toEqual([Date.parse("2026-10-20T11:00:02.000Z")]);
  });
});
