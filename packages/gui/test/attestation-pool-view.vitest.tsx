// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { harnessClient } from "../src/renderer/api-client.ts";
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
  reviews: [{ reviewId: "review-pool-approved", verdict: "approved", reason: "ok", reviewedAt: "2026-09-19" }],
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
  readonly consentCalls: { taskId: string; reviewId: string }[];
  readonly completeCalls: string[];
  readonly judged: { decisionId: string; action: string; rationale: string }[];
}

async function mountPool(
  initialTab: AttestationPoolTabId = "taskCloseout",
  tasks: readonly TaskRow[] = [attestTask, failedTask, consentTask],
  decisions: readonly DecisionRow[] = [proposedDecision],
  inboxCount = summary.inboxCount,
): Promise<PoolHarness> {
  const harness: PoolHarness = { tabChanges: [], attestCalls: [], consentCalls: [], completeCalls: [], judged: [] };
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
          decisions: [...decisions],
          summary: { ...summary, inboxCount },
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
          onCompleteTask: (task) => {
            harness.completeCalls.push(task.taskId);
            return Promise.resolve();
          },
          onConsentReview: (task, reviewId) => {
            harness.consentCalls.push({ taskId: task.taskId, reviewId });
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

/** 域级 Tabs(下划线式)按可访问名取按钮。 */
function domainTab(label: string): HTMLElement {
  const element = [...document.querySelectorAll('[role="tab"]')].find((tab) => (tab.textContent ?? "").includes(label));
  expect(element, `missing domain tab ${label}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

/** 任务收口域的 lane FilterChips 按文案取按钮(「<label>N」)。 */
function laneChip(label: string): HTMLElement {
  const element = [...document.querySelectorAll('[data-testid="attestation-pool-lane-chips"] button')].find((chip) =>
    (chip.textContent ?? "").replace(/\s+/g, "").includes(label.replaceAll(/\s+/g, "")),
  );
  expect(element, `missing lane chip ${label}`).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
}

/** 从 tab/chip 文本尾部取计数(「<label>N」/「<label> · N」/「共 N 项待办」)。 */
function trailingCount(element: HTMLElement): number {
  const match = /(\d+)\s*(?:项待办)?\s*$/.exec(element.textContent ?? "");
  expect(match, `element text has no trailing count: ${element.textContent}`).toBeTruthy();
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
    // 第一级按域分(下划线 Tabs):决策待裁(计数=kernel proposed 判定,与侧栏角标同读面)与任务收口。
    expect(domainTab("决策待裁").textContent).toMatch(/决策待裁\s*1(?=\s|$)/);
    expect(domainTab("任务收口").textContent).toMatch(/任务收口\s*3(?=\s|$)/);
    // 第二级只在任务收口域内(带计数 FilterChips):全览(三 lane 之和)+ 三个聚焦 lane。
    for (const [label, count] of [
      ["全部收口", 3],
      ["待我签门禁", 1],
      ["待我同意收口", 1],
      ["阻断需特批", 1],
    ] as const) {
      expect(laneChip(label).textContent).toMatch(new RegExp(`\\S+\\s*${count}(?=\\s|$)`));
    }
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
    expect(byTestId("pool-consent-card-task-consent")).toBeTruthy();
    expect(byTestId("pool-gate-row-task-failed-ci-gate")).toBeTruthy();
  });

  it("uses the unified page header (§2.3): bare one-line header, tabs under it", async () => {
    await mountPool("taskCloseout");
    const view = byTestId("attestation-pool-view");
    const header = view.querySelector(":scope > header") as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.className).not.toContain("border");
    expect(header.className).not.toContain("bg-");
    expect(header.querySelector("h1")?.className).toContain("text-xl");
    expect(header.contains(byTestId("attestation-pool-total"))).toBe(true);
  });

  it("keeps every displayed count equal to its rendered list rows", async () => {
    // 决策域:域计数 == 默认 proposed 组渲染的决策行数(计数与列表同源同判据)。
    await mountPool("decisions");
    expect(trailingCount(domainTab("决策待裁"))).toBe(document.querySelectorAll('[id^="decision-card-"]').length);
    expect(totalCount()).toBe(trailingCount(domainTab("决策待裁")) + trailingCount(domainTab("任务收口")));
    // 任务收口域:全览计数 == 三 lane 行数之和;每个聚焦 lane 计数 == 该 lane 行数。
    await unmountAll();
    await mountPool("taskCloseout");
    expect(trailingCount(domainTab("任务收口"))).toBe(laneRowCounts().total);
    expect(trailingCount(laneChip("全部收口"))).toBe(laneRowCounts().total);
    await unmountAll();
    await mountPool("gates");
    expect(trailingCount(laneChip("待我签门禁"))).toBe(laneRowCounts().gates);
    await unmountAll();
    await mountPool("consents");
    expect(trailingCount(laneChip("待我同意收口"))).toBe(laneRowCounts().consents);
    await unmountAll();
    await mountPool("breakGlass");
    expect(trailingCount(laneChip("阻断需特批"))).toBe(laneRowCounts().breakGlass);
  });

  it("keeps tab switches on the addressable location path, not internal state", async () => {
    const harness = await mountPool("taskCloseout");
    await act(async () => {
      laneChip("待我同意收口").click();
    });
    expect(harness.tabChanges).toEqual(["consents"]);
    // 受控组件:poolTab 仍是 "taskCloseout" 时 UI 不自行切换渲染。
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
  });

  it("默认页签:决策待裁决 0、任务收口有待办 → 落到任务收口;决策有待办则留在决策", async () => {
    const empty = await mountPool("decisions", [attestTask, failedTask, consentTask], [], 0);
    expect(empty.tabChanges).toEqual(["taskCloseout"]);
    await unmountAll();
    const busy = await mountPool("decisions", [attestTask, failedTask, consentTask], [proposedDecision]);
    expect(busy.tabChanges).toEqual([]);
    await unmountAll();
    const explicit = await mountPool("gates", [attestTask], [], 0);
    expect(explicit.tabChanges).toEqual([]);
  });

  it("renders only the requested lane on a focused tab", async () => {
    await mountPool("gates");
    expect(byTestId("pool-gate-row-task-attest-ux-signoff")).toBeTruthy();
    expect(document.querySelector('[data-testid="pool-consent-card-task-consent"]')).toBeNull();
    expect(document.querySelector('[data-testid="decision-card-dec-pool"]')).toBeNull();
  });

  it("lane 行带底色状态标签,任务标题经 TitleText 拆分(冒号后补充为弱色)", async () => {
    const titled: TaskRow = {
      ...attestTask,
      taskId: "task-title",
      title: "手工验收任务:冒号后的补充说明",
    } as TaskRow;
    await mountPool("gates", [titled]);
    const row = byTestId("pool-gate-row-task-title-ux-signoff");
    // 状态标签有底色小块(approve lane → 琥珀 wait 档),不只靠小字颜色区分。
    expect(row.querySelector("[data-status-tone='wait']")?.textContent).toContain("待签");
    // 标题按第一个冒号拆分:冒号前重点继承字色,冒号后补充(含冒号)用弱色。
    // 槽位里还带灰色的门禁原因,标题本体在原因 span 之前。
    const titleSlot = row.querySelector(`[title="${titled.title}"]`);
    expect(titleSlot?.textContent?.startsWith(titled.title)).toBe(true);
    const supplement = titleSlot?.querySelector("span.text-text-faint");
    expect(supplement?.textContent).toBe(":冒号后的补充说明");
  });

  it("break-glass lane 行用红档状态标签,签发动作打开右侧抽屉里的表单", async () => {
    await mountPool("breakGlass");
    expect(byTestId("pool-gate-row-task-failed-ci-gate").querySelector("[data-status-tone='bad']")).toBeTruthy();
    await act(async () => {
      byTestId("pool-gate-override-task-failed-ci-gate").click();
    });
    const drawer = document.querySelector('[role="dialog"][aria-modal="true"]');
    expect(drawer).toBeTruthy();
    expect(drawer!.querySelector("textarea")).toBeTruthy();
    expect(drawer!.querySelector('[data-testid="gate-attest-submit-override"]')).toBeTruthy();
  });

  it("任务收口域全空时是一条细状态行,不渲染大框与任何 lane 区块", async () => {
    await mountPool("taskCloseout", []);
    const clear = byTestId("pool-closeout-clear");
    expect(clear.textContent).toContain("没有等待你签发的收口事项");
    expect(clear.querySelector("[data-status-tone='done']")).toBeTruthy();
    expect(clear.className).not.toContain("border");
    expect(document.querySelectorAll('[data-testid^="pool-gate-row-"]').length).toBe(0);
    // 空 lane 整块消失:不渲染任何 lane 区块标题(标准 §1.5 空了就消失)。
    expect([...document.querySelectorAll("h2")].some((heading) => heading.textContent?.includes("待我签门禁"))).toBe(
      false,
    );
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
    expect(trailingCount(laneChip("阻断需特批"))).toBe(0);
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
    expect(trailingCount(laneChip("阻断需特批"))).toBe(0);
  });

  it("signs a consent straight from the pool through the owner-verdict write path", async () => {
    const harness = await mountPool("consents");
    await act(async () => {
      byTestId("pool-consent-approve-task-consent").click();
    });
    expect(harness.consentCalls).toEqual([{ taskId: "task-consent", reviewId: "review-pool-approved" }]);
  });

  it("keeps the quick-judgment surface and the focus mode on the decisions domain", async () => {
    await mountPool("decisions");
    const card = document.getElementById("decision-card-dec-pool");
    expect(card, "decision row missing").toBeTruthy();
    expect(card!.textContent).toContain("总池里的待裁决策");
    // 点行开抽屉:行级能力投影(proposed → accept 可用)把快速批复面板带进抽屉。
    await act(async () => {
      card!.click();
    });
    const accept = document.querySelector<HTMLButtonElement>("[data-testid='decision-judge-accept']");
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

  it("决策池行直接用列表 full 行的评审就绪:不逐卡读 decision-show,打回未处置时 accept 停用", async () => {
    const show = vi.spyOn(harnessClient, "showDecision");
    const digest = `sha256:${"c".repeat(64)}` as const;
    await mountPool(
      "decisions",
      [],
      [
        {
          ...proposedDecision,
          review: {
            reviews: [],
            responses: [],
            overrides: [],
            currentDigest: digest,
            readiness: {
              ready: false,
              currentDigest: digest,
              basis: null,
              blocker: { code: "changes_requested", reviewIds: ["review-x"], reason: "unresolved changes_requested" },
              next: { action: "override-review", actor: "owner", reason: "owner decides" },
            },
            dispatches: [],
          },
        },
      ],
    );
    const card = document.getElementById("decision-card-dec-pool")!;
    // 评审信号在行上直接可见(列表 full 行投影,不逐卡读 detail)。
    expect(card.querySelector("[data-testid='decision-review-signal']")?.textContent).toBe("待处置");
    await act(async () => {
      card.click();
    });
    expect(document.querySelector("[data-testid='decision-judge-accept']")?.textContent).toContain("接受");
    expect(document.querySelector<HTMLButtonElement>("[data-testid='decision-judge-accept']")?.disabled).toBe(true);
    expect(document.querySelector("[data-testid='decision-judge-accept-blocked']")?.textContent).toContain(
      "unresolved changes_requested",
    );
    await act(async () => {
      byTestId("attestation-pool-focus-entry").click();
    });
    await flushEffects();
    expect(document.querySelector("[data-testid='decision-review-signal']")?.textContent).toBe("待处置");
    expect(show).not.toHaveBeenCalled();
    show.mockRestore();
  });
});
