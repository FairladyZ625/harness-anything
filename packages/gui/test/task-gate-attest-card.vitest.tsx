// harness-test-tier: integration
// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TaskGateAttestCard } from "../src/renderer/components/taskDetail/TaskGateAttestCard.tsx";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: { readonly root: Root }[] = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(async () => {
  await act(async () => {
    for (const { root } of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

function contractExecution(
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
      deliverables: [],
      outputs: [],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
      completionContract: {
        gates: [
          {
            gateId,
            appliesTo: "submission",
            witness: { kind: "adapter", adapterId, adapterOptions: {} },
            ...(governance.allowOverride ? { allowOverride: true } : {}),
            ...(governance.mandatorySignoff ? { mandatorySignoff: true } : {}),
          },
        ],
      },
    },
  };
}

function cardTask(gates: TaskRow["gates"], execution?: ReturnType<typeof contractExecution>): TaskRow {
  return {
    taskId: "task-card",
    title: "签注卡任务",
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
    gates,
    ...(execution ? { executions: [execution] } : {}),
    docs: [],
    ...projectedTaskFields("in_review"),
  } as TaskRow;
}

async function mountCard(task: TaskRow, feedback?: Parameters<typeof TaskGateAttestCard>[0]["feedback"]) {
  const attest = vi.fn(
    async (_task: Pick<TaskRow, "taskId">, _gateId: string, _mode: "approve" | "override", _rationale?: string) => ({
      state: "error" as const,
      kind: "attest" as const,
      opId: "op-x",
      hint: "fixture",
    }),
  );
  const container = document.createElement("div"),
    root = createRoot(container);
  document.body.append(container);
  mounted.push({ root });
  await act(async () => {
    root.render(createElement(TaskGateAttestCard, { task, feedback, onAttest: attest }));
  });
  return attest;
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

describe("TaskGateAttestCard", () => {
  it("attests a manual-attest gate with the typed note and passes an empty note as undefined", async () => {
    const attest = await mountCard(
      cardTask(
        [{ name: "ux-signoff", ok: null, status: "missing" }],
        contractExecution("task-card", "ux-signoff", "manual-attest"),
      ),
    );
    await act(async () => {
      byTestId("task-gate-approve-ux-signoff").click();
    });
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "打勾,体验达标。");
    await act(async () => {
      byTestId("gate-attest-submit-approve").click();
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-card" }),
      "ux-signoff",
      "approve",
      "打勾,体验达标。",
    );
  });

  it("signs with an empty note as undefined rather than an empty string", async () => {
    const attest = await mountCard(
      cardTask(
        [{ name: "ux-signoff", ok: null, status: "missing" }],
        contractExecution("task-card", "ux-signoff", "manual-attest"),
      ),
    );
    await act(async () => {
      byTestId("task-gate-approve-ux-signoff").click();
    });
    await act(async () => {
      byTestId("gate-attest-submit-approve").click();
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-card" }),
      "ux-signoff",
      "approve",
      undefined,
    );
  });

  it("offers the override entry only for contract-declared overridable gates and enforces the 10-char rationale", async () => {
    const attest = await mountCard(
      cardTask(
        [{ name: "ci-gate", ok: false, status: "failed" }],
        contractExecution("task-card", "ci-gate", "github-actions", { allowOverride: true }),
      ),
    );
    expect(document.querySelector('[data-testid="task-gate-approve-ci-gate"]')).toBeNull();
    await act(async () => {
      byTestId("task-gate-override-ci-gate").click();
    });
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(attest).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="task-attest-feedback"]')).toBeNull();
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "环境阻断,按特批放行。");
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-card" }),
      "ci-gate",
      "override",
      "环境阻断,按特批放行。",
    );
  });

  it("attests a signoff_missing gate (automated pass, missing dual-control signoff) as approve", async () => {
    const attest = await mountCard(
      cardTask(
        [
          {
            name: "e2e",
            ok: false,
            status: "signoff_missing",
            detail: "the automated witness passed; the mandatory human signoff is missing",
          },
        ],
        contractExecution("task-card", "e2e", "local-command", { mandatorySignoff: true }),
      ),
    );
    await act(async () => {
      byTestId("task-gate-approve-e2e").click();
    });
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "复核通过,同意放行。");
    await act(async () => {
      byTestId("gate-attest-submit-approve").click();
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-card" }),
      "e2e",
      "approve",
      "复核通过,同意放行。",
    );
  });

  it("offers break-glass for a missing automated witness on an allowOverride gate with the no-receipt explanation", async () => {
    const attest = await mountCard(
      cardTask(
        [{ name: "e2e", ok: null, status: "missing", detail: "runner unreachable; no gate witness" }],
        contractExecution("task-card", "e2e", "local-command", { allowOverride: true }),
      ),
    );
    expect(document.querySelector('[data-testid="task-gate-approve-e2e"]')).toBeNull();
    await act(async () => {
      byTestId("task-gate-override-e2e").click();
    });
    expect(document.body.textContent).toContain("未取得任何自动见证");
    await typeInto(document.querySelector<HTMLTextAreaElement>("textarea")!, "采集链路阻断,人工验收放行。");
    await act(async () => {
      byTestId("gate-attest-submit-override").click();
    });
    expect(attest).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-card" }),
      "e2e",
      "override",
      "采集链路阻断,人工验收放行。",
    );
  });

  it("keeps a missing automated gate without declared allowOverride read-only", async () => {
    await mountCard(
      cardTask([{ name: "e2e", ok: null, status: "missing" }], contractExecution("task-card", "e2e", "local-command")),
    );
    const row = byTestId("task-gate-row-e2e");
    expect(row.textContent).toContain("missing");
    expect(row.querySelector("button")).toBeNull();
  });

  it("keeps a missing automated gate on a done task read-only even when overridable", async () => {
    const doneTask: TaskRow = {
      ...cardTask(
        [{ name: "e2e", ok: null, status: "missing" }],
        contractExecution("task-card", "e2e", "local-command", { allowOverride: true }),
      ),
      canonicalStatus: "done",
    };
    await mountCard(doneTask);
    expect(document.querySelector('[data-testid="task-gate-override-e2e"]')).toBeNull();
    expect(byTestId("task-gate-row-e2e").querySelector("button")).toBeNull();
  });

  it("keeps a failed gate without declared allowOverride read-only", async () => {
    await mountCard(
      cardTask(
        [{ name: "ci-gate", ok: false, status: "failed" }],
        contractExecution("task-card", "ci-gate", "github-actions"),
      ),
    );
    const row = byTestId("task-gate-row-ci-gate");
    expect(row.textContent).toContain("failed");
    expect(row.querySelector("button")).toBeNull();
  });

  it("marks a waived gate as a human override, not an automated pass, with no CTA", async () => {
    await mountCard(
      cardTask(
        [
          {
            name: "ci-gate",
            ok: true,
            status: "waived",
            detail: "receipt op-7 waived by person-owner at 2026-09-17: 外部环境阻断",
          },
        ],
        contractExecution("task-card", "ci-gate", "github-actions", { allowOverride: true }),
      ),
    );
    const row = byTestId("task-gate-row-ci-gate");
    expect(row.textContent).toContain("waived");
    expect(byTestId("task-gate-waived-ci-gate").textContent).toContain("人为放行");
    expect(row.querySelector("button")).toBeNull();
  });

  it("keeps gates on a done task read-only even when a witness is missing", async () => {
    const doneTask: TaskRow = {
      ...cardTask(
        [{ name: "ux-signoff", ok: null, status: "missing" }],
        contractExecution("task-card", "ux-signoff", "manual-attest"),
      ),
      canonicalStatus: "done",
    };
    await mountCard(doneTask);
    expect(document.querySelector('[data-testid="task-gate-approve-ux-signoff"]')).toBeNull();
    expect(byTestId("task-gate-row-ux-signoff").querySelector("button")).toBeNull();
  });

  it("renders passed gates read-only with no sign-off affordance", async () => {
    await mountCard(
      cardTask(
        [{ name: "ci-gate", ok: true, status: "passed" }],
        contractExecution("task-card", "ci-gate", "github-actions"),
      ),
    );
    const row = byTestId("task-gate-row-ci-gate");
    expect(row.textContent).toContain("passed");
    expect(row.querySelector("button")).toBeNull();
  });

  it("disables the CTA while an attest write is in flight", async () => {
    await mountCard(
      cardTask(
        [{ name: "ux-signoff", ok: null, status: "missing" }],
        contractExecution("task-card", "ux-signoff", "manual-attest"),
      ),
      { state: "pending", kind: "attest", opId: "op-inflight", hint: "正在提交打勾签注…" },
    );
    expect((byTestId("task-gate-approve-ux-signoff") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an attest rejection verbatim instead of swallowing it", async () => {
    await mountCard(cardTask([{ name: "ux-signoff", ok: null, status: "missing" }]), {
      state: "error",
      kind: "attest",
      opId: "op-9",
      code: "invalid_transition",
      hint: "this cut has no recorded automated fail or pass yet; run ha task complete first",
    });
    const feedback = byTestId("task-attest-feedback");
    expect(feedback.textContent).toContain("invalid_transition");
    expect(feedback.textContent).toContain("no recorded automated fail or pass");
  });

  it("keeps non-attest task feedback out of the card", async () => {
    await mountCard(cardTask([{ name: "ux-signoff", ok: null, status: "missing" }]), {
      state: "pending",
      kind: "submit",
      opId: "op-s",
      hint: "submitting",
    });
    expect(document.querySelector('[data-testid="task-attest-feedback"]')).toBeNull();
  });
});
