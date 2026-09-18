// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { AttestationPoolView } from "../src/renderer/views/AttestationPoolView.tsx";
import type { AttestationPoolTabId } from "../src/renderer/model/attestation-pool.ts";
import type { DecisionRow, TaskRow } from "../src/renderer/model/types.ts";
import { decisionProjectionFields } from "./decision-projection-fields.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: { readonly root: Root; readonly client: QueryClient }[] = [];

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
});

function submittedExecution(
  taskId: string,
  gateId: string,
  adapterId: string,
  governance: { readonly allowOverride?: true; readonly mandatorySignoff?: true } = {},
) {
  return {
    schema: "execution/v1",
    executionId: `execution-${taskId}`,
    taskId,
    nodeId: "implementation",
    iteration: 0,
    state: "submitted",
    actor: { principal: { personId: "person-owner" }, executor: null },
    claimedAt: "2026-09-16T09:00:00.000Z",
    submittedAt: "2026-09-16T10:00:00.000Z",
    closedAt: null,
    submission: {
      completionClaim: "done",
      deliverables: ["report"],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      commitSha: null,
      artifacts: [{ locator: "artifacts/report.md", accepted: true }],
      completionContract: {
        gates: [
          {
            gateId,
            appliesTo: "submission",
            witness: { adapterId, adapterOptions: {} },
            ...(governance.allowOverride ? { allowOverride: true } : {}),
            ...(governance.mandatorySignoff ? { mandatorySignoff: true } : {}),
          },
        ],
      },
    },
  };
}

const attestTask: TaskRow = {
  taskId: "task-attest",
  title: "手工验收任务",
  projectId: "repo-a",
  coordinationStatus: "in_review",
  rawStatus: "in_review/review",
  freshness: "fresh",
  packageDisposition: "active",
  closeoutReadiness: "incomplete",
  engine: "kernel/task-lifecycle/v1",
  origin: "native",
  source: "local-document",
  module: "gui",
  iteration: 0,
  lastKnownAt: "2026-09-16T10:31:00.000Z",
  gates: [{ name: "ux-signoff", ok: null, status: "missing" }],
  executions: [submittedExecution("task-attest", "ux-signoff", "manual-attest")],
  docs: [],
  ...projectedTaskFields("in_review"),
} as TaskRow;

const failedTask: TaskRow = {
  ...attestTask,
  taskId: "task-failed",
  title: "CI 失败任务",
  gates: [{ name: "ci-gate", ok: false, status: "failed", detail: "current execution cut did not pass" }],
  executions: [submittedExecution("task-failed", "ci-gate", "github-actions", { allowOverride: true })],
} as TaskRow;

const missingWitnessTask: TaskRow = {
  ...attestTask,
  taskId: "task-unavailable",
  title: "无自动见证任务",
  gates: [{ name: "e2e", ok: null, status: "missing", detail: "runner unreachable; no gate witness" }],
  executions: [submittedExecution("task-unavailable", "e2e", "local-command", { allowOverride: true })],
} as TaskRow;

const consentTask: TaskRow = {
  ...attestTask,
  taskId: "task-consent",
  title: "待同意任务",
  gates: [],
  executions: [submittedExecution("task-consent", "any", "manual-attest")],
  closeoutBlocker: "consent",
} as TaskRow;

const proposedDecision: DecisionRow = {
  ...decisionProjectionFields("proposed"),
  decisionId: "dec-pool",
  title: "总池里的待裁决策",
  state: "proposed",
  question: "先做哪一侧?",
  chosen: [],
  rejected: [],
  claims: [],
  judgmentConsents: [],
};

const summary = {
  total: 1,
  inboxCount: 1,
  byState: { proposed: 1, in_effect: 0, rejected: 0, deferred: 0, superseded: 0, outcome_retired: 0 },
  groups: [
    { id: "proposed", states: ["proposed"], count: 1, decisionIds: ["dec-pool"] },
    { id: "in_effect", states: ["in_effect"], count: 0, decisionIds: [] },
    { id: "rejected", states: ["rejected"], count: 0, decisionIds: [] },
    { id: "deferred", states: ["deferred"], count: 0, decisionIds: [] },
    { id: "retired", states: ["superseded", "outcome_retired"], count: 0, decisionIds: [] },
  ],
};

interface PoolHarness {
  readonly tabChanges: AttestationPoolTabId[];
  readonly attestCalls: { taskId: string; gateId: string; mode: string; rationale?: string }[];
  readonly consentCalls: { taskId: string; consent: boolean }[];
  readonly judged: { decisionId: string; action: string; rationale: string }[];
}

async function mountPool(
  initialTab: AttestationPoolTabId = "taskCloseout",
  tasks: readonly TaskRow[] = [attestTask, failedTask, consentTask],
): Promise<PoolHarness> {
  const harness: PoolHarness = { tabChanges: [], attestCalls: [], consentCalls: [], judged: [] };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root, client });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(AttestationPoolView, {
          repoId: "repo-a",
          decisions: [proposedDecision],
          summary,
          facts: [],
          relations: [],
          tasks,
          onAttest: (task, gateId, mode, rationale) => {
            harness.attestCalls.push({ taskId: task.taskId, gateId, mode, ...(rationale ? { rationale } : {}) });
            return Promise.resolve({
              state: "error",
              kind: "attest",
              opId: "op-1",
              code: "invalid_transition",
              hint: "this cut has no recorded automated fail or pass yet",
            });
          },
          onCompleteTask: (task, consent) => {
            harness.consentCalls.push({ taskId: task.taskId, consent });
            return Promise.resolve();
          },
          onNavigateTask: () => undefined,
          onNavigateDecision: () => undefined,
          onJudge: (decision, action, input) => {
            harness.judged.push({ decisionId: decision.decisionId, action, rationale: input.rationale });
            return Promise.resolve({ state: "success", kind: action, opId: "op-j", hint: "ok" });
          },
          poolTab: initialTab,
          onPoolTabChange: (tab) => harness.tabChanges.push(tab),
        }),
      ),
    );
  });
  await flushEffects();
  return harness;
}

async function flushEffects() {
  for (let index = 0; index < 3; index++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 同一测试内多次挂载前清场,避免旧池还留在 DOM 里把行数数翻倍。 */
async function unmountAll() {
  await act(async () => {
    for (const { root, client } of mounted.splice(0)) {
      root.unmount();
      client.clear();
    }
  });
  document.body.replaceChildren();
}

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

/** 从 tab/徽标文本尾部取计数(「<label> · N」/「共 N 项待办」)。 */
function tabCount(testId: string): number {
  const match = /(\d+)\s*(?:项待办)?\s*$/.exec(byTestId(testId).textContent ?? "");
  expect(match, `tab ${testId} text has no trailing count`).toBeTruthy();
  return Number(match![1]);
}

function totalCount(): number {
  const match = /共\s*(\d+)/.exec(byTestId("attestation-pool-total").textContent ?? "");
  expect(match, "pool total chip has no count").toBeTruthy();
  return Number(match![1]);
}

/** 当前视图实际渲染的 lane 行数(gates/breakGlass 行共用前缀,按动作按钮区分)。 */
function laneRowCounts(): { total: number; gates: number; consents: number; breakGlass: number } {
  const gates = document.querySelectorAll('[data-testid^="pool-gate-approve-"]').length,
    consents = document.querySelectorAll('[data-testid^="pool-consent-card-"]').length,
    breakGlass = document.querySelectorAll('[data-testid^="pool-gate-override-"]').length;
  return { total: gates + consents + breakGlass, gates, consents, breakGlass };
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AttestationPoolView", () => {
  it("renders the two-level domains with real counts and all lanes on the closeout overview", async () => {
    await mountPool("taskCloseout");
    // 第一级按域分:决策待裁(计数=kernel proposed 判定,与侧栏角标同读面)与任务收口。
    expect(byTestId("attestation-pool-domain-decisions").textContent).toMatch(/决策待裁\s*·\s*1(?=\s|$)/);
    expect(byTestId("attestation-pool-domain-taskCloseout").textContent).toMatch(/任务收口\s*·\s*3(?=\s|$)/);
    // 第二级只在任务收口域内:全览(三 lane 之和)+ 三个聚焦 lane。
    for (const [tab, count] of [
      ["taskCloseout", 3],
      ["gates", 1],
      ["consents", 1],
      ["breakGlass", 1],
    ] as const) {
      expect(byTestId(`attestation-pool-tab-${tab}`).textContent).toMatch(new RegExp(`\\S+\\s*·\\s*${count}(?=\\s|$)`));
    }
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
    expect(byTestId("pool-consent-card-task-consent")).toBeTruthy();
    expect(byTestId("pool-gate-row-task-failed-ci-gate")).toBeTruthy();
  });

  it("keeps every displayed count equal to its rendered list rows", async () => {
    // 决策域:域计数 == 默认 proposed 组渲染的决策卡数(计数与列表同源同判据)。
    await mountPool("decisions");
    expect(tabCount("attestation-pool-domain-decisions")).toBe(
      document.querySelectorAll('[id^="decision-card-"]').length,
    );
    expect(totalCount()).toBe(
      tabCount("attestation-pool-domain-decisions") + tabCount("attestation-pool-domain-taskCloseout"),
    );
    // 任务收口域:全览计数 == 三 lane 行数之和;每个聚焦 lane 计数 == 该 lane 行数。
    await unmountAll();
    await mountPool("taskCloseout");
    expect(tabCount("attestation-pool-domain-taskCloseout")).toBe(laneRowCounts().total);
    expect(tabCount("attestation-pool-tab-taskCloseout")).toBe(laneRowCounts().total);
    await unmountAll();
    await mountPool("gates");
    expect(tabCount("attestation-pool-tab-gates")).toBe(laneRowCounts().gates);
    await unmountAll();
    await mountPool("consents");
    expect(tabCount("attestation-pool-tab-consents")).toBe(laneRowCounts().consents);
    await unmountAll();
    await mountPool("breakGlass");
    expect(tabCount("attestation-pool-tab-breakGlass")).toBe(laneRowCounts().breakGlass);
  });

  it("keeps tab switches on the addressable location path, not internal state", async () => {
    const harness = await mountPool("taskCloseout");
    await act(async () => {
      byTestId("attestation-pool-tab-consents").click();
    });
    expect(harness.tabChanges).toEqual(["consents"]);
    // 受控组件:poolTab 仍是 "taskCloseout" 时 UI 不自行切换渲染。
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
  });

  it("renders only the requested lane on a focused tab", async () => {
    await mountPool("gates");
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
    expect(document.querySelector('[data-testid="pool-consent-card-task-consent"]')).toBeNull();
    expect(document.querySelector('[data-testid="decision-card-dec-pool"]')).toBeNull();
  });

  it("dispatches a manual-attest sign-off with the typed comment", async () => {
    const harness = await mountPool("gates");
    await act(async () => {
      byTestId("pool-gate-approve-task-attest-ux-signoff").click();
    });
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "体验走查通过,可以放行。");
    await act(async () => {
      byTestId("gate-attest-submit-approve").click();
    });
    expect(harness.attestCalls).toEqual([
      { taskId: "task-attest", gateId: "ux-signoff", mode: "approve", rationale: "体验走查通过,可以放行。" },
    ]);
  });

  it("offers the sign-off lane for a passed automated gate missing its dual-control signoff", async () => {
    const dualControl: TaskRow = {
      ...attestTask,
      taskId: "task-dual",
      title: "双控缺签任务",
      gates: [
        {
          name: "e2e",
          ok: false,
          status: "signoff_missing",
          detail: "the automated witness passed; the mandatory human signoff is missing",
        },
      ],
      executions: [submittedExecution("task-dual", "e2e", "local-command", { mandatorySignoff: true })],
    } as TaskRow;
    const harness = await mountPool("gates", [dualControl]);
    await act(async () => {
      byTestId("pool-gate-approve-task-dual-e2e").click();
    });
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "复核通过,同意放行。");
    await act(async () => {
      byTestId("gate-attest-submit-approve").click();
    });
    expect(harness.attestCalls).toEqual([
      { taskId: "task-dual", gateId: "e2e", mode: "approve", rationale: "复核通过,同意放行。" },
    ]);
  });

  it("keeps a failed gate without declared allowOverride out of the break-glass lane", async () => {
    const locked: TaskRow = {
      ...attestTask,
      taskId: "task-locked",
      title: "不可特批的失败任务",
      gates: [{ name: "ci-gate", ok: false, status: "failed" }],
      executions: [submittedExecution("task-locked", "ci-gate", "github-actions")],
    } as TaskRow;
    await mountPool("breakGlass", [locked]);
    expect(document.querySelector('[data-testid="pool-gate-row-task-locked-ci-gate"]')).toBeNull();
    expect(byTestId("attestation-pool-tab-breakGlass").textContent).toMatch(/\S+\s*·\s*0(?=\s|$)/);
  });

  it("requires a 10+ char rationale before dispatching a break-glass override", async () => {
    const harness = await mountPool("breakGlass");
    await act(async () => {
      byTestId("pool-gate-override-task-failed-ci-gate").click();
    });
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(harness.attestCalls).toEqual([]);
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "外部 CI flake,重跑两次同错。");
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(harness.attestCalls).toEqual([
      { taskId: "task-failed", gateId: "ci-gate", mode: "override", rationale: "外部 CI flake,重跑两次同错。" },
    ]);
  });

  it("routes a missing automated witness into break-glass and dispatches the no-receipt override", async () => {
    const harness = await mountPool("breakGlass", [missingWitnessTask]);
    expect(byTestId("pool-gate-row-task-unavailable-e2e").textContent).toContain("missing");
    await act(async () => {
      byTestId("pool-gate-override-task-unavailable-e2e").click();
    });
    expect(document.body.textContent).toContain("未取得任何自动见证");
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "采集链路阻断,人工验收放行。");
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(harness.attestCalls).toEqual([
      {
        taskId: "task-unavailable",
        gateId: "e2e",
        mode: "override",
        rationale: "采集链路阻断,人工验收放行。",
      },
    ]);
  });

  it("keeps a missing automated gate without declared allowOverride out of the break-glass lane", async () => {
    const locked: TaskRow = {
      ...attestTask,
      taskId: "task-missing-locked",
      title: "不可特批的缺见证任务",
      gates: [{ name: "e2e", ok: null, status: "missing" }],
      executions: [submittedExecution("task-missing-locked", "e2e", "local-command")],
    } as TaskRow;
    await mountPool("breakGlass", [locked]);
    expect(document.querySelector('[data-testid="pool-gate-row-task-missing-locked-e2e"]')).toBeNull();
    expect(byTestId("attestation-pool-tab-breakGlass").textContent).toMatch(/\S+\s*·\s*0(?=\s|$)/);
  });

  it("signs a consent straight from the pool through the complete write path", async () => {
    const harness = await mountPool("consents");
    await act(async () => {
      byTestId("pool-consent-approve-task-consent").click();
    });
    expect(harness.consentCalls).toEqual([{ taskId: "task-consent", consent: true }]);
  });

  it("keeps the quick-judgment surface and the focus mode on the decisions domain", async () => {
    await mountPool("decisions");
    const card = document.getElementById("decision-card-dec-pool");
    expect(card, "decision card missing").toBeTruthy();
    expect(card!.textContent).toContain("总池里的待裁决策");
    // 行级能力投影(proposed → accept 可用)仍挂快速批复面板。
    const accept = [...card!.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("接受"),
    );
    expect(accept).toBeInstanceOf(HTMLButtonElement);
    expect(document.querySelector('[data-testid="pool-gate-row-task-attest-ux-signoff"]')).toBeNull();
    // 决策域的专注处理模式:入口 → 内嵌 DecisionsView(队列计数 + 判定历史面),可返回。
    await act(async () => {
      byTestId("attestation-pool-focus-entry").click();
    });
    expect(document.body.textContent).toContain("决策待裁 · 专注模式");
    expect(document.body.textContent).toContain("1 / 1");
    expect(document.body.textContent).toContain("返回总池");
    expect(document.querySelector('[data-testid="attestation-pool-focus-entry"]')).toBeNull();
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[title="返回总池"]')!.click();
    });
    expect(document.getElementById("decision-card-dec-pool")).toBeTruthy();
    expect(byTestId("attestation-pool-focus-entry")).toBeTruthy();
  });
});
