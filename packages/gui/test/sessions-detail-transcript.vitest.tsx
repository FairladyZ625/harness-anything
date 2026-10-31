// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionsPanel } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { harnessClient } from "../src/renderer/api-client.ts";
import type { ObserveTailRead } from "../src/api/renderer-dto.ts";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import { sessionDispatchIdOf, type SessionRow } from "../src/renderer/sessions-model.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

/**
 * 会话详情必须回答「这次会话调用了什么、最后结论是什么」(业主 2026-10-21 13:50 定案;
 * GUI 验收 R4)。工具调用的转写读的是派工流,派工 id 只有两个来源:
 *  - 展开的轮次行自带 dispatchId;
 *  - 组还没展开、或会话落在列表之外时,daemon 会话读面的 attemptChain 仍指着它自己的派工。
 * 修前只认第一种,于是首屏选中的会话(组未展开)详情里永远没有工具调用卡——验收截图
 * 里写着「工具调用 207」却看不到一张卡。这里锁住两条来源与「认不出就不猜」的边界。
 */

const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "ds-harness-api",
  installationId: "installation-ds",
  kindId: "deepseek-harness",
  providerId: "deepseek-official",
  model: '["deepseek-official","Deepseek-V4.1-Flash"]',
  reasoningEffort: null,
  baseUrl: null,
  authMode: "api-key",
} as const;

const attempt = (dispatchId: string, runtimeSessionId: string) => ({
  dispatchId,
  runtimeSessionId,
  attemptIndex: 0,
  provider: { instance: "ds-harness-api", model: "Deepseek-V4.1-Flash" },
  classification: "worker_stop" as const,
  reason: null,
  resume: null,
  fallbackState: null,
  nextDispatchId: null,
});

const sessionDto: AgentRuntimeSessionDto = {
  runtimeSessionId: "runtime_probe0000000000000000",
  providerSessionId: "provider-uuid-should-not-render",
  instanceId: "ds-harness-api",
  installationId: "installation-ds",
  kindId: "deepseek-harness",
  definitionSnapshotRef: "artifact:runtime-definition/probe",
  definitionSnapshot: definition,
  definitionSnapshotPersisted: true,
  liveness: "exited",
  semanticState: "succeeded",
  attachCapability: "unsupported",
  streamCursor: null,
  associations: [],
  attemptChain: {
    attemptGroupId: "dispatch_probe000000000000000",
    attempts: [attempt("dispatch_probe000000000000000", "runtime_probe0000000000000000")],
  },
  activity: {
    lastObservedAt: "2026-10-21T09:40:54.138Z",
    outcome: "succeeded",
    exitCode: 0,
    resultRef: "artifact:runtime-result/sha256/deadbeef",
    missingEvidence: null,
  },
} as AgentRuntimeSessionDto;

/** 一条真实的 provider tool_use/tool_result 对:sessions-grouping 夹具与生产派工流同形。 */
const toolCallRecords = [
  {
    kind: "provider_event",
    occurredAt: "2026-10-21T09:39:00.000Z",
    event: {
      type: "assistant",
      message: {
        id: "msg-probe",
        content: [
          { type: "text", text: "I'll read the plan first." },
          { type: "tool_use", id: "call-read", name: "Read", input: { file_path: "task_plan.md" } },
        ],
      },
    },
  },
  {
    kind: "provider_event",
    occurredAt: "2026-10-21T09:39:01.000Z",
    event: {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "call-read", content: "Task contract." }] },
    },
  },
] as const;

function historyPage(payload: { readonly repoId: string; readonly direction: "history" | "follow" }): ObserveTailRead {
  return {
    schema: "daemon.observe-tail/v3",
    ok: true,
    repoId: payload.repoId,
    mode: "local",
    kind: "dispatch",
    direction: payload.direction,
    status: "ready",
    items: payload.direction === "history" ? ([...toolCallRecords] as never) : [],
    historyCursor: null,
    liveCursor: null,
    sourceCursor: null,
    done: true,
  };
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

const mounted: { readonly root: Root; readonly container: HTMLElement }[] = [];

async function mountPanel(
  row: SessionRow | null,
  session: AgentRuntimeSessionDto = sessionDto,
  options: { readonly snapshotError?: string; readonly remoteEdge?: boolean } = {},
) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    },
  );
  const tail = vi.spyOn(harnessClient, "tailObservability").mockImplementation(async (payload) => historyPage(payload));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      createElement(SessionsPanel, {
        repoId: "repo-a",
        runtimeSessionId: session.runtimeSessionId,
        snapshot:
          options.snapshotError === undefined
            ? {
                ok: true,
                status: "ready",
                session,
                result: null,
                settlement: null,
                watermark: 1,
                sourceRevision: 1,
              }
            : null,
        snapshotError: options.snapshotError ?? null,
        row,
        squadNames: new Map(),
        decisionRefs: [],
        busy: false,
        onCancel: () => undefined,
        onResume: async () => undefined,
        onOpenTask: () => undefined,
        onNavigateEntity: () => undefined,
        remoteEdge: options.remoteEdge ?? false,
      } as never),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { container, tail };
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("session detail dispatch resolution", () => {
  it("explains that a listed center session has no runtime detail in the edge replica", async () => {
    const { container } = await mountPanel(null, sessionDto, {
      snapshotError: "runtime_session_not_found: Runtime session runtime-bound was not found.",
      remoteEdge: true,
    });

    expect(container.querySelector('[data-testid="session-detail-edge-unavailable"]')?.textContent).toContain(
      "runtime details are not replicated to this edge",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("prefers the expanded round row's dispatch", () => {
    const row = {
      kind: "round",
      dispatchId: "dispatch_row00000000000000000",
      runtimeSessionId: sessionDto.runtimeSessionId,
    } as SessionRow;
    expect(sessionDispatchIdOf(sessionDto, row)).toBe("dispatch_row00000000000000000");
  });

  it("falls back to the attempt chain when the group is not expanded", () => {
    expect(sessionDispatchIdOf(sessionDto, null)).toBe("dispatch_probe000000000000000");
  });

  it("does not guess when the chain names a different session", () => {
    const chain = {
      attemptGroupId: "dispatch_other000000000000000",
      attempts: [attempt("dispatch_other000000000000000", "runtime_someoneelse000000000")],
    };
    expect(sessionDispatchIdOf({ ...sessionDto, attemptChain: chain }, null)).toBeNull();
    expect(sessionDispatchIdOf({ ...sessionDto, attemptChain: undefined }, null)).toBeNull();
  });
});

describe("session detail transcript", () => {
  it("renders the tool calls of a selected session whose group is not expanded", async () => {
    const { container, tail } = await mountPanel(null);
    expect(tail).toHaveBeenCalled();
    expect(tail.mock.calls[0]?.[0]).toMatchObject({ kind: "dispatch", dispatchId: "dispatch_probe000000000000000" });
    expect(container.querySelector('[data-testid="session-transcript-tool_call"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="toolcall-card"]')).not.toBeNull();
    expect(container.textContent).toContain("Read");
    // 工具调用的参数与结果都在卡里,不是原始事件倾倒。
    expect(container.textContent).not.toContain('"type":"tool_use"');
  });

  it("reads no dispatch and draws no cards when nothing identifies one", async () => {
    const { container, tail } = await mountPanel(null, { ...sessionDto, attemptChain: undefined });
    expect(tail).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="session-transcript"]')).toBeNull();
    expect(container.querySelector('[data-testid="session-transcript-tool_call"]')).toBeNull();
  });
});
