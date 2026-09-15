// harness-test-tier: integration
import { describe, expect, it } from "vitest";
import { sessionTranscriptTurns } from "../src/renderer/session-transcript-model.ts";

// Fixture shape: dispatch_c9dfb984d5d352889900bd47.jsonl (devin acp, swe2), trimmed.
describe("acp session transcript", () => {
  it("maps acp session updates into text, tool calls, tool results, and the final result", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:42.232Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.session",
          modes: ["accept-edits", "smart", "ask", "plan", "bypass"],
          currentMode: "accept-edits",
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:43.000Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Reading the plan " },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:44.000Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I'll check " },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:44.500Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "the diff first." },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:49.309Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "read:0",
            title: "Read file",
            kind: "read",
            rawInput: { file_path: "/repo/task_plan.md" },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:49.310Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "read:0",
            status: "in_progress",
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:25:49.333Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "read:0",
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: "111 lines" } }],
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:26:00.000Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.update",
          update: { sessionUpdate: "usage_update", usage: { used: 100 } },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:27:53.197Z",
        event: {
          sessionId: "principled-molecule",
          type: "acp.result",
          stopReason: "end_turn",
          finalText: "I'll check the diff first.\n\nDone. 续跑验收结论:已逐条满足。",
        },
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("completed");
    expect(turns[0]?.endedAt).toBe("2026-09-15T06:27:53.197Z");
    expect(turns[0]?.items.map(({ type, label, detail }) => ({ type, label, detail }))).toEqual([
      { type: "thinking", label: "thinking", detail: "Reading the plan " },
      {
        type: "text",
        label: "result",
        detail: "I'll check the diff first.\n\nDone. 续跑验收结论:已逐条满足。",
      },
      { type: "tool_call", label: "Read file", detail: '{\n  "file_path": "/repo/task_plan.md"\n}' },
      { type: "tool_result", label: "Read file", detail: "111 lines" },
    ]);
    expect(turns[0]?.items.map(({ summary }) => summary).join("\n")).not.toContain("sessionUpdate");
  });

  it("marks the acp turn failed when the stop reason is not a normal stop", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-09-15T06:00:00.000Z",
        event: { sessionId: "s1", type: "acp.result", stopReason: "cancelled", finalText: "partial" },
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("failed");
    expect(turns[0]?.items[0]).toMatchObject({ type: "text", label: "result" });
  });
});
