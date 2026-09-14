// harness-test-tier: integration
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { resumeRuntimeSpawnInput } from "../src/renderer/runtime-control.ts";

beforeAll(() => setActiveLocale("en-US"));

const session = {
  runtimeSessionId: "runtime-resume",
  providerSessionId: "provider-resume",
  instanceId: "codex-resume",
  installationId: "installation-resume",
  kindId: "codex",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: null,
  definitionSnapshotPersisted: false,
  liveness: "exited",
  attachCapability: "supported",
  streamCursor: "stream:1",
  associations: [],
  activity: {
    lastObservedAt: "2026-09-14T00:00:00.000Z",
    outcome: "failed",
    exitCode: 1,
    resultRef: null,
    missingEvidence: null,
  },
} as const;
const row = {
  kind: "round",
  runtimeSessionId: session.runtimeSessionId,
  dispatchId: "dispatch_0123456789abcdef01234567",
  taskId: "task-resume",
  taskTitle: "Resume task",
  agentName: "terra",
  agentId: "terra",
  squadId: null,
  instanceId: session.instanceId,
  startedAt: session.activity.lastObservedAt,
  status: "failed",
  classification: "provider_quota",
  nextAction: null,
  resume: { dispatchId: "dispatch_0123456789abcdef01234567", agentId: "terra" },
  delegation: null,
} as const;

describe("runtime resume", () => {
  it("renders solely from daemon resume and routes the source dispatch unchanged", () => {
    const markup = renderToStaticMarkup(
      createElement(SessionDetailView, {
        session,
        row,
        squadNames: new Map(),
        decisionRefs: [],
        result: null,
        transcript: null,
        busy: false,
        onCancel: () => undefined,
        onResume: async () => undefined,
        onOpenTask: () => undefined,
        onNavigateEntity: () => undefined,
      } as never),
    );
    expect(markup).toContain('data-testid="agent-runtime-resume"');
    expect(resumeRuntimeSpawnInput(row.resume.dispatchId, "once")).toEqual({
      resumeDispatchId: row.resume.dispatchId,
      idempotencyKey: "once",
    });
  });
});
