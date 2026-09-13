import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, vi } from "vitest";
import { TaskDetailView } from "../src/renderer/views/TaskDetailView.tsx";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";

export const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];
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
  definitionSnapshotPersisted: true,
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
    missingEvidence: null,
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

export const task: TaskRow = {
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
  ...projectedTaskFields("in_review"),
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
export const parent = { ...task, taskId: "task-parent", title: "PLT GUI UX", parentTaskId: undefined };
export const child = { ...task, taskId: "task-child", title: "下游可用性验证", parentTaskId: "task-w3" };
export const decision: DecisionRow = {
  ...decisionProjectionFields("proposed"),
  decisionId: "dec-gui",
  title: "GUI 只展示后端结构化结果",
  state: "in_effect",
  question: "逻辑放在哪里？",
  chosen: [],
  rejected: [],
  claims: [],
  judgmentConsents: [],
};
export function prepareDetailEnvironment() {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
}

export async function cleanupMountedDetail() {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
}

export function installBridge({
  uncommittedPlan = false,
  completionAction = "Center completion action",
  completionBlocker = { code: "closeout_placeholder", gate: "closeout" },
}: {
  readonly uncommittedPlan?: boolean;
  /** `repo.tasks.completion.read` 的 next 动作原样透传;null = 无待办(next/blocker 均为 null)。 */
  readonly completionAction?: string | null;
  /** 同一读结果的结构化 blocker;面板按 code 判别阶段,与 action 文案解耦。 */
  readonly completionBlocker?: { readonly code: string; readonly gate: string } | null;
} = {}) {
  const bridge = {
    getTaskCompletion: vi.fn(async ({ taskId }: { taskId: string }) => ({
      ok: true,
      taskId,
      ...(completionAction === null
        ? { completionNext: null, completionBlocker: null }
        : {
            completionNext: {
              reason: "Center completion reason",
              action: completionAction,
              authority: "task owner",
              readCut: { revision: 7, iteration: 0, executionId: "execution-w3" },
            },
            completionBlocker,
          }),
    })),
    getTaskDocument: vi.fn(async ({ taskId, path }: { taskId: string; path: string }) => {
      // 二进制产物的读侧回答:没有正文,带媒体类型/字节数/内容地址/仓库路径与 canonical 字节。
      const binary = path.endsWith(".pdf");
      return {
        ok: true,
        status: "ready",
        taskId,
        path,
        body: binary
          ? ""
          : path === "task_plan.md"
            ? "# Canonical plan body"
            : path.endsWith(".html")
              ? '<style>body{color:#123}</style><h1>Night report</h1><script>window.open("https://example.invalid")</script>'
              : `# ${path}`,
        blobSha256: `sha256:${"d".repeat(64)}`,
        contentKind: binary ? "binary" : "text",
        mediaType: binary ? "application/octet-stream" : "text/markdown",
        size: binary ? 4096 : 20,
        bytes: binary ? Buffer.from("%PDF-1.7").toString("base64") : null,
        repositoryPath: `harness/tasks/task-w3-night/${path}`,
        worktreeBody: uncommittedPlan && path === "task_plan.md" ? "# Live worktree plan body" : null,
        uncommitted: uncommittedPlan && path === "task_plan.md",
        watermark: 7,
        sourceRevision: 7,
      };
    }),
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
        {
          path: "artifacts/reports/dossier.pdf",
          blobSha256: "b".repeat(64),
          size: 4096,
          mediaType: "application/octet-stream",
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
          current: true,
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
          current: true,
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
          invalidated: false,
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
          invalidated: false,
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

let onOpenTerminal: ((task: TaskRow) => void) | undefined;

export function setDetailOpenTerminal(handler: ((task: TaskRow) => void) | undefined) {
  onOpenTerminal = handler;
}

export async function mount(
  overrides: {
    readonly task?: TaskRow;
    readonly onComplete?: (consent: boolean) => Promise<unknown>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div"),
    root = createRoot(container);
  const mountedTask = overrides.task ?? task;
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TaskDetailView, {
          task: mountedTask,
          tasks: [parent, task, child],
          relations: [],
          decisions: [decision],
          onBack: () => undefined,
          onSelect: () => undefined,
          onNavigateDecision: () => undefined,
          onNavigateEntity: () => undefined,
          onOpenTerminal,
          onComplete: overrides.onComplete,
          projectName: "Harness",
        }),
      ),
    );
  });
  await flushEffects();
}

export async function clickTab(label: string) {
  const tab = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
    button.textContent?.includes(label),
  );
  expect(tab, `missing tab ${label}`).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    tab!.click();
  });
  await flushEffects();
}

export async function flushEffects() {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}
