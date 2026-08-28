// harness-test-tier: integration
// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import type { DecisionRow, RelationEdge, TaskRow } from "../src/renderer/model/types.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];
const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-work",
  installationId: "codex-install",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6",
  reasoningEffort: "high",
  baseUrl: null,
  authMode: "subscription",
} as const;
const session = {
  runtimeSessionId: "runtime-w3",
  providerSessionId: "provider-w3",
  instanceId: "codex-work",
  installationId: "codex-install",
  kindId: "codex",
  definitionSnapshotRef: "artifact:definition/w3",
  definitionSnapshot: definition,
  liveness: "exited",
  attachCapability: "supported",
  streamCursor: "stream:4",
  associations: [
    {
      taskId: "task-w3",
      executionId: "execution-w3",
      holder: { personId: "person-owner", executorId: "codex-worker" },
      lease: null,
    },
  ],
  activity: {
    lastObservedAt: "2026-08-23T10:30:00.000Z",
    outcome: "succeeded",
    exitCode: 0,
    resultRef: "artifact:result/w3",
  },
} as const;
const dispatch = {
  dispatchId: "dispatch-w3",
  taskId: "task-w3",
  executionId: "execution-w3",
  runtimeSessionId: "runtime-w3",
  instanceId: "codex-work",
  agentId: "codex-worker",
  agentName: "Codex Worker",
  delegatedByAgentId: "claude-ceo",
  delegatedByAgentName: "Claude CEO",
  squadId: "squad-plt",
  providerSessionId: "provider-w3",
  eventStreamRef: "events/runtime-w3",
  startedAt: "2026-08-23T09:00:00.000Z",
  endedAt: "2026-08-23T10:30:00.000Z",
  outcome: "succeeded",
  status: "succeeded",
} as const;

const task: TaskRow = {
  taskId: "task-w3",
  title: "Task 表达重做",
  projectId: "repo-a",
  coordinationStatus: "in_review",
  canonicalStatus: "in_review",
  rawStatus: "in_review/review",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "ready",
  engine: "kernel/task-lifecycle/v1",
  origin: "native",
  source: "local-document",
  module: "gui",
  moduleKeys: ["gui"],
  productLines: ["platform"],
  packagePath: "tasks/task-w3-expression",
  taskClass: "standard",
  workKind: "feat",
  vertical: "software-coding",
  preset: "plt-gui",
  profile: "default",
  createdBy: "person-owner",
  currentNode: "review",
  iteration: 0,
  riskTier: "high",
  urgency: "high",
  parentTaskId: "task-parent",
  rootTaskId: "task-parent",
  rootTitle: "PLT GUI UX",
  createdAt: "2026-08-23T08:00:00.000Z",
  lastKnownAt: "2026-08-23T10:31:00.000Z",
  closeoutBlocker: undefined,
  snapshotAvailability: { consents: "known", codeDocWitnesses: "known", gateWitnesses: "known" },
  // W5:执行证据页并入「收口」——execution 输出/回执经 task-adapter 原样透传。
  executions: [
    {
      schema: "execution/v1",
      executionId: "execution-w3",
      taskId: "task-w3",
      nodeId: "implementation",
      iteration: 0,
      state: "submitted",
      actor: { principal: { personId: "person-owner" }, executor: { kind: "agent", id: "codex-worker" } },
      claimedAt: "2026-08-23T09:00:00.000Z",
      submittedAt: "2026-08-23T10:00:00.000Z",
      closedAt: null,
      submission: {
        completionClaim: "done",
        deliverables: ["report"],
        outputs: ["artifacts/report.md"],
        verificationNotes: [],
        knownGaps: [],
        residualRisks: [],
        commitSha: "a".repeat(40),
      },
    },
  ],
  executionEvidence: [
    {
      executionId: "execution-w3",
      origin: "native",
      outputs: [
        {
          evidenceId: `evidence_${"1".repeat(24)}`,
          locator: "artifacts/report.md",
          substrate: "repository-path",
          checkerReceiptRef: "receipt-dom",
          checkerResult: "pass",
        },
      ],
    },
  ],
  gates: [{ name: "local-check", ok: true }],
  docs: [],
  events: [
    { projectId: "repo-a", taskId: "task-w3", at: "2026-08-23T10:20:00.000Z", summary: "Review review-w3: approved" },
  ],
  reviews: [
    {
      schema: "review/v1",
      reviewId: "review-w3",
      taskId: "task-w3",
      executionId: "execution-w3",
      verdict: "approved",
      actor: { principal: { personId: "reviewer" }, executor: null },
      capabilityRef: "review@v1",
      reason: "UI evidence is complete",
      evidenceChecked: ["task-detail DOM"],
      commitSha: "a".repeat(40),
      iteration: 0,
      contentDigest: `sha256:${"b".repeat(64)}`,
      reviewedAt: "2026-08-23T10:20:00.000Z",
    },
  ],
  consents: [
    {
      schema: "review-consent/v1",
      consentId: "consent-w3",
      taskId: "task-w3",
      executionId: "execution-w3",
      reviewId: "review-w3",
      reviewDigest: `sha256:${"c".repeat(64)}`,
      contentDigest: `sha256:${"b".repeat(64)}`,
      actor: { principal: { personId: "person-owner" }, executor: null },
      source: "local",
      consentedAt: "2026-08-23T10:22:00.000Z",
    },
  ],
  codeDocWitnesses: [],
  gateWitnesses: [],
};
const parent = { ...task, taskId: "task-parent", title: "PLT GUI UX", parentTaskId: undefined };
const child = { ...task, taskId: "task-child", title: "下游可用性验证", parentTaskId: "task-w3" };
const decision: DecisionRow = {
  decisionId: "dec-gui",
  title: "GUI 只展示后端结构化结果",
  state: "in_effect",
  question: "逻辑放在哪里？",
  chosen: [],
  rejected: [],
  claims: [],
  judgmentConsents: [],
};
const relations: RelationEdge[] = [
  {
    relationId: "rel-gui",
    from: "decision/dec-gui",
    to: "task/task-w3",
    kind: "derives",
    direction: "directed",
    state: "active",
    provenance: "local-document",
    rationale: "UI boundary",
  },
];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(async () => {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("Task detail expression", () => {
  it("renders compact task identity, six task-first tabs and a permanent document tree", async () => {
    const bridge = installBridge();
    await mount();

    expect(byTestId("task-identity-strip").textContent).toContain("person-owner · standard");
    expect(byTestId("task-identity-strip").textContent).toContain("plt-gui · software-coding");
    expect(byTestId("task-detail-view").textContent).toContain("Task 表达重做");
    expect([...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())).toEqual([
      "概况",
      "派工",
      "证据",
      "关系",
      "收口",
      "文件",
    ]);
    expect(byTestId("task-document-tree").textContent).toContain("artifacts");
    expect(byTestId("task-overview-tab").textContent).toContain("Canonical plan body");
    expect(byTestId("task-progress-timeline").textContent).toContain("Review review-w3: approved");
    expect(bridge.getTaskDocument).toHaveBeenCalledWith({ repoId: "repo-a", taskId: "task-w3", path: "task_plan.md" });
    expect(bridge.getTaskDocument.mock.calls.some(([payload]) => payload.path === "task-contract.json")).toBe(false);
  });

  it("renders structured dispatch, facts, relations, closeout and projected files", async () => {
    installBridge();
    await mount();

    await clickTab("派工");
    expect(byTestId("task-dispatch-tab").textContent).toContain("Codex Worker");
    expect(byTestId("task-dispatch-tab").textContent).toContain("Rendered runtime report");
    expect(byTestId("task-dispatch-tab").textContent).toContain("runtime_session_exited");

    await clickTab("证据");
    expect(byTestId("task-evidence-tab").textContent).toContain("Frontend consumes structured projections only");
    expect(byTestId("task-evidence-tab").textContent).toContain("source: review/dom");
    expect(byTestId("task-evidence-tab").textContent).toContain("standing");
    // W5:事实分诊并入——低置信 fact 带 triage 信号 badge 且排到 healthy fact 之前。
    expect(byTestId("task-evidence-tab").textContent).toContain("低 confidence");
    expect(byTestId("task-evidence-tab").textContent).toContain("1 条带信号 · 1 healthy");
    expect(byTestId("task-evidence-tab").textContent.indexOf("Confidence is low, needs a human recheck")).toBeLessThan(
      byTestId("task-evidence-tab").textContent.indexOf("Frontend consumes structured projections only"),
    );
    expect(document.querySelector("[data-testid='task-fact-detail-F-LOW']")).toBeInstanceOf(HTMLButtonElement);

    await clickTab("关系");
    expect(byTestId("task-relations-tab").textContent).toContain("PLT GUI UX");
    expect(byTestId("task-relations-tab").textContent).toContain("GUI 只展示后端结构化结果");
    expect(byTestId("task-relations-tab").textContent).toContain("runtime-w3");

    await clickTab("收口");
    expect(byTestId("task-closeout-tab").textContent).toContain("review-w3");
    expect(byTestId("task-closeout-tab").textContent).toContain("consent-w3");
    expect(byTestId("task-closeout-tab").textContent).toContain("local-check");
    // W5:执行证据并入——execution 输出与回执按 execution 对齐展示。
    expect(byTestId("task-closeout-tab").textContent).toContain("Execution 输出");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("execution-w3");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("evidence_111111111111111111111111");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("receipt-dom");
    expect(byTestId("task-execution-execution-w3").textContent).toContain("1 passing");

    await clickTab("文件");
    expect(byTestId("task-document-tree").textContent).toContain("INDEX.md");
    expect(byTestId("task-document-tree").textContent).toContain("artifacts");
    expect(byTestId("task-files-tab").textContent).toContain("Canonical plan body");
  });

  it("renders live worktree content and marks an unsynced task document", async () => {
    installBridge({ uncommittedPlan: true });
    await mount();

    await clickTab("文件");
    expect(byTestId("task-files-tab").textContent).toContain("Live worktree plan body");
    expect(byTestId("task-files-tab").textContent).not.toContain("Canonical plan body");
    expect(byTestId("task-document-uncommitted").textContent).toContain("工作树内容尚未提交");
    expect(byTestId("doc-uncommitted-task_plan.md").textContent).toContain("未提交");
  });

  it("adapts the detail card and reader to container width; manual layout controls still override", async () => {
    installBridge();
    await mount();

    // 详情卡铺满可用宽度:不再有 max-w 居中收口;main 是容器量尺,断带挂在卡片网格上。
    const scrollPanel = byTestId("task-detail-panel-scroll");
    const card = scrollPanel.parentElement!;
    expect(card.className).not.toMatch(/max-w-|mx-auto/u);
    expect(card.className).toContain("grid-cols-1");
    expect(card.className).toContain("@min-[1100px]:grid-cols-[14rem_minmax(0,1fr)]");
    expect(scrollPanel.closest("main")?.className).toContain("@container");
    // 叠放带里文件树是 auto 行:量高 18rem 内部滚动,文件多的任务包不会挤死正文。
    expect(byTestId("task-document-tree").className).toContain("@max-[1100px]:max-h-72");

    // 概况:时间线并入分区/右侧 inspector,不再独占整列。
    const overview = byTestId("task-overview-tab");
    expect(overview.className).toContain("@min-[1600px]:grid-cols-[minmax(0,1fr)_19rem]");
    expect(byTestId("task-progress-timeline").closest("aside")).toBe(overview.querySelector("aside"));

    // 阅读栏数默认「自适应」:容器查询驱动(styles.css 的 .doc-flow),无需点击。
    const toolbar = byTestId("reader-floating-toolbar");
    const layoutButton = (label: string) =>
      [...toolbar.querySelectorAll("button")].find((button) => button.textContent === label)!;
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("auto");
    expect(document.querySelector(".doc-flow")?.contains(document.querySelector(".prose-harness"))).toBe(true);

    // 单栏/双栏控件保留:手动选择覆盖自适应,并可切回。
    await act(async () => {
      layoutButton("双栏").click();
    });
    expect(layoutButton("双栏").getAttribute("aria-pressed")).toBe("true");
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("double");
    await act(async () => {
      layoutButton("单栏").click();
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("single");
    await act(async () => {
      layoutButton("自适应").click();
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-layout")).toBe("auto");

    const font = toolbar.querySelector("select")!;
    await act(async () => {
      font.value = "serif";
      font.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(document.querySelector(".prose-harness")?.getAttribute("data-font")).toBe("serif");

    const reports = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("reports/"),
    )!;
    expect(reports).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      reports.click();
    });
    const html = [...byTestId("task-document-tree").querySelectorAll("button")].find((button) =>
      button.textContent?.includes("night.html"),
    )!;
    expect(html).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      html.click();
    });
    await flushEffects();

    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain("文件");
    expect(reports.getAttribute("aria-expanded")).toBe("true");
    const preview = byTestId("html-artifact-preview");
    expect(preview.textContent).toContain("脚本 / 外联已禁用");
    const webview = byTestId("html-artifact-webview");
    expect(webview.getAttribute("partition")).toBe("html-artifact-preview");
    expect(webview.getAttribute("preload")).toBeNull();
    expect(webview.getAttribute("src")).toMatch(/^data:text\/html;charset=utf-8,/u);
  });
});

function installBridge({ uncommittedPlan = false }: { readonly uncommittedPlan?: boolean } = {}) {
  const bridge = {
    getTaskDocument: vi.fn(async ({ taskId, path }: { taskId: string; path: string }) => ({
      ok: true,
      status: "ready",
      taskId,
      path,
      body:
        path === "task_plan.md"
          ? "# Canonical plan body"
          : path.endsWith(".html")
            ? '<style>body{color:#123}</style><h1>Night report</h1><script>window.open("https://example.invalid")</script>'
            : `# ${path}`,
      blobSha256: `sha256:${"d".repeat(64)}`,
      worktreeBody: uncommittedPlan && path === "task_plan.md" ? "# Live worktree plan body" : null,
      worktreeBlobSha256: uncommittedPlan && path === "task_plan.md" ? "e".repeat(64) : null,
      uncommitted: uncommittedPlan && path === "task_plan.md",
      watermark: 7,
      sourceRevision: 7,
    })),
    getTaskDocuments: vi.fn(async () => ({
      ok: true,
      status: "ready",
      taskId: "task-w3",
      documents: [
        {
          path: "task_plan.md",
          blobSha256: "d".repeat(64),
          size: 20,
          mediaType: "text/markdown",
          uncommitted: uncommittedPlan,
        },
        { path: "INDEX.md", blobSha256: "e".repeat(64), size: 20, mediaType: "text/markdown", uncommitted: false },
        {
          path: "artifacts/report.md",
          blobSha256: "f".repeat(64),
          size: 20,
          mediaType: "text/markdown",
          uncommitted: false,
        },
        {
          path: "artifacts/reports/night.html",
          blobSha256: "a".repeat(64),
          size: 120,
          mediaType: "text/html",
          uncommitted: false,
        },
      ],
      watermark: 7,
      sourceRevision: 7,
    })),
    getTaskDispatches: vi.fn(async () => ({
      ok: true,
      status: "ready",
      taskId: "task-w3",
      dispatches: [dispatch],
      watermark: 7,
      sourceRevision: 7,
    })),
    getRelationGraph: vi.fn(async () => ({
      ok: true,
      edges: [
        {
          relationId: "rel-produced-dom",
          sourceRef: "task/task-w3",
          targetRef: "fact/F-DOM",
          relationType: "produces",
          direction: "directed",
          strength: "strong",
          origin: "generated",
          state: "active",
          rationale: "task evidence",
          ownerRef: "task/task-w3",
          sourcePath: "event:task/task-w3",
          recordIndex: 0,
        },
        {
          relationId: "rel-produced-low",
          sourceRef: "task/task-w3",
          targetRef: "fact/F-LOW",
          relationType: "produces",
          direction: "directed",
          strength: "strong",
          origin: "generated",
          state: "active",
          rationale: "task evidence",
          ownerRef: "task/task-w3",
          sourcePath: "event:task/task-w3",
          recordIndex: 1,
        },
      ],
      coverageRows: [],
      factAnchors: [],
      facts: [
        {
          schema: "task-fact-row/v1",
          ref: "fact/F-DOM",
          taskId: "task-w3",
          factId: "F-DOM",
          statement: "Frontend consumes structured projections only",
          source: "review/dom",
          observedAt: "2026-08-23T10:10:00.000Z",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: ["gui"],
          provenance: [],
          liveness: "standing",
        },
        {
          schema: "task-fact-row/v1",
          ref: "fact/F-LOW",
          taskId: "task-w3",
          factId: "F-LOW",
          statement: "Confidence is low, needs a human recheck",
          source: "review/dom",
          observedAt: "2026-08-23T10:11:00.000Z",
          confidence: "low",
          memoryClass: "episodic",
          memoryTags: ["gui"],
          provenance: [],
          liveness: "standing",
        },
      ],
      warnings: [],
    })),
    getAgentRuntimeSessionGroups: vi.fn(async () => ({
      ok: true,
      status: "ready",
      groups: [],
      totals: { groups: 0, sessions: 0 },
      truncated: false,
      watermark: 7,
      sourceRevision: 7,
    })),
    getAgentRuntimeOverview: vi.fn(async () => ({
      ok: true,
      status: "ready",
      installations: [],
      instances: [],
      sessions: [session],
      watermark: 7,
      sourceRevision: 7,
    })),
    getAgentRuntimeSession: vi.fn(async () => ({
      ok: true,
      status: "ready",
      session,
      result: { ref: "artifact:result/w3", text: "Rendered runtime report" },
      watermark: 7,
      sourceRevision: 7,
    })),
    getAgentRuntimeEvents: vi.fn(async () => ({
      ok: true,
      runtimeSessionId: "runtime-w3",
      events: [
        {
          cursor: "lifecycle:7",
          runtimeSessionId: "runtime-w3",
          type: "runtime_session_exited",
          occurredAt: "2026-08-23T10:30:00.000Z",
        },
      ],
      cursor: "lifecycle:7",
      sourceCursor: "lifecycle:7",
      done: true,
    })),
  };
  vi.stubGlobal("window", { harness: bridge, addEventListener: () => undefined, removeEventListener: () => undefined });
  return bridge;
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskDetailView, {
          task,
          tasks: [parent, task, child],
          relations,
          decisions: [decision],
          onBack: () => undefined,
          onSelect: () => undefined,
          onNavigateDecision: () => undefined,
          onNavigateEntity: () => undefined,
          projectName: "Harness",
        }),
      ),
    );
  });
  await flushEffects();
}

async function clickTab(label: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
    button.textContent?.includes(label),
  );
  expect(tab, `missing tab ${label}`).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    tab!.click();
  });
  await flushEffects();
}

async function flushEffects() {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}
