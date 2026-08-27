import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  consumeKnownError,
  createEntityStore,
  runtimeSessionSemanticState,
  type AgentRuntimeEventV1,
  type CanonicalEventStore,
  type TaskProjection,
} from "../../kernel/src/index.ts";
import { readSquadDeclaration } from "./agent-entities.ts";
import { appendRuntimeWorkerRecord, readDispatchStreams } from "./dispatch-stream.ts";
import { readTaskDispatches } from "./dispatch-read.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeBinding } from "./runtime-spawn-types.ts";
import type {
  SquadRunPhase,
  SquadRunReadResult,
  SquadRunsListResult,
  SquadRunSummaryDto,
} from "./squad-run-contract.ts";

type LeaderDecision =
  | { readonly kind: "converged" }
  | {
      readonly kind: "plan";
      readonly dispatches: readonly WorkerPlan[];
    };

type WorkerWaitTrigger = {
  readonly kind: "worker_wait";
  readonly runtimeSessionId: string;
  readonly reason: string;
};

type LeaderTrigger =
  | { readonly kind: "initial" }
  | {
      readonly kind: "leader_retry";
      readonly turnId: string;
      readonly reason: string;
    }
  | {
      readonly kind: "worker_outcome";
      readonly runtimeSessionId: string;
    }
  | {
      readonly kind: "worker_rejected";
      readonly attemptId: string;
    }
  | WorkerWaitTrigger;

type LeaderTurn = {
  readonly turnId: string;
  readonly trigger: LeaderTrigger;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
  readonly decision: LeaderDecision | null;
};

type WorkerAttempt = {
  readonly attemptId: string;
  readonly workerId: string;
  /** 派发该 attempt 的 leader 轮次(扇出树父子边);存量状态缺此字段 → DTO 归一为 null。 */
  readonly leaderTurnId: string | null;
  readonly dispatchId: string | null;
  readonly runtimeSessionId: string | null;
  readonly rejection: string | null;
};

type WorkerPlan = {
  readonly instance: string;
  readonly workerId: string;
  readonly prompt: string;
};

type SquadState = {
  readonly schema: "squad-run/v1";
  readonly squadRunId: string;
  readonly stateDispatchId: string | null;
  readonly squadId: string;
  readonly taskId: string;
  readonly runtimeInstanceId: string;
  readonly cwd: string;
  readonly mission: string;
  readonly model: string | null;
  readonly effort: string | null;
  readonly leaderAgentId: string;
  readonly roster: string;
  readonly workers: readonly string[];
  readonly leaderTurnBudget: number;
  readonly binding: RuntimeBinding;
  readonly leaderTurns: readonly LeaderTurn[];
  readonly leaderProviderSessionId: string | null;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly workerAttempts: readonly WorkerAttempt[];
  readonly observedWorkerRuntimeSessionIds: readonly string[];
  readonly workerWaits: readonly WorkerWaitTrigger[];
  readonly pendingLeaderTriggers: readonly LeaderTrigger[];
  readonly phase: SquadRunPhase;
  readonly revision: number;
  readonly error: string | null;
};

type RuntimeOutcomeEvent = Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>;

export function makeSquadCoordinator(input: {
  readonly rootDir: string;
  readonly projection: () => TaskProjection;
  readonly store: () => CanonicalEventStore;
  readonly reacquireTaskLease: (taskId: string, binding: RuntimeBinding) => Promise<void>;
  readonly runtimeSpawner: () => {
    readonly spawn: (payload: JsonObject, binding: RuntimeBinding) => Promise<JsonObject>;
  };
}) {
  const start = async (action: JsonObject, binding: RuntimeBinding): Promise<JsonObject> => {
    const squadId = requiredSquadText(action.squadId, "squadId"),
      runtimeInstanceId = requiredSquadText(action.runtimeInstanceId, "runtimeInstanceId"),
      taskId = requiredSquadText(action.taskId, "taskId"),
      mission = requiredSquadText(action.prompt, "prompt"),
      cwd = resolveCwd(input.rootDir, action.cwd),
      squad = readSquadDeclaration({
        rootDir: input.rootDir,
        squadId,
        entityStore: createEntityStore(input.store()),
      }),
      squadRunId = `squad_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      state: SquadState = {
        schema: "squad-run/v1",
        squadRunId,
        stateDispatchId: null,
        squadId,
        taskId,
        runtimeInstanceId,
        cwd,
        mission,
        model: optionalText(action.model),
        effort: optionalText(action.effort),
        leaderAgentId: squad.leader,
        roster: squad.roster,
        workers: squad.workers,
        leaderTurnBudget: squad.leaderTurnBudget,
        binding: { actor: binding.actor, source: binding.source },
        leaderTurns: [],
        leaderProviderSessionId: null,
        currentLeaderRuntimeSessionId: null,
        workerAttempts: [],
        observedWorkerRuntimeSessionIds: [],
        workerWaits: [],
        pendingLeaderTriggers: [],
        phase: "planning",
        revision: 0,
        error: null,
      };
    try {
      const running = await spawnLeader(state, { kind: "initial" });
      return {
        schema: "command-receipt/v2",
        ok: true,
        command: "squad-run",
        outcome: "running",
        squadRunId,
        leaderRuntimeSessionId: running.currentLeaderRuntimeSessionId,
        nextAction: `ha squad status ${squadRunId}`,
        summary: `squad-run ${squadId}: ${squadRunId}`,
        exitCode: 0,
      };
    } catch (error) {
      const failed = revise(state, {
        phase: "failed",
        error: errorText(error),
      });
      return rejection("squad-run", errorCode(error, "squad_leader_failed"), failed.error!);
    }
  };

  const status = (squadRunId: string): JsonObject => {
    if (!validSquadRunId(squadRunId))
      return rejection(
        "squad-status",
        "invalid_squad_run_id",
        "Use the squad_<24 lowercase hex characters> handle returned by ha squad run.",
      );
    const state = readSquadRunState(squadRunId);
    if (!state) return rejection("squad-status", "squad_run_not_found", `Squad run ${squadRunId} does not exist.`);
    const detail = statusDto(state);
    return {
      schema: "command-receipt/v2",
      ok: true,
      command: "squad-status",
      outcome: "applied",
      ...detail,
      status: state.phase,
      summary: `squad-run ${state.squadId}: ${state.phase}`,
      exitCode: 0,
    };
  };

  const list = (payload: Readonly<Record<string, unknown>>): SquadRunsListResult => {
    const query = listQuery(payload),
      cut = input.projection().readTaskStatuses([]),
      // 一次 list 内按 taskId memo 派工台账读:同 task 的多个 run 共享一次读,读放大按 task 数结算。
      dispatchesByTaskId = new Map<string, readonly TaskDispatchRow[]>(),
      matching = readStates()
        .map((state) => summaryDto(state, dispatchesByTaskId))
        .filter((run) => activePhase(run.phase) || query.since === null || runInActivityWindow(run, query.since))
        .filter((run) => matchesRunQuery(run, query.tokens))
        .sort(compareRunSummaries),
      selected = matching.slice(0, query.limit);
    return {
      ok: true,
      status: cut.status,
      runs: selected,
      totals: { runs: matching.length },
      truncated: selected.length < matching.length,
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    };
  };

  // GUI 读面(G12 §2c):把 `ha squad status` 的 statusDto 内容对 GUI 开放为编排
  // 流转详情——leader 轮次、worker 派工链、error 全部来自既有 SquadState 与派工
  // 台账行,零新计算;不存在/非法句柄走读面错误(protocol error),不伪造空详情。
  const read = (squadRunId: string): SquadRunReadResult => {
    if (!validSquadRunId(squadRunId))
      throw squadReadError(
        "invalid_squad_run_id",
        "Use the squad_<24 lowercase hex characters> handle returned by ha squad run.",
      );
    const state = readSquadRunState(squadRunId);
    if (!state) throw squadReadError("squad_run_not_found", `Squad run ${squadRunId} does not exist.`);
    const cut = input.projection().readTaskStatuses([]);
    return detailDto(state, cut);
  };

  const observeOutcome = async (event: RuntimeOutcomeEvent): Promise<void> => {
    await observeRuntimeSession(event.payload.runtimeSessionId);
  };

  const reconcile = async (): Promise<void> => {
    for (const candidate of readStates()) {
      if (terminal(candidate)) continue;
      let state = readSquadRunState(candidate.squadRunId);
      if (!state || terminal(state)) continue;
      const currentLeader = state.currentLeaderRuntimeSessionId;
      if (currentLeader && terminalRow(state, currentLeader)) {
        await observeRuntimeSession(currentLeader);
        state = readSquadRunState(candidate.squadRunId);
        if (!state || terminal(state)) continue;
      }
      const discovered = discoverWorkerCallbacks(state);
      if (discovered !== state) {
        writeState(discovered);
      }
      if (!discovered.currentLeaderRuntimeSessionId && discovered.pendingLeaderTriggers.length)
        await spawnPendingLeader(discovered);
    }
  };

  async function observeRuntimeSession(runtimeSessionId: string): Promise<void> {
    for (const candidate of readStates()) {
      if (terminal(candidate)) continue;
      const state = readSquadRunState(candidate.squadRunId);
      if (!state || terminal(state)) continue;
      if (state.currentLeaderRuntimeSessionId === runtimeSessionId) {
        await continueLeader(state, runtimeSessionId);
        return;
      }
      const worker = state.workerAttempts.find((attempt) => attempt.runtimeSessionId === runtimeSessionId);
      if (worker) {
        await continueWorker(state, runtimeSessionId);
        return;
      }
    }
  }

  async function continueWorker(state: SquadState, runtimeSessionId: string): Promise<void> {
    if (state.observedWorkerRuntimeSessionIds.includes(runtimeSessionId)) return;
    const wait = state.workerWaits.find((candidate) => candidate.runtimeSessionId === runtimeSessionId),
      trigger: LeaderTrigger = wait ?? { kind: "worker_outcome", runtimeSessionId };
    const updated = revise(state, {
      observedWorkerRuntimeSessionIds: [...state.observedWorkerRuntimeSessionIds, runtimeSessionId],
      workerWaits: state.workerWaits.filter((candidate) => candidate.runtimeSessionId !== runtimeSessionId),
      pendingLeaderTriggers: [...state.pendingLeaderTriggers, trigger],
    });
    writeState(updated);
    if (!updated.currentLeaderRuntimeSessionId) await spawnPendingLeader(updated);
  }

  async function continueLeader(state: SquadState, runtimeSessionId: string): Promise<void> {
    const row = dispatchRows(state).find((dispatch) => dispatch.runtimeSessionId === runtimeSessionId),
      turn = state.leaderTurns.find((candidate) => candidate.runtimeSessionId === runtimeSessionId);
    if (!turn) return;
    if (!row || row.outcome !== "succeeded") {
      await retryLeader(
        state,
        turn,
        row
          ? `Leader turn ${turn.turnId} ended with ${row.outcome ?? row.status}.`
          : `Leader turn ${turn.turnId} has no TaskDispatchRow.`,
        row,
      );
      return;
    }
    let decision: LeaderDecision;
    try {
      decision = parseLeaderDecision(resultText(row.resultRef), state.runtimeInstanceId, state.workers);
    } catch (error) {
      consumeKnownError(error);
      await retryLeader(state, turn, errorText(error), row);
      return;
    }
    let updated = revise(state, {
      leaderTurns: state.leaderTurns.map((candidate) =>
        candidate.turnId === turn.turnId ? { ...candidate, decision } : candidate,
      ),
      leaderProviderSessionId: row.providerSessionId ?? state.leaderProviderSessionId,
      currentLeaderRuntimeSessionId: null,
      error: null,
    });
    writeState(updated);

    if (decision.kind === "plan") {
      const activeWorkers = new Map(
        workerRows(updated)
          .filter(({ attempt, row }) => attempt.rejection === null && (!row || row.outcome === null))
          .map(({ attempt }) => [attempt.workerId, attempt] as const),
      );
      for (const plan of decision.dispatches) {
        const active = activeWorkers.get(plan.workerId);
        updated = active ? recordWorkerWait(updated, active) : await spawnWorker(updated, plan, turn.turnId);
      }
    }

    updated = discoverWorkerCallbacks(updated);
    writeState(updated);
    if (updated.pendingLeaderTriggers.length) {
      await spawnPendingLeader(updated);
      return;
    }
    const running = hasRunningWorkers(updated);
    if (decision.kind === "converged") {
      writeState(
        revise(updated, {
          phase: running ? "failed" : "converged",
          error: running ? "Leader declared convergence while worker dispatches were still running." : null,
        }),
      );
      return;
    }
    if (running) {
      writeState(revise(updated, { phase: "workers_running", error: null }));
      return;
    }
    await retryLeader(updated, turn, "Leader returned no work and did not declare convergence.");
  }

  async function retryLeader(
    state: SquadState,
    turn: LeaderTurn,
    reason: string,
    row?: TaskDispatchRow,
  ): Promise<void> {
    const retrying = revise(state, {
      leaderProviderSessionId: row?.providerSessionId ?? state.leaderProviderSessionId,
      currentLeaderRuntimeSessionId: null,
      pendingLeaderTriggers: [{ kind: "leader_retry", turnId: turn.turnId, reason }, ...state.pendingLeaderTriggers],
      phase: "planning",
    });
    writeState(retrying);
    await spawnPendingLeader(retrying);
  }

  async function spawnWorker(state: SquadState, plan: WorkerPlan, leaderTurnId: string): Promise<SquadState> {
    const attemptId = `worker-${state.workerAttempts.length + 1}`;
    try {
      await input.reacquireTaskLease(state.taskId, state.binding);
      const receipt = await input.runtimeSpawner().spawn(
          {
            runtimeInstanceId: state.runtimeInstanceId,
            agentId: state.leaderAgentId,
            targetAgentId: plan.workerId,
            prompt: plan.prompt,
            cwd: cwdPayload(input.rootDir, state.cwd),
            taskId: state.taskId,
            ...(state.model ? { model: state.model } : {}),
            ...(state.effort ? { effort: state.effort } : {}),
            idempotencyKey: `${state.squadRunId}:${leaderTurnId}:${attemptId}`,
          },
          state.binding,
        ),
        dispatchId = requiredReceiptText(receipt, "dispatchId"),
        runtimeSessionId = requiredReceiptText(receipt, "runtimeSessionId"),
        updated = revise(state, {
          workerAttempts: [
            ...state.workerAttempts,
            {
              attemptId,
              workerId: plan.workerId,
              leaderTurnId,
              dispatchId,
              runtimeSessionId,
              rejection: null,
            },
          ],
          phase: "workers_running",
        });
      writeState(updated);
      return updated;
    } catch (error) {
      const updated = revise(state, {
        workerAttempts: [
          ...state.workerAttempts,
          {
            attemptId,
            workerId: plan.workerId,
            leaderTurnId,
            dispatchId: null,
            runtimeSessionId: null,
            rejection: errorText(error),
          },
        ],
        pendingLeaderTriggers: [...state.pendingLeaderTriggers, { kind: "worker_rejected", attemptId }],
      });
      writeState(updated);
      return updated;
    }
  }

  function recordWorkerWait(state: SquadState, attempt: WorkerAttempt): SquadState {
    if (
      attempt.runtimeSessionId === null ||
      state.workerWaits.some((wait) => wait.runtimeSessionId === attempt.runtimeSessionId)
    )
      return state;
    return revise(state, {
      workerWaits: [
        ...state.workerWaits,
        {
          kind: "worker_wait",
          runtimeSessionId: attempt.runtimeSessionId,
          reason:
            `Worker ${attempt.workerId} already has running attempt ${attempt.attemptId}; ` +
            `waited for its callback instead of redispatching.`,
        },
      ],
    });
  }

  async function spawnPendingLeader(state: SquadState): Promise<SquadState> {
    const trigger = state.pendingLeaderTriggers[0];
    if (!trigger) return state;
    try {
      return await spawnLeader(state, trigger);
    } catch (error) {
      const failed = revise(state, {
        phase: "failed",
        currentLeaderRuntimeSessionId: null,
        error: errorText(error),
      });
      writeState(failed);
      return failed;
    }
  }

  async function spawnLeader(state: SquadState, trigger: LeaderTrigger): Promise<SquadState> {
    if (state.leaderTurns.length >= state.leaderTurnBudget)
      throw new Error(`leader turn budget ${state.leaderTurnBudget} exhausted`);
    if (trigger.kind !== "initial") await input.reacquireTaskLease(state.taskId, state.binding);
    const turnId = `leader-${state.leaderTurns.length + 1}`,
      prompt =
        trigger.kind === "initial"
          ? initialLeaderPrompt(state)
          : callbackLeaderPrompt(state, trigger, dispatchRows(state)),
      receipt = await input.runtimeSpawner().spawn(
        {
          runtimeInstanceId: state.runtimeInstanceId,
          agentId: state.leaderAgentId,
          permissionMode: "read-only",
          prompt,
          cwd: cwdPayload(input.rootDir, state.cwd),
          taskId: state.taskId,
          ...(state.model ? { model: state.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
          ...(trigger.kind !== "initial" && state.leaderProviderSessionId
            ? { providerSessionId: state.leaderProviderSessionId }
            : {}),
          idempotencyKey:
            trigger.kind === "initial"
              ? `${state.squadRunId}:leader:initial`
              : `${state.squadRunId}:leader:${triggerKey(trigger)}`,
        },
        state.binding,
      ),
      dispatchId = requiredReceiptText(receipt, "dispatchId"),
      runtimeSessionId = requiredReceiptText(receipt, "runtimeSessionId"),
      updated = revise(state, {
        stateDispatchId: state.stateDispatchId ?? dispatchId,
        leaderTurns: [
          ...state.leaderTurns,
          {
            turnId,
            trigger,
            dispatchId,
            runtimeSessionId,
            decision: null,
          },
        ],
        currentLeaderRuntimeSessionId: runtimeSessionId,
        pendingLeaderTriggers:
          trigger.kind === "initial" ? state.pendingLeaderTriggers : state.pendingLeaderTriggers.slice(1),
        phase: "leader_running",
        error: null,
      });
    writeState(updated);
    return updated;
  }

  function discoverWorkerCallbacks(state: SquadState): SquadState {
    const discovered = workerRows(state)
      .filter(
        ({ attempt, row }) =>
          attempt.runtimeSessionId !== null &&
          row !== undefined &&
          row.outcome !== null &&
          !state.observedWorkerRuntimeSessionIds.includes(attempt.runtimeSessionId),
      )
      .map(({ attempt }) => attempt.runtimeSessionId!);
    if (!discovered.length) return state;
    const waits = new Map(state.workerWaits.map((wait) => [wait.runtimeSessionId, wait]));
    return revise(state, {
      observedWorkerRuntimeSessionIds: [...state.observedWorkerRuntimeSessionIds, ...discovered],
      workerWaits: state.workerWaits.filter((wait) => !discovered.includes(wait.runtimeSessionId)),
      pendingLeaderTriggers: [
        ...state.pendingLeaderTriggers,
        ...discovered.map(
          (runtimeSessionId): LeaderTrigger =>
            waits.get(runtimeSessionId) ?? { kind: "worker_outcome", runtimeSessionId },
        ),
      ],
    });
  }

  function hasRunningWorkers(state: SquadState): boolean {
    return workerRows(state).some(({ attempt, row }) => attempt.rejection === null && (!row || row.outcome === null));
  }

  function workerRows(state: SquadState): readonly {
    readonly attempt: WorkerAttempt;
    readonly row: TaskDispatchRow | undefined;
  }[] {
    const byDispatchId = new Map(dispatchRows(state).map((row) => [row.dispatchId, row]));
    return state.workerAttempts.map((attempt) => ({
      attempt,
      row: attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined,
    }));
  }

  function dispatchRows(state: SquadState): readonly TaskDispatchRow[] {
    return readTaskDispatches({
      rootDir: input.rootDir,
      projection: input.projection(),
      taskId: state.taskId,
    }).dispatches;
  }

  /** list 专用:同 task 的多个 run 共享一次台账读(per-call memo,不跨 list 复用)。 */
  function summaryDispatchRows(
    state: SquadState,
    cache: Map<string, readonly TaskDispatchRow[]>,
  ): readonly TaskDispatchRow[] {
    const memoized = cache.get(state.taskId);
    if (memoized !== undefined) return memoized;
    const rows = dispatchRows(state);
    cache.set(state.taskId, rows);
    return rows;
  }

  function terminalRow(state: SquadState, runtimeSessionId: string): TaskDispatchRow | undefined {
    return dispatchRows(state).find((row) => row.runtimeSessionId === runtimeSessionId && row.outcome !== null);
  }

  function resultText(resultRef: string | null | undefined): string {
    const match = resultRef ? /^artifact:runtime-result\/sha256\/([0-9a-f]{64})$/u.exec(resultRef) : null;
    if (!match) throw new Error("Leader TaskDispatchRow has no runtime result reference.");
    const blob = input.store().readContentBlob(match[1]!);
    if (!blob) throw new Error(`Leader result ${resultRef} is unavailable.`);
    return new TextDecoder().decode(blob);
  }

  /** 读面专用:receipt 缺失(未结算/台账缺行/内容包裁剪)呈 null 不抛——fail-closed
   * 语义由上面的 resultText 独占;解码与控制路径同款,不二次解释字节。 */
  function receiptText(row: TaskDispatchRow | undefined): string | null {
    const match = row?.resultRef ? /^artifact:runtime-result\/sha256\/([0-9a-f]{64})$/u.exec(row.resultRef) : null;
    if (!match) return null;
    const blob = input.store().readContentBlob(match[1]!);
    return blob ? new TextDecoder().decode(blob) || null : null;
  }

  function readSquadRunState(squadRunId: string): SquadState | null {
    if (!validSquadRunId(squadRunId)) return null;
    ensureSquadRunProjection();
    const row = input.projection().readSquadRun(squadRunId),
      state = squadState(row?.state);
    if (row !== null && state === null) throw new Error(`Squad run projection ${squadRunId} is invalid.`);
    return state;
  }

  function readStates(): readonly SquadState[] {
    ensureSquadRunProjection();
    return input
      .projection()
      .readSquadRuns()
      .map((row) => {
        const state = squadState(row.state);
        if (!state) throw new Error(`Squad run projection ${row.squadRunId} is invalid.`);
        return state;
      });
  }

  function ensureSquadRunProjection(): void {
    const projection = input.projection();
    if (projection.squadRunProjectionReady()) return;
    const states = new Map<string, SquadState>();
    for (const stream of readDispatchStreams(input.rootDir)) {
      for (const record of stream.records) {
        if (record.kind !== "squad_run_state") continue;
        const state = squadState(record.state);
        if (!state) continue;
        const current = states.get(state.squadRunId);
        if (!current || current.revision < state.revision) states.set(state.squadRunId, state);
      }
    }
    projection.replaceSquadRuns(
      [...states.values()].map((state) => ({
        squadRunId: state.squadRunId,
        revision: state.revision,
        state,
      })),
    );
  }

  function writeState(state: SquadState): void {
    if (!state.stateDispatchId) throw new Error("Squad state has no owning dispatch stream.");
    ensureSquadRunProjection();
    const projection = input.projection();
    projection.markSquadRunProjectionDirty();
    appendRuntimeWorkerRecord(input.rootDir, state.stateDispatchId, {
      kind: "squad_run_state",
      squadRunId: state.squadRunId,
      revision: state.revision,
      state,
    });
    projection.upsertSquadRun({ squadRunId: state.squadRunId, revision: state.revision, state });
  }

  function statusDto(state: SquadState) {
    const rows = dispatchRows(state),
      byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
    return {
      squadRunId: state.squadRunId,
      squadId: state.squadId,
      taskId: state.taskId,
      mission: state.mission,
      revision: state.revision,
      currentLeaderRuntimeSessionId: state.currentLeaderRuntimeSessionId,
      leaderRuntimeSessionIds: state.leaderTurns.map((turn) => turn.runtimeSessionId),
      leaders: state.leaderTurns.map((turn) => ({ ...byDispatchId.get(turn.dispatchId), ...turn })),
      workers: state.workerAttempts.map((attempt) => ({
        ...(attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined),
        ...attempt,
      })),
      workerCallbackCount: state.observedWorkerRuntimeSessionIds.length,
      pendingLeaderCallbackCount: state.pendingLeaderTriggers.length + state.workerWaits.length,
      error: state.error,
    };
  }

  function detailDto(
    state: SquadState,
    cut: { readonly status: "ready" | "pending"; readonly watermark: number; readonly sourceRevision: number },
  ): SquadRunReadResult {
    const rows = dispatchRows(state),
      byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
    return {
      ok: true,
      status: cut.status,
      run: {
        squadRunId: state.squadRunId,
        squadId: state.squadId,
        taskId: state.taskId,
        mission: state.mission,
        phase: state.phase,
        error: state.error,
        currentLeaderRuntimeSessionId: state.currentLeaderRuntimeSessionId,
        leaderTurns: state.leaderTurns.map((turn) => {
          const row = byDispatchId.get(turn.dispatchId);
          return {
            turnId: turn.turnId,
            trigger: turn.trigger,
            dispatchId: turn.dispatchId,
            runtimeSessionId: turn.runtimeSessionId,
            decision:
              turn.decision === null
                ? null
                : turn.decision.kind === "converged"
                  ? { kind: "converged" }
                  : { kind: "plan", dispatchCount: turn.decision.dispatches.length },
            resultText: receiptText(row),
            status: row?.status ?? null,
            startedAt: row?.startedAt ?? null,
            endedAt: row?.endedAt ?? null,
          };
        }),
        workerAttempts: state.workerAttempts.map((attempt) => {
          const row = attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined;
          return {
            attemptId: attempt.attemptId,
            workerId: attempt.workerId,
            leaderTurnId: attempt.leaderTurnId ?? null,
            dispatchId: attempt.dispatchId,
            runtimeSessionId: attempt.runtimeSessionId,
            rejection: attempt.rejection,
            status: row?.status ?? null,
            startedAt: row?.startedAt ?? null,
            endedAt: row?.endedAt ?? null,
          };
        }),
      },
      watermark: cut.watermark,
      sourceRevision: cut.sourceRevision,
    };
  }

  function summaryDto(
    state: SquadState,
    dispatchesByTaskId: Map<string, readonly TaskDispatchRow[]>,
  ): SquadRunSummaryDto {
    const byDispatchId = new Map(summaryDispatchRows(state, dispatchesByTaskId).map((row) => [row.dispatchId, row])),
      sessions = [
        ...state.leaderTurns.map((turn) => turn.runtimeSessionId),
        ...state.workerAttempts.flatMap((attempt) => (attempt.runtimeSessionId ? [attempt.runtimeSessionId] : [])),
      ]
        .map((runtimeSessionId) => input.projection().readRuntimeSession(runtimeSessionId))
        .filter((session) => session !== null);
    return {
      squadRunId: state.squadRunId,
      squadId: state.squadId,
      taskId: state.taskId,
      mission: state.mission,
      phase: state.phase,
      leaderTurnCount: state.leaderTurns.length,
      workerAttemptCount: state.workerAttempts.length,
      runningCount: sessions.filter((session) => runtimeSessionSemanticState(session) === "running").length,
      // 活动时间只从已落盘事实按瞬值取 max:run 自有派工台账行(startedAt 恒有、归档另有 endedAt)∪ 成员会话最后观测时间;epoch 仅是空集的 max 恒等元,不是读取兜底。
      latestActivityAt: [
        ...state.leaderTurns.flatMap((turn) => dispatchRowStamps(byDispatchId.get(turn.dispatchId))),
        ...state.workerAttempts.flatMap((attempt) => dispatchRowStamps(byDispatchId.get(attempt.dispatchId ?? ""))),
        ...sessions.map((session) => session.lastObservedAt),
      ].reduce(
        (latest, stamp) => (Date.parse(stamp) > Date.parse(latest) ? stamp : latest),
        "1970-01-01T00:00:00.000Z",
      ),
    };
  }

  return { start, status, list, read, observeOutcome, reconcile };
}

function initialLeaderPrompt(state: SquadState): string {
  const example = JSON.stringify({
    schema: "runtime-batch/v1",
    dispatches: [
      {
        instance: state.runtimeInstanceId,
        to: "worker-id",
        prompt: "worker mission",
      },
    ],
  });
  return [
    "# Squad dispatch protocol",
    "Return exactly one JSON object and no Markdown:",
    example,
    "Choose only declared workers. Harness owns agent identity, task, cwd, and spawning.",
    `# Squad roster\n${state.roster}`,
    `# User mission\n${state.mission}`,
  ].join("\n\n");
}

function callbackLeaderPrompt(state: SquadState, trigger: LeaderTrigger, rows: readonly TaskDispatchRow[]): string {
  const statusRows = statusRowsForPrompt(state, rows);
  return [
    trigger.kind === "leader_retry" ? "# Squad leader retry" : "# Squad worker callback",
    `Trigger: ${JSON.stringify(trigger)}`,
    ...(trigger.kind === "leader_retry"
      ? [`Previous turn could not advance: ${trigger.reason}`]
      : trigger.kind === "worker_wait"
        ? [`Wait completed: ${trigger.reason}`]
        : []),
    "Review the durable TaskDispatchRow receipts below. " +
      "Return runtime-batch/v1 to reassign or add work. " +
      "Return an empty dispatches array to accept this callback while other work runs. " +
      'Return {"schema":"squad-decision/v1","action":"converged"} only when no worker is running. ' +
      "Return exactly one JSON object and no Markdown. " +
      "Do not redispatch a worker whose receipt is still running; omit it and wait for its callback.",
    ...statusRows,
    `# Original mission\n${state.mission}`,
  ].join("\n\n");
}

function statusRowsForPrompt(state: SquadState, rows: readonly TaskDispatchRow[]): readonly string[] {
  const byDispatchId = new Map(rows.map((row) => [row.dispatchId, row]));
  return state.workerAttempts.map((attempt) => {
    const row = attempt.dispatchId ? byDispatchId.get(attempt.dispatchId) : undefined;
    return [
      `worker ${attempt.workerId}`,
      `attempt=${attempt.attemptId}`,
      `dispatch=${attempt.dispatchId ?? "none"}`,
      `session=${attempt.runtimeSessionId ?? "none"}`,
      `status=${attempt.rejection ? "rejected" : (row?.status ?? "running")}`,
      `exitCode=${String(row?.exitCode ?? "none")}`,
      `resultRef=${row?.resultRef ?? "none"}`,
      `reportPath=${row?.reportPath ?? "none"}`,
      `rejection=${attempt.rejection ?? "none"}`,
    ].join(" ");
  });
}

function parseLeaderDecision(text: string, runtimeInstanceId: string, workers: readonly string[]): LeaderDecision {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error("Leader result was not JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Leader result was not an object.");
  const row = value as Record<string, unknown>;
  if (row.schema === "squad-decision/v1" && row.action === "converged") return { kind: "converged" };
  if (row.schema !== "runtime-batch/v1" || !Array.isArray(row.dispatches))
    throw new Error("Leader result must be runtime-batch/v1 or a converged squad-decision/v1.");
  const seen = new Set<string>(),
    dispatches = row.dispatches.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Leader dispatch is invalid.");
      const item = entry as Record<string, unknown>,
        instance = requiredSquadText(item.instance, "worker instance"),
        workerId = requiredSquadText(item.to, "worker id"),
        prompt = requiredSquadText(item.prompt, "worker prompt");
      if (instance !== runtimeInstanceId)
        throw new Error(`Leader dispatch must use runtime instance ${runtimeInstanceId}.`);
      if (!workers.includes(workerId) || seen.has(workerId))
        throw new Error(`Leader selected invalid or duplicate worker ${workerId}.`);
      const allowed = new Set(["instance", "to", "prompt"]);
      if (Object.keys(item).some((key) => !allowed.has(key)))
        throw new Error("Leader dispatch contains harness-owned fields.");
      seen.add(workerId);
      return { instance, workerId, prompt };
    });
  return { kind: "plan", dispatches };
}

function squadState(value: unknown): SquadState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<SquadState>;
  return row.schema === "squad-run/v1" &&
    typeof row.squadRunId === "string" &&
    validSquadRunId(row.squadRunId) &&
    typeof row.stateDispatchId === "string" &&
    Array.isArray(row.leaderTurns) &&
    Array.isArray(row.workerAttempts) &&
    Array.isArray(row.observedWorkerRuntimeSessionIds) &&
    Array.isArray(row.workerWaits) &&
    Array.isArray(row.pendingLeaderTriggers) &&
    Number.isSafeInteger(row.leaderTurnBudget) &&
    Number(row.leaderTurnBudget) >= 1 &&
    typeof row.revision === "number"
    ? (value as SquadState)
    : null;
}

function revise(
  state: SquadState,
  change: Partial<Omit<SquadState, "schema" | "squadRunId" | "revision">>,
): SquadState {
  return { ...state, ...change, revision: state.revision + 1 };
}

function terminal(state: SquadState): boolean {
  return state.phase === "converged" || state.phase === "failed";
}

function requiredSquadText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} is required.`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requiredReceiptText(receipt: JsonObject, field: string): string {
  if (receipt.ok !== true) throw new Error(receiptHint(receipt));
  return requiredSquadText(receipt[field], field);
}

function receiptHint(receipt: JsonObject): string {
  const error = receipt.error && typeof receipt.error === "object" ? (receipt.error as Record<string, unknown>) : null;
  return typeof error?.hint === "string" ? error.hint : "Runtime dispatch was rejected.";
}

function resolveCwd(rootDir: string, value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return rootDir;
  const row = value as Record<string, unknown>;
  if (row.scope === "repo-root") return rootDir;
  if (row.scope === "repo-relative" && typeof row.path === "string") return path.resolve(rootDir, row.path);
  throw new Error("Squad cwd must be repository-relative.");
}

function cwdPayload(rootDir: string, cwd: string): JsonObject {
  const relative = path.relative(rootDir, cwd);
  return relative ? { scope: "repo-relative", path: relative } : { scope: "repo-root" };
}

function triggerKey(trigger: Exclude<LeaderTrigger, { readonly kind: "initial" }>): string {
  if (trigger.kind === "leader_retry") return `retry:${trigger.turnId}`;
  if (trigger.kind === "worker_wait") return `wait:${trigger.runtimeSessionId}`;
  return trigger.kind === "worker_outcome" ? `outcome:${trigger.runtimeSessionId}` : `rejected:${trigger.attemptId}`;
}

function listQuery(payload: Readonly<Record<string, unknown>>): {
  readonly since: string | null;
  readonly tokens: readonly string[];
  readonly limit: number;
} {
  const fields = Object.keys(payload),
    since = payload.since,
    query = payload.query,
    limit = payload.limit;
  if (
    fields.some((field) => !["since", "query", "limit"].includes(field)) ||
    (since !== undefined && (typeof since !== "string" || !Number.isFinite(Date.parse(since)))) ||
    (query !== undefined && typeof query !== "string") ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 1_000))
  )
    throw squadReadError("invalid_request", "Squad run lists accept ISO since, text query, and limit 1..1000.");
  return {
    since: typeof since === "string" ? new Date(since).toISOString() : null,
    tokens: typeof query === "string" ? query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean) : [],
    limit: typeof limit === "number" ? limit : 200,
  };
}

function matchesRunQuery(run: SquadRunSummaryDto, tokens: readonly string[]): boolean {
  const searchable = [run.squadRunId, run.squadId, run.taskId, run.mission, run.phase].join("\n").toLocaleLowerCase();
  return tokens.every((token) => searchable.includes(token));
}

function activePhase(phase: SquadRunPhase): boolean {
  return phase === "planning" || phase === "leader_running" || phase === "workers_running";
}

/** 小队 run 版的活动窗判定,语义对齐 kernel 的 runtimeSessionInActivityWindow:比时间
 * 瞬值而非字符串,不同毫秒精度/秒精度的 ISO 戳不会因字典序错判进出窗口。 */
function runInActivityWindow(run: SquadRunSummaryDto, since: string): boolean {
  return Date.parse(run.latestActivityAt) >= Date.parse(since);
}

/** 派工台账行的已落盘时间事实:startedAt 恒有,endedAt 仅归档结算行有;无台账行的派工不贡献时间。 */
function dispatchRowStamps(row: TaskDispatchRow | undefined): readonly string[] {
  return row === undefined ? [] : [row.startedAt, ...(row.endedAt === null ? [] : [row.endedAt])];
}

function compareRunSummaries(left: SquadRunSummaryDto, right: SquadRunSummaryDto): number {
  const active = Number(activePhase(right.phase)) - Number(activePhase(left.phase));
  return (
    active ||
    Date.parse(right.latestActivityAt) - Date.parse(left.latestActivityAt) ||
    left.squadRunId.localeCompare(right.squadRunId)
  );
}

function validSquadRunId(value: unknown): value is string {
  return typeof value === "string" && /^squad_[a-f0-9]{24}$/u.test(value);
}

function squadReadError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown, fallback: string): string {
  return error && typeof error === "object" && typeof (error as { readonly code?: unknown }).code === "string"
    ? String((error as { readonly code: string }).code)
    : fallback;
}

function rejection(command: string, code: string, hint: string): JsonObject {
  return {
    schema: "command-receipt/v2",
    ok: false,
    command,
    outcome: "rejected",
    code,
    nextAction: hint,
    error: { code, hint },
    exitCode: 1,
  };
}
