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
  initialTab: AttestationPoolTabId = "all",
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

function byTestId(testId: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testId}"]`);
  expect(element, `missing data-testid=${testId}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("AttestationPoolView", () => {
  it("renders the five addressable tabs with real counts and all lanes on all", async () => {
    await mountPool("all");
    for (const [tab, count] of [
      ["all", 4],
      ["decisions", 1],
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

  it("keeps tab switches on the addressable location path, not internal state", async () => {
    const harness = await mountPool("all");
    await act(async () => {
      byTestId("attestation-pool-tab-consents").click();
    });
    expect(harness.tabChanges).toEqual(["consents"]);
    // 受控组件:poolTab 仍是 "all" 时 UI 不自行切换渲染。
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

  it("signs a consent straight from the pool through the complete write path", async () => {
    const harness = await mountPool("consents");
    await act(async () => {
      byTestId("pool-consent-approve-task-consent").click();
    });
    expect(harness.consentCalls).toEqual([{ taskId: "task-consent", consent: true }]);
  });

  it("keeps the decision quick-judgment surface on the decisions tab", async () => {
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
  });
});
