// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskRow } from "../src/renderer/model/types.ts";
import { projectedTaskFields } from "./task-projection-fields.ts";
import {
  ATTESTATION_POOL_TABS,
  deriveAttestationLanes,
  taskConsentPending,
  taskGateAttestations,
} from "../src/renderer/model/attestation-pool.ts";
import { harnessClient } from "../src/renderer/api-client.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";

/** 带冻结契约的 submitted execution(镜像 submission.completionContract 的真实形状)。 */
function submittedExecution(
  taskId: string,
  gates: readonly { gateId: string; adapterId: string; allowOverride?: true }[],
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
      outputs: ["artifacts/report.md"],
      verificationNotes: [],
      knownGaps: [],
      residualRisks: [],
      commitSha: "a".repeat(40),
      completionContract: {
        gates: gates.map((gate) => ({
          gateId: gate.gateId,
          appliesTo: "submission",
          witness: { adapterId: gate.adapterId, adapterOptions: {} },
          ...(gate.allowOverride ? { allowOverride: true } : {}),
        })),
      },
    },
  };
}

function poolTask(overrides: Partial<TaskRow> & { readonly taskId: string }): TaskRow {
  return {
    title: overrides.taskId,
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
    lastKnownAt: "2026-09-16T10:31:00.000Z",
    gates: [],
    board: projectedTaskFields("in_review").board,
    visibility: projectedTaskFields("in_review").visibility,
    capabilities: projectedTaskFields("in_review").capabilities,
    risk: projectedTaskFields("in_review").risk,
    phase: projectedTaskFields("in_review").phase,
    docs: [],
    ...overrides,
  } as TaskRow;
}

describe("attestation pool lane derivation", () => {
  it("routes a missing manual-attest gate to the sign-off lane with the frozen adapter", () => {
    const task = poolTask({
      taskId: "task-manual",
      iteration: 0,
      gates: [{ name: "ux-signoff", ok: null, status: "missing", detail: "current execution cut has no gate witness" }],
      executions: [submittedExecution("task-manual", [{ gateId: "ux-signoff", adapterId: "manual-attest" }])],
    });
    expect(taskGateAttestations(task)).toEqual({
      gates: [
        {
          taskId: "task-manual",
          taskTitle: "task-manual",
          gateId: "ux-signoff",
          mode: "approve",
          gateStatus: "missing",
          adapterId: "manual-attest",
          detail: "current execution cut has no gate witness",
          executionId: "execution-task-manual",
        },
      ],
      breakGlass: [],
    });
  });

  it("routes a signoff_missing gate (automated pass, dual control pending) to the sign-off lane", () => {
    const task = poolTask({
      taskId: "task-dual",
      iteration: 0,
      gates: [
        {
          name: "e2e",
          ok: false,
          status: "signoff_missing",
          detail: "the automated witness passed; the mandatory human signoff is missing",
        },
      ],
      executions: [submittedExecution("task-dual", [{ gateId: "e2e", adapterId: "local-command" }])],
    });
    expect(taskGateAttestations(task)).toEqual({
      gates: [
        expect.objectContaining({
          gateId: "e2e",
          mode: "approve",
          gateStatus: "signoff_missing",
          adapterId: "local-command",
        }),
      ],
      breakGlass: [],
    });
  });

  it("routes a failed gate to break-glass only when the frozen contract declared allowOverride", () => {
    const task = poolTask({
      taskId: "task-ci",
      iteration: 0,
      gates: [{ name: "ci-gate", ok: false, status: "failed", detail: "current execution cut did not pass" }],
      executions: [
        submittedExecution("task-ci", [{ gateId: "ci-gate", adapterId: "github-actions", allowOverride: true }]),
      ],
    });
    const lanes = taskGateAttestations(task);
    expect(lanes.gates).toEqual([]);
    expect(lanes.breakGlass).toEqual([
      expect.objectContaining({
        gateId: "ci-gate",
        mode: "override",
        gateStatus: "failed",
        adapterId: "github-actions",
      }),
    ]);
  });

  it("keeps a failed gate without declared allowOverride out of every lane (daemon would reject)", () => {
    const task = poolTask({
      taskId: "task-locked",
      iteration: 0,
      gates: [{ name: "ci-gate", ok: false, status: "failed" }],
      executions: [submittedExecution("task-locked", [{ gateId: "ci-gate", adapterId: "github-actions" }])],
    });
    expect(taskGateAttestations(task)).toEqual({ gates: [], breakGlass: [] });
  });

  it("keeps a done task read-only even with a missing manual-attest witness", () => {
    const task = poolTask({
      taskId: "task-done",
      canonicalStatus: "done",
      iteration: 0,
      gates: [{ name: "ux-signoff", ok: null, status: "missing" }],
      executions: [submittedExecution("task-done", [{ gateId: "ux-signoff", adapterId: "manual-attest" }])],
    });
    expect(taskGateAttestations(task)).toEqual({ gates: [], breakGlass: [] });
  });

  it("does not guess manual-attest for legacy cuts without a frozen contract", () => {
    const legacy = poolTask({
      taskId: "task-legacy",
      iteration: 0,
      gates: [{ name: "old-gate", ok: null, status: "missing" }],
      executions: [],
    });
    expect(taskGateAttestations(legacy)).toEqual({ gates: [], breakGlass: [] });
  });

  it("treats multiple same-iteration cuts as ambiguity and picks no side", () => {
    const task = poolTask({
      taskId: "task-ambiguous",
      iteration: 0,
      gates: [{ name: "ux-signoff", ok: null, status: "missing" }],
      executions: [
        submittedExecution("task-ambiguous", [{ gateId: "ux-signoff", adapterId: "manual-attest" }]),
        submittedExecution("task-ambiguous", [{ gateId: "ux-signoff", adapterId: "manual-attest" }]),
      ],
    });
    expect(taskGateAttestations(task).gates).toEqual([]);
  });

  it("passes through only the consent blocker as pending consent", () => {
    expect(taskConsentPending(poolTask({ taskId: "task-c", closeoutBlocker: "consent" }))).toEqual({
      taskId: "task-c",
      taskTitle: "task-c",
    });
    expect(taskConsentPending(poolTask({ taskId: "task-r", closeoutBlocker: "review" }))).toBeNull();
    expect(taskConsentPending(poolTask({ taskId: "task-n" }))).toBeNull();
  });

  it("aggregates lanes across tasks and exposes the closed tab vocabulary", () => {
    const lanes = deriveAttestationLanes([
      poolTask({
        taskId: "task-a",
        iteration: 0,
        gates: [{ name: "ux-signoff", ok: null, status: "missing" }],
        executions: [submittedExecution("task-a", [{ gateId: "ux-signoff", adapterId: "manual-attest" }])],
        closeoutBlocker: "consent",
      }),
      poolTask({
        taskId: "task-b",
        iteration: 0,
        gates: [{ name: "ci-gate", ok: false, status: "failed" }],
        executions: [
          submittedExecution("task-b", [{ gateId: "ci-gate", adapterId: "local-command", allowOverride: true }]),
        ],
      }),
    ]);
    expect(lanes.gates.map(({ taskId }) => taskId)).toEqual(["task-a"]);
    expect(lanes.breakGlass.map(({ taskId }) => taskId)).toEqual(["task-b"]);
    expect(lanes.consents.map(({ taskId }) => taskId)).toEqual(["task-a"]);
    expect([...ATTESTATION_POOL_TABS]).toEqual(["all", "decisions", "gates", "consents", "breakGlass"]);
  });
});

describe("taskAttest protocol wiring", () => {
  const appliedReceipt = {
    schema: "command-receipt/v2",
    ok: true,
    command: "task-attest",
    outcome: "applied",
    opId: "op-attest",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    resetGuiTransportForTest();
    window.sessionStorage.clear();
  });

  it("posts the formal repo.task.attest method with note for approve and rationale for override on the wire", async () => {
    window.sessionStorage.setItem("harness.browser.access-token", "wire-token");
    const fetch = vi.fn(
      async (_url: unknown, _init: unknown) => new Response(JSON.stringify(appliedReceipt), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    await harnessClient.taskAttest({
      repoId: "repo-a",
      taskId: "task-1",
      gateId: "ux-signoff",
      mode: "approve",
      note: "体验达标",
    });
    await harnessClient.taskAttest({
      repoId: "repo-a",
      taskId: "task-2",
      gateId: "ci-gate",
      mode: "override",
      rationale: "外部 CI flake,重跑两次同错。",
    });
    expect(fetch.mock.calls.length).toBe(2);
    const bodies = fetch.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[0]).toEqual({
      method: "repo.task.attest",
      params: {
        repo: { repoId: "repo-a" },
        payload: { taskId: "task-1", gateId: "ux-signoff", result: "pass", note: "体验达标" },
      },
    });
    expect(bodies[1]).toEqual({
      method: "repo.task.attest",
      params: {
        repo: { repoId: "repo-a" },
        payload: {
          taskId: "task-2",
          gateId: "ci-gate",
          result: "pass",
          mode: "override",
          rationale: "外部 CI flake,重跑两次同错。",
        },
      },
    });
  });

  it("omits mode and empty note for a bare approve and rides the registered taskAttest bridge method", async () => {
    const request = vi.fn(async (_method: unknown, _payload: unknown) => appliedReceipt);
    vi.stubGlobal("window", { harness: { request } });
    await harnessClient.taskAttest({ repoId: "repo-a", taskId: "task-1", gateId: "ux-signoff", mode: "approve" });
    expect(request.mock.calls[0]![0]).toBe("taskAttest");
    expect(request.mock.calls[0]![1]).toEqual({
      repoId: "repo-a",
      taskId: "task-1",
      gateId: "ux-signoff",
      result: "pass",
    });
  });
});
