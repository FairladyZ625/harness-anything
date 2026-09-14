// harness-test-tier: integration
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRuntimeSessionDto } from "../../daemon/src/agent-runtime-contract.ts";
import { sessionTranscriptTurns } from "../src/renderer/session-transcript-model.ts";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "agy-li",
  installationId: "agy-install",
  kindId: "agy",
  providerId: "google",
  model: "gemini-3.8-flash-high",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
} as const;
const sessionDto: AgentRuntimeSessionDto = {
  runtimeSessionId: "runtime-agy",
  providerSessionId: "conversation-60edfe99",
  instanceId: "agy-li",
  installationId: "agy-install",
  kindId: "agy",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: definition,
  definitionSnapshotPersisted: true,
  liveness: "exited",
  attachCapability: "unsupported",
  streamCursor: "stream:9",
  associations: [],
  activity: {
    lastObservedAt: "2026-09-13T00:00:00.006Z",
    outcome: "succeeded",
    exitCode: 0,
    resultRef: "artifact:runtime-result/test",
    missingEvidence: null,
  },
};

const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionDetailView, {
      session: sessionDto,
      row: null,
      squadNames: new Map(),
      decisionRefs: [],
      result: null,
      transcript: createElement("p", null, "No dispatch record."),
      busy: false,
      onCancel: noop,
      onResume: noop,
      onOpenTask: noop,
      onNavigateEntity: noop,
      ...overrides,
    } as never),
  );

// Fixture: dispatch_1b5ff88e064cff106424764a.jsonl (agy, gemini-3.8-flash-high), trimmed.
describe("agy session transcript and consumption", () => {
  it("maps persisted AGY steps into text, tool calls, and the final result instead of raw JSON", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.001Z",
        event: { event: "init", conversation_id: "60edfe99", init: { model: "gemini-3.8-flash-high" } },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.002Z",
        event: {
          event: "step_update",
          step_update: {
            conversation_id: "60edfe99",
            step_index: 1,
            state: "ACTIVE",
            step_type: "agent_response",
            text_delta: "Rebasing `codex/agy-token-usage` onto `origin/main`. ",
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.003Z",
        event: {
          event: "step_update",
          step_update: {
            conversation_id: "60edfe99",
            step_index: 1,
            state: "DONE",
            step_type: "agent_response",
            text_delta: "I will proceed once the rebase finishes.\n",
            usage: {},
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.004Z",
        event: {
          event: "step_update",
          step_update: {
            conversation_id: "60edfe99",
            step_index: 2,
            state: "ACTIVE",
            step_type: "tool",
            tool_name: "view_file",
            tool_info: { name: "view_file", parameters: { AbsolutePath: "task_plan.md" } },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.005Z",
        event: {
          event: "step_update",
          step_update: {
            conversation_id: "60edfe99",
            step_index: 2,
            state: "DONE",
            step_type: "tool",
            tool_name: "view_file",
            duration_seconds: 0.034432,
            tool_info: {
              name: "view_file",
              parameters: { AbsolutePath: "task_plan.md" },
              output: "78 lines, 5003 bytes",
            },
          },
        },
      },
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:00.006Z",
        event: {
          event: "result",
          result: {
            conversation_id: "60edfe99",
            status: "SUCCESS",
            response: "Scanning dispatches for non-zero token metrics.",
            num_turns: 1,
            usage: {},
          },
        },
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("completed");
    expect(turns[0]?.endedAt).toBe("2026-09-13T00:00:00.006Z");
    expect(turns[0]?.items.map(({ type, label, detail }) => ({ type, label, detail }))).toEqual([
      {
        type: "text",
        label: "text",
        detail: "Rebasing `codex/agy-token-usage` onto `origin/main`. I will proceed once the rebase finishes.\n",
      },
      { type: "tool_call", label: "view_file", detail: '{\n  "AbsolutePath": "task_plan.md"\n}' },
      { type: "tool_result", label: "view_file", detail: "78 lines, 5003 bytes" },
      { type: "text", label: "result", detail: "Scanning dispatches for non-zero token metrics." },
    ]);
    expect(turns[0]?.items.map(({ summary }) => summary).join("\n")).not.toContain('{"event"');
  });

  it("marks the AGY turn failed when the result status is not SUCCESS", () => {
    const turns = sessionTranscriptTurns([
      {
        kind: "provider_event",
        occurredAt: "2026-09-13T00:00:01.000Z",
        event: {
          event: "result",
          result: { status: "ERROR", response: "Partial scan before the failure.", error: "quota exceeded" },
        },
      },
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.status).toBe("failed");
    expect(turns[0]?.items).toHaveLength(1);
    expect(turns[0]?.items[0]).toMatchObject({ type: "text", label: "result" });
  });

  it("states tokens are unavailable instead of zero when the provider reports no usage", () => {
    const markup = detailView({
      session: {
        ...sessionDto,
        metrics: {
          inputTokens: 0,
          cacheReadTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          toolCallCount: 160,
          compacted: false,
          usageUnavailable: true,
        },
      },
    });
    expect(markup).toContain('data-testid="session-metrics-unavailable"');
    expect(markup).toContain("Token usage");
    expect(markup).toContain("Unavailable (provider reports no tokens)");
    expect(markup).toContain("160");
    expect(markup).not.toContain("Input tokens");
    expect(markup).not.toContain("Total tokens");
  });
});
