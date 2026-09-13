// harness-test-tier: contract
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquadRunDetail } from "../src/renderer/components/sessions/SquadRunDetail.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type { SquadRunReadResult } from "../../daemon/src/squad-run-contract.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const metrics = (input: number, output: number, toolCallCount: number, compacted = false) => ({
  tokenUsage: { input, output },
  toolCallCount,
  compacted,
});

const squadRunDetail: SquadRunReadResult = {
  ok: true,
  status: "ready",
  run: {
    squadRunId: "squad_" + "b".repeat(18),
    squadId: "squad_465504" + "a".repeat(12),
    taskId: "task_5fc508",
    mission: "Ship the ontology milestone",
    phase: "workers_running",
    error: null,
    currentLeaderRuntimeSessionId: "runtime-leader-2",
    leaderTurns: [
      {
        turnId: "leader-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime-leader-1",
        decision: { kind: "plan", dispatchCount: 2 },
        resultText: JSON.stringify({
          schema: "runtime-batch/v1",
          dispatches: [
            { instance: "instance-ontology", to: "terra", prompt: "map the ontology seam" },
            { instance: "instance-ontology", to: "sol", prompt: "audit the ledger reads" },
          ],
        }),
        status: "succeeded",
        startedAt: "2026-08-25T18:00:00.000Z",
        endedAt: "2026-08-25T18:04:00.000Z",
        ...metrics(0, 0, 0),
      },
      {
        turnId: "leader-2",
        trigger: { kind: "worker_outcome", runtimeSessionId: "runtime-worker-1" },
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-leader-2",
        decision: null,
        resultText: null,
        status: "running",
        startedAt: "2026-08-25T18:10:00.000Z",
        endedAt: null,
        ...metrics(0, 0, 0),
      },
    ],
    workerAttempts: [
      {
        attemptId: "worker-1",
        workerId: "terra",
        leaderTurnId: "leader-1",
        dispatchId: "dispatch_000000000000000000000003",
        runtimeSessionId: "runtime-worker-1",
        worktree: null,
        rejection: null,
        status: "succeeded",
        startedAt: "2026-08-25T18:05:00.000Z",
        endedAt: "2026-08-25T18:09:00.000Z",
        ...metrics(0, 0, 0),
      },
      {
        attemptId: "worker-2",
        workerId: "sol",
        leaderTurnId: "leader-1",
        dispatchId: null,
        runtimeSessionId: null,
        worktree: null,
        rejection: "Runtime dispatch was rejected.",
        status: null,
        startedAt: null,
        endedAt: null,
        ...metrics(0, 0, 0),
      },
    ],
  },
  watermark: 9,
  sourceRevision: 9,
};

const detailView = (overrides: Partial<Parameters<typeof SquadRunDetail>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SquadRunDetail, {
      detail: squadRunDetail,
      squadName: "ontology-squad",
      pending: false,
      error: null,
      onOpenTask: noop,
      onSelectEntity: noop,
      ...overrides,
    }),
  );

describe("sessions page: squad run detail", () => {
  it("renders the leader-to-worker fan-out tree with the mission verbatim", () => {
    const markup = detailView();
    expect(markup).toContain("Leader turns (2)");
    expect(markup).toContain("leader-1");
    expect(markup).toContain("initial mission");
    expect(markup).toContain("plan · 2 dispatches");
    expect(markup).toContain("leader-2");
    expect(markup).toContain("after worker session");
    expect(markup).toContain("decision pending");
    expect(markup).toMatch(/data-testid="squad-run-turn-leader-2"/u);
    // 当前 leader 轮高亮;轮次行直达 session/<id>(EntityRefLink 是 button 出口)。
    expect(markup).toMatch(/border-accent\/40/u);
    expect(markup).toContain('title="runtime-leader-2"');
    expect(markup).toContain("runtime-leader-2");
    expect(markup).toContain("Ship the ontology milestone");
    // 扇出树:worker-1 挂在 leader-1 节内,且出现在 leader-2 之前(父子序,不是平铺)。
    const inLeader1 = markup.indexOf('data-testid="squad-run-turn-leader-1"'),
      attemptAt = markup.indexOf('data-testid="squad-run-attempt-worker-1"'),
      leader2At = markup.indexOf('data-testid="squad-run-turn-leader-2"');
    expect(inLeader1).toBeGreaterThan(-1);
    expect(attemptAt).toBeGreaterThan(inLeader1);
    expect(attemptAt).toBeLessThan(leader2At);
    // worker attempt 直达 session 详情。
    expect(markup).toContain('title="runtime-worker-1"');
  });

  it("shows each leader turn's receipt verbatim in a collapsible block", () => {
    const markup = detailView();
    expect(markup).toMatch(/data-testid="squad-run-receipt-leader-1"/u);
    expect(markup).toContain("leader receipt (raw)");
    expect(markup).toContain("map the ontology seam");
    expect(markup).toContain("audit the ledger reads");
    // 未结算的轮次诚实呈空,不伪造 receipt。
    expect(markup).toMatch(/data-testid="squad-run-receipt-leader-2"[^>]*>[^<]*<\/summary>\s*<p[^>]*>no receipt yet/u);
  });

  it("labels a leader recovery turn from its durable retry trigger", () => {
    const retry = detailView({
      detail: {
        ...squadRunDetail,
        run: {
          ...squadRunDetail.run,
          leaderTurns: squadRunDetail.run.leaderTurns.map((turn) =>
            turn.turnId === "leader-2"
              ? {
                  ...turn,
                  trigger: {
                    kind: "leader_retry" as const,
                    turnId: "leader-1",
                    reason: "Leader result was not JSON.",
                  },
                }
              : turn,
          ),
        },
      },
    });
    expect(retry).toContain("retry after leader turn leader-1");
  });

  it("shows why a duplicate worker dispatch waited for the running attempt", () => {
    const reason = "Worker terra was already running; waited for its callback instead of redispatching.",
      wait = detailView({
        detail: {
          ...squadRunDetail,
          run: {
            ...squadRunDetail.run,
            leaderTurns: squadRunDetail.run.leaderTurns.map((turn) =>
              turn.turnId === "leader-2"
                ? {
                    ...turn,
                    trigger: {
                      kind: "worker_wait" as const,
                      runtimeSessionId: "runtime-worker-1",
                      reason,
                    },
                  }
                : turn,
            ),
          },
        },
      });
    expect(wait).toContain(reason);
  });

  it("keeps rejected attempts under their leader turn with the failure visible", () => {
    const markup = detailView();
    expect(markup).toContain("worker-2");
    expect(markup).toContain("sol");
    expect(markup).toContain("rejected: Runtime dispatch was rejected.");
    expect(markup).toContain("no dispatch");
    expect(markup).toMatch(/data-testid="squad-run-attempt-worker-2"/u);
    expect(markup.indexOf('data-testid="squad-run-attempt-worker-2"')).toBeLessThan(
      markup.indexOf('data-testid="squad-run-turn-leader-2"'),
    );
  });

  it("surfaces the run error line and read failures without inventing flow", () => {
    const failed = detailView({
      detail: {
        ...squadRunDetail,
        run: { ...squadRunDetail.run, error: "Leader turn leader-1 ended with failed." },
      },
    });
    expect(failed).toContain("Leader turn leader-1 ended with failed.");
    const error = detailView({ detail: null, pending: false, error: "squad read failed" });
    expect(error).toContain("squad read failed");
    expect(error).toMatch(/data-testid="squad-run-detail-error"/u);
  });

  it("renders an invalid detail projection as a grey hint instead of a read error", () => {
    const invalid = detailView({
      detail: {
        ok: true,
        status: "ready",
        run: {
          squadRunId: "squad_" + "d".repeat(24),
          projectionState: "invalid",
          projectionError: {
            code: "squad_run_projection_invalid",
            hint: "Repair the invalid Squad run projection.",
          },
        },
        watermark: 9,
        sourceRevision: 9,
      },
    });
    expect(invalid).toContain("Invalid");
    expect(invalid).toContain("Repair the invalid Squad run projection.");
    expect(invalid).not.toContain("squad-run-detail-error");
  });
});

/** P1.3 遥测读面:leader 轮与 worker attempt 都带 tokenUsage/toolCallCount/compacted,
 * 派工被拒的 attempt 是全零度量(daemon 侧 attemptMetrics 对缺 metrics 的行给 0/false)。 */
const telemetryDetail: SquadRunReadResult = {
  ok: true,
  status: "ready",
  run: {
    squadRunId: "squad_" + "e".repeat(18),
    squadId: "squad_465504" + "a".repeat(12),
    taskId: "task_5fc508",
    mission: "Ship the telemetry milestone",
    phase: "workers_running",
    error: null,
    currentLeaderRuntimeSessionId: "runtime-leader-9",
    leaderTurns: [
      {
        turnId: "lt-1",
        trigger: { kind: "initial" },
        dispatchId: "dispatch_000000000000000000000001",
        runtimeSessionId: "runtime-leader-9",
        decision: { kind: "plan", dispatchCount: 3 },
        resultText: null,
        status: "running",
        startedAt: "2026-09-13T10:00:00.000Z",
        endedAt: null,
        ...metrics(120000, 30000, 8),
      },
    ],
    workerAttempts: [
      {
        attemptId: "wa-terra",
        workerId: "terra",
        leaderTurnId: "lt-1",
        dispatchId: "dispatch_000000000000000000000002",
        runtimeSessionId: "runtime-worker-terra",
        worktree: null,
        rejection: null,
        status: "succeeded",
        startedAt: "2026-09-13T10:01:00.000Z",
        endedAt: "2026-09-13T10:05:00.000Z",
        ...metrics(900000, 120000, 32, true),
      },
      {
        attemptId: "wa-sol",
        workerId: "sol",
        leaderTurnId: "lt-1",
        dispatchId: "dispatch_000000000000000000000003",
        runtimeSessionId: "runtime-worker-sol",
        worktree: null,
        rejection: null,
        status: "running",
        startedAt: "2026-09-13T10:01:30.000Z",
        endedAt: null,
        ...metrics(300000, 60000, 12),
      },
      {
        attemptId: "wa-luna",
        workerId: "luna",
        leaderTurnId: "lt-1",
        dispatchId: null,
        runtimeSessionId: null,
        worktree: null,
        rejection: "Runtime dispatch was rejected.",
        status: null,
        startedAt: null,
        endedAt: null,
        ...metrics(0, 0, 0),
      },
    ],
  },
  watermark: 3,
  sourceRevision: 3,
};
const emptyMetricsDetail: SquadRunReadResult = {
  ...telemetryDetail,
  run: {
    ...telemetryDetail.run,
    leaderTurns: telemetryDetail.run.leaderTurns.map((turn) => ({ ...turn, ...metrics(0, 0, 0) })),
    workerAttempts: telemetryDetail.run.workerAttempts.map((attempt) => ({ ...attempt, ...metrics(0, 0, 0) })),
  },
};

const telemetryView = (detail: SquadRunReadResult = telemetryDetail) => detailView({ detail });

describe("squad run detail: attempt telemetry (P1.3)", () => {
  it("badges each attempt with its tool call count, including zero-cost attempts", () => {
    const markup = telemetryView();
    expect(markup).toContain('data-testid="squad-run-attempt-tools-wa-terra"');
    expect(markup).toContain("Tools: 32");
    expect(markup).toContain("Tools: 12");
    // 被拒 attempt 度量为零,诚实呈 0 而不是隐藏徽标。
    expect(markup).toContain('data-testid="squad-run-attempt-tools-wa-luna"');
    expect(markup).toContain("Tools: 0");
  });

  it("draws input/output token bars scaled against the run-wide max attempt", () => {
    const markup = telemetryView();
    expect(markup).toContain('data-testid="squad-run-attempt-tokens-wa-terra"');
    // 精确数字进 title(tooltip),可见面只放比例条:terra 是全 run 最大消耗(1.02M),两段合成满宽。
    expect(markup).toContain('title="in 900,000 / out 120,000"');
    expect(markup).toContain('title="in 300,000 / out 60,000"');
    expect(markup).toMatch(/squad-run-attempt-tokens-wa-terra"[^>]*>.*?width:88\.2%/u);
    expect(markup).toMatch(/squad-run-attempt-tokens-wa-terra"[\s\S]*?width:11\.8%/u);
    // sol(360K)按同一比例尺落在 terra(1.02M)的 35.3%。
    expect(markup).toMatch(/squad-run-attempt-tokens-wa-sol"[\s\S]*?width:29\.4%/u);
    expect(markup).toMatch(/squad-run-attempt-tokens-wa-sol"[\s\S]*?width:5\.9%/u);
    // 零消耗 attempt 不画假条:track 开标签后紧跟闭合,没有带 width 的子段。
    expect(markup).toContain('data-testid="squad-run-attempt-tokens-wa-luna"');
    expect(markup).not.toMatch(/squad-run-attempt-tokens-wa-luna"[^>]*><span [^>]*width:/u);
  });

  it("flags compacted attempts with a yellow warning and the loss-of-constraints tooltip", () => {
    const markup = telemetryView();
    expect(markup).toContain('data-testid="squad-run-attempt-compacted-wa-terra"');
    expect(markup).toContain('data-tip="Context compaction triggered; beware of losing negative constraints."');
    // 只有 compacted===true 的 attempt 出警示,未压缩的不挂标。
    expect(markup.match(/squad-run-attempt-compacted-/gu)).toHaveLength(1);
    expect(markup).toContain("compacted");
  });

  it("boards the run-wide token overhead and each member's share of it", () => {
    const markup = telemetryView();
    expect(markup).toContain('data-testid="squad-run-token-board"');
    // 总开销 = leader 轮 + 全部 worker attempt:in 1,320,000 / out 210,000 / 52 次工具调用。
    expect(markup).toContain('data-testid="squad-run-token-board-total"');
    expect(markup).toContain("total in 1.3M · out 210K · 52 tool calls");
    // 成员占比行:leader 150K/1.53M≈10%、terra 1.02M/1.53M≈67%、sol 360K/1.53M≈24%、luna 0%。
    expect(markup).toContain('data-testid="squad-run-token-member-leader"');
    expect(markup).toContain('data-testid="squad-run-token-member-terra"');
    expect(markup).toContain('data-testid="squad-run-token-member-sol"');
    expect(markup).toContain('data-testid="squad-run-token-member-luna"');
    expect(markup).toMatch(/squad-run-token-member-terra"[\s\S]*?width:66\.7%/u);
    expect(markup).toMatch(/squad-run-token-member-terra"[\s\S]*?>67%</u);
    expect(markup).toMatch(/squad-run-token-member-leader"[\s\S]*?>10%</u);
    expect(markup).toMatch(/squad-run-token-member-sol"[\s\S]*?>24%</u);
    expect(markup).toMatch(/squad-run-token-member-luna"[\s\S]*?>0%</u);
  });

  it("renders without crashing when every metric is zero", () => {
    const markup = telemetryView(emptyMetricsDetail);
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
    expect(markup).toContain("total in 0 · out 0 · 0 tool calls");
    expect(markup).toContain("Tools: 0");
  });
});
