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
import type { SquadRunPhase, SquadRunsListResult, SquadRunSummaryDto } from "./squad-run-contract.ts";

type LeaderDecision =
  | { readonly kind: "converged" }
  | {
      readonly kind: "plan";
      readonly dispatches: readonly WorkerPlan[];
    };

type LeaderTrigger =
  | { readonly kind: "initial" }
  | {
      readonly kind: "worker_outcome";
      readonly runtimeSessionId: string;
    }
  | {
      readonly kind: "worker_rejected";
      readonly attemptId: string;
    };

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
  readonly binding: RuntimeBinding;
  readonly leaderTurns: readonly LeaderTurn[];
  readonly leaderProviderSessionId: string | null;
  readonly currentLeaderRuntimeSessionId: string | null;
  readonly workerAttempts: readonly WorkerAttempt[];
  readonly observedWorkerRuntimeSessionIds: readonly string[];
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
        binding: { actor: binding.actor, source: binding.source },
        leaderTurns: [],
        leaderProviderSessionId: null,
        currentLeaderRuntimeSessionId: null,
        workerAttempts: [],
        observedWorkerRuntimeSessionIds: [],
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
      matching = readStates()
        .map(summaryDto)
        .filter((run) => activePhase(run.phase) || query.since === null || run.latestActivityAt >= query.since)
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
        if (!discovered.currentLeaderRuntimeSessionId) await spawnPendingLeader(discovered);
      }
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
    const updated = revise(state, {
      observedWorkerRuntimeSessionIds: [...state.observedWorkerRuntimeSessionIds, runtimeSessionId],
      pendingLeaderTriggers: [...state.pendingLeaderTriggers, { kind: "worker_outcome", runtimeSessionId }],
    });
    writeState(updated);
    if (!updated.currentLeaderRuntimeSessionId) await spawnPendingLeader(updated);
  }

  async function continueLeader(state: SquadState, runtimeSessionId: string): Promise<void> {
    const row = dispatchRows(state).find((dispatch) => dispatch.runtimeSessionId === runtimeSessionId),
      turn = state.leaderTurns.find((candidate) => candidate.runtimeSessionId === runtimeSessionId);
    if (!turn) return;
    if (!row || row.outcome !== "succeeded") {
      writeState(
        revise(state, {
          phase: "failed",
          currentLeaderRuntimeSessionId: null,
          error: row
            ? `Leader turn ${turn.turnId} ended with ${row.outcome ?? row.status}.`
            : `Leader turn ${turn.turnId} has no TaskDispatchRow.`,
        }),
      );
      return;
    }
    let decision: LeaderDecision;
    try {
      decision = parseLeaderDecision(resultText(row.resultRef), state.runtimeInstanceId, state.workers);
    } catch (error) {
      consumeKnownError(error);
      writeState(
        revise(state, {
          phase: "failed",
          currentLeaderRuntimeSessionId: null,
          error: errorText(error),
        }),
      );
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
      const activeWorkerIds = new Set(
        workerRows(updated)
          .filter((worker) => worker.row?.outcome === null)
          .map((worker) => worker.attempt.workerId),
      );
      const overlapping = decision.dispatches.find((dispatch) => activeWorkerIds.has(dispatch.workerId));
      if (overlapping) {
        writeState(
          revise(updated, {
            phase: "failed",
            error: `Leader tried to redispatch active worker ${overlapping.workerId}.`,
          }),
        );
        return;
      }
      for (const plan of decision.dispatches) updated = await spawnWorker(updated, plan, turn.turnId);
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
    writeState(
      revise(updated, {
        phase: running ? "workers_running" : "failed",
        error: running ? null : "Leader returned no work and did not declare convergence.",
      }),
    );
  }

  async function spawnWorker(state: SquadState, plan: WorkerPlan, leaderTurnId: string): Promise<SquadState> {
    const attemptId = `worker-${state.workerAttempts.length + 1}`;
    try {
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
    return revise(state, {
      observedWorkerRuntimeSessionIds: [...state.observedWorkerRuntimeSessionIds, ...discovered],
      pendingLeaderTriggers: [
        ...state.pendingLeaderTriggers,
        ...discovered.map(
          (runtimeSessionId): LeaderTrigger => ({
            kind: "worker_outcome",
            runtimeSessionId,
          }),
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
      pendingLeaderCallbackCount: state.pendingLeaderTriggers.length,
      error: state.error,
    };
  }

  function summaryDto(state: SquadState): SquadRunSummaryDto {
    const sessions = [
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
      latestActivityAt: sessions.reduce(
        (latest, session) => (session.lastObservedAt > latest ? session.lastObservedAt : latest),
        "1970-01-01T00:00:00.000Z",
      ),
    };
  }

  return { start, status, list, observeOutcome, reconcile };
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
    "# Squad worker callback",
    `Trigger: ${JSON.stringify(trigger)}`,
    "Review the durable TaskDispatchRow receipts below. " +
      "Return runtime-batch/v1 to reassign or add work. " +
      "Return an empty dispatches array to accept this callback while other work runs. " +
      'Return {"schema":"squad-decision/v1","action":"converged"} only when no worker is running.',
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
    Array.isArray(row.pendingLeaderTriggers) &&
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

function compareRunSummaries(left: SquadRunSummaryDto, right: SquadRunSummaryDto): number {
  const active = Number(activePhase(right.phase)) - Number(activePhase(left.phase));
  return (
    active ||
    right.latestActivityAt.localeCompare(left.latestActivityAt) ||
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
