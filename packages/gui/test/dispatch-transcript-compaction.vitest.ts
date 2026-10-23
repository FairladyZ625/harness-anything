// harness-test-tier: integration
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRuntimeWorkerRecord,
  archiveDispatchStream,
  openDispatchStream,
  readDispatchStream,
} from "../../daemon/src/dispatch-stream.ts";
import { sessionTranscriptTurns, toolCallGroups } from "../src/renderer/session-transcript-model.ts";

type Fixture = {
  readonly dispatchId: string;
  readonly events: readonly { readonly at: string; readonly event: Readonly<Record<string, unknown>> }[];
};

function archiveAndProject(fixture: Fixture) {
  const root = mkdtempSync(path.join(tmpdir(), "ha-transcript-compaction-"));
  try {
    openDispatchStream(root, {
      dispatchId: fixture.dispatchId,
      taskId: null,
      executionId: null,
      runtimeSessionId: "runtime-transcript",
      instanceId: "instance-transcript",
      startedAt: "2026-10-23T00:00:00.000Z",
    });
    for (const entry of fixture.events)
      appendRuntimeWorkerRecord(root, fixture.dispatchId, {
        kind: "provider_event",
        occurredAt: entry.at,
        event: entry.event,
      });
    const beforeRecords = readDispatchStream(root, fixture.dispatchId)!.records,
      beforeTurns = sessionTranscriptTurns(beforeRecords),
      beforeToolCalls = toolCallGroups(beforeTurns);
    archiveDispatchStream(root, fixture.dispatchId);
    const after = readDispatchStream(root, fixture.dispatchId)!,
      afterTurns = sessionTranscriptTurns(after.records);
    return {
      beforeRecords,
      beforeTurns,
      beforeToolCalls,
      afterRecords: after.records,
      afterTurns,
      afterToolCalls: toolCallGroups(afterTurns),
      compacted: after.header.transcriptCompactionVersion === 1,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function eventRecord(record: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return record.event as Readonly<Record<string, unknown>>;
}

describe("archived provider transcript compaction", () => {
  it("keeps Codex item.completed messages and tool history unchanged", () => {
    const result = archiveAndProject({
      dispatchId: "dispatch_444444444444444444444444",
      events: [
        { at: "2026-10-23T00:00:01.000Z", event: { type: "turn.started" } },
        {
          at: "2026-10-23T00:00:02.000Z",
          event: {
            type: "item.started",
            item: { id: "tool-1", type: "command_execution", command: "printf hello" },
          },
        },
        {
          at: "2026-10-23T00:00:03.000Z",
          event: {
            type: "item.completed",
            item: {
              id: "tool-1",
              type: "command_execution",
              command: "printf hello",
              aggregated_output: "hello",
              exit_code: 0,
            },
          },
        },
        {
          at: "2026-10-23T00:00:04.000Z",
          event: { type: "item.completed", item: { id: "message-1", type: "agent_message", text: "Done." } },
        },
        { at: "2026-10-23T00:00:05.000Z", event: { type: "turn.completed" } },
      ],
    });

    expect(result.compacted).toBe(true);
    expect(result.afterTurns).toEqual(result.beforeTurns);
    expect(result.afterToolCalls).toEqual(result.beforeToolCalls);
    expect(result.afterRecords.filter((record) => record.kind === "provider_event")).toHaveLength(
      result.beforeRecords.filter((record) => record.kind === "provider_event").length,
    );
  });

  it("merges ZCode reasoning and removes a result-backed final text delta", () => {
    const result = archiveAndProject({
      dispatchId: "dispatch_555555555555555555555555",
      events: [
        { at: "2026-10-23T00:00:01.000Z", event: { type: "turn.started", turnId: "turn-1" } },
        {
          at: "2026-10-23T00:00:02.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "reasoning_delta", delta: "Let me " },
          },
        },
        {
          at: "2026-10-23T00:00:03.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "tool_input_delta", delta: '{"path":' },
          },
        },
        {
          at: "2026-10-23T00:00:04.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "reasoning_delta", delta: "think." },
          },
        },
        {
          at: "2026-10-23T00:00:05.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "text_delta", delta: "Before tool. " },
          },
        },
        {
          at: "2026-10-23T00:00:06.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: {
              kind: "tool_call",
              toolCallId: "tool-1",
              toolName: "read",
              input: { path: "README.md" },
            },
          },
        },
        {
          at: "2026-10-23T00:00:07.000Z",
          event: {
            type: "tool.updated",
            turnId: "turn-1",
            payload: { kind: "result", toolCallId: "tool-1", result: "file read" },
          },
        },
        {
          at: "2026-10-23T00:00:08.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "text_delta", delta: "Answer " },
          },
        },
        {
          at: "2026-10-23T00:00:09.000Z",
          event: {
            type: "model.streaming",
            turnId: "turn-1",
            payload: { kind: "text_delta", delta: "complete." },
          },
        },
        {
          at: "2026-10-23T00:00:10.000Z",
          event: { type: "result", turnId: "turn-1", response: "Answer complete.", is_error: false },
        },
        { at: "2026-10-23T00:00:11.000Z", event: { type: "turn.completed", turnId: "turn-1" } },
      ],
    });
    const textEvents = result.afterRecords
      .filter((record) => record.kind === "provider_event")
      .map(eventRecord)
      .filter((event) => event.type === "model.streaming")
      .map((event) => event.payload as Record<string, unknown>);

    expect(result.afterTurns).toEqual(result.beforeTurns);
    expect(result.afterToolCalls).toEqual(result.beforeToolCalls);
    expect(textEvents.filter((payload) => payload.kind === "reasoning_delta")).toHaveLength(1);
    expect(textEvents.filter((payload) => payload.kind === "text_delta")).toHaveLength(2);
    expect(textEvents.some((payload) => payload.delta === "Answer complete.")).toBe(false);
    expect(result.afterRecords.some((record) => record.transcriptCompactionSegment)).toBe(true);
  });

  it("uses ACP finalText once and reconstructs text around thoughts and tool results", () => {
    const result = archiveAndProject({
      dispatchId: "dispatch_666666666666666666666666",
      events: [
        {
          at: "2026-10-23T00:00:01.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Alpha " },
            },
          },
        },
        {
          at: "2026-10-23T00:00:02.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: { sessionUpdate: "usage_update", usage: { used: 6, size: 100 } },
          },
        },
        {
          at: "2026-10-23T00:00:03.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "beta" },
            },
          },
        },
        {
          at: "2026-10-23T00:00:04.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: "Checking the answer." },
            },
          },
        },
        {
          at: "2026-10-23T00:00:05.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Gamma " } },
          },
        },
        {
          at: "2026-10-23T00:00:06.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Read file",
              rawInput: { path: "README.md" },
            },
          },
        },
        {
          at: "2026-10-23T00:00:07.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "completed",
              content: [{ type: "content", content: { type: "text", text: "file read" } }],
            },
          },
        },
        {
          at: "2026-10-23T00:00:08.000Z",
          event: {
            type: "acp.update",
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "delta" } },
          },
        },
        {
          at: "2026-10-23T00:00:09.000Z",
          event: {
            type: "acp.result",
            sessionId: "session-1",
            stopReason: "end_turn",
            finalText: "Alpha betaGamma delta",
          },
        },
      ],
    });
    const acpTextChunks = result.afterRecords
      .filter((record) => record.kind === "provider_event")
      .map(eventRecord)
      .filter((event) => event.type === "acp.update")
      .map((event) => event.update as Record<string, unknown>)
      .filter((update) => update.sessionUpdate === "agent_message_chunk");

    expect(result.afterTurns).toEqual(result.beforeTurns);
    expect(result.afterToolCalls).toEqual(result.beforeToolCalls);
    expect(acpTextChunks).toHaveLength(3);
    expect(acpTextChunks.every((update) => (update.content as Record<string, unknown>).text === "")).toBe(true);
    expect(result.afterRecords.some((record) => JSON.stringify(record).includes("Alpha betaGamma delta"))).toBe(true);
  });

  it("keeps provider deltas when a purported complete result differs", () => {
    const zcode = archiveAndProject({
        dispatchId: "dispatch_777777777777777777777777",
        events: [
          {
            at: "2026-10-23T00:00:01.000Z",
            event: {
              type: "model.streaming",
              turnId: "turn-1",
              payload: { kind: "text_delta", delta: "raw ZCode answer" },
            },
          },
          {
            at: "2026-10-23T00:00:02.000Z",
            event: { type: "result", turnId: "turn-1", response: "normalized ZCode answer" },
          },
        ],
      }),
      acp = archiveAndProject({
        dispatchId: "dispatch_888888888888888888888888",
        events: [
          {
            at: "2026-10-23T00:00:01.000Z",
            event: {
              type: "acp.update",
              sessionId: "session-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "raw ACP chunks" },
              },
            },
          },
          {
            at: "2026-10-23T00:00:02.000Z",
            event: { type: "acp.result", sessionId: "session-1", finalText: "normalized ACP answer" },
          },
        ],
      }),
      deltaText = (result: ReturnType<typeof archiveAndProject>, provider: "zcode" | "acp") =>
        result.afterRecords
          .filter((record) => record.kind === "provider_event")
          .map(eventRecord)
          .filter((event) =>
            provider === "zcode"
              ? event.type === "model.streaming"
              : event.type === "acp.update" &&
                (event.update as Record<string, unknown>).sessionUpdate === "agent_message_chunk",
          )
          .map((event) =>
            provider === "zcode"
              ? ((event.payload as Record<string, unknown>).delta as string)
              : (((event.update as Record<string, unknown>).content as Record<string, unknown>).text as string),
          );

    expect(zcode.afterTurns).toEqual(zcode.beforeTurns);
    expect(acp.afterTurns).toEqual(acp.beforeTurns);
    expect(deltaText(zcode, "zcode")).toEqual(["raw ZCode answer"]);
    expect(deltaText(acp, "acp")).toEqual(["raw ACP chunks"]);
    expect(zcode.afterRecords.some((record) => record.transcriptCompactionSegment)).toBe(false);
    expect(acp.afterRecords.some((record) => record.transcriptCompactionSegment)).toBe(false);
  });
});
