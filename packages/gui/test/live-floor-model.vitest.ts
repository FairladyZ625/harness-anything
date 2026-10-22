// harness-test-tier: fast
import { describe, expect, it } from "vitest";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow } from "../src/api/renderer-dto.ts";
import { liveFloorActionSummary, liveFloorRows, readableModelName } from "../src/renderer/views/live-floor-model.ts";
import { NO_WORKS, type WorkIndex } from "../src/renderer/model/work-collections.ts";

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
});
