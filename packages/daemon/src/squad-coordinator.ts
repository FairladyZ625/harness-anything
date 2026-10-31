import { readProjectedAgentDeclaration } from "./agent-declaration-resolution.ts";
import { requireSquadRunSubjectCurrent, squadRunSubjectCurrent } from "./squad-runtime-ingress.ts";
import { squadRunObservation } from "./squad-observation.ts";
import type { SquadRunObservation, SquadRunSubjectV1 } from "@harness-anything/kernel";
import { randomUUID } from "node:crypto";
import { localGitObjectRefStore } from "@harness-anything/storage";
import {
  consumeKnownError,
  isSameExecution,
  isTerminalStatus,
  parseSquadDeclarationV1,
  type AgentRuntimeEventV1,
  type TaskProjection,
} from "@harness-anything/kernel";
import { appendRuntimeWorkerRecord } from "./dispatch-stream.ts";
import { storedAgentDeclarationOutcome } from "./agent-declaration-resolution.ts";
import { readTaskDispatches } from "./dispatch-read.ts";
import type { TaskDispatchRow } from "./protocol/daemon-protocol.contract.ts";
import type { JsonObject } from "./protocol/json-rpc-types.ts";
import type { RuntimeBinding, TrustedScheduleRuntime } from "./runtime-spawn-types.ts";
import { cellCriterionError } from "./repo-cell-errors.ts";
import { deriveTaskMission } from "./runtime-spawn-mission.ts";
import {
  cwdPayload,
  prepareWorkerWorktree,
  reclaimWorkerCheckouts,
  resolveSquadCwd,
  workerPrompt,
} from "./squad-worker-checkout.ts";
import type { WorktreeSetupSettings } from "./worktree-setup.ts";
import {
  callbackLeaderPrompt,
  initialLeaderPrompt,
  parseLeaderDecision,
  synthesisReportPath,
  triggerKey,
  type LeaderDecision,
  type LeaderTrigger,
  type LeaderTurn,
  type WorkerAttempt,
  type WorkerPlan,
} from "./squad-leader-decision.ts";
import {
  latestSquadStates,
  squadPublicationAcks,
  squadScheduleSubject,
  squadTaskRef,
  terminal,
  validSquadRunId,
  type SquadState,
} from "./squad-run-state.ts";
import { checkWorkerOwnership, overlappingWorkerPaths, type WorkerOwnershipCheck } from "./squad-worker-ownership.ts";
import {
  convergenceError,
  dispatchRows as squadDispatchRows,
  errorCode,
  errorText,
  hasRunningWorkers as squadHasRunningWorkers,
  optionalText,
  requiredReceiptText,
  requiredSquadText,
  resultText as squadResultText,
  revise,
  terminalRow as squadTerminalRow,
  workerRows as squadWorkerRows,
} from "./squad-coordinator-helpers.ts";
import { makeSquadPublicationController } from "./squad-coordinator-publication.ts";

type RuntimeOutcomeEvent = Extract<AgentRuntimeEventV1, { readonly type: "runtime_session_outcome_observed" }>;

/** The schedule occurrence a run settles with, once its own phase is terminal. */
export interface SquadScheduleSettlement {
  readonly schedule: TrustedScheduleRuntime;
  readonly outcome: "succeeded" | "failed" | "cancelled";
  readonly reason: string | null;
  readonly endedAt: string;
  readonly dispatchId: string;
  readonly runtimeSessionId: string;
}
export function makeSquadCoordinator(input: {
  readonly rootDir: string;
  readonly now: () => string;
  readonly publishObservation: (observation: SquadRunObservation, binding: RuntimeBinding) => Promise<void>;
  /** Settings `worktree.setup`: what the Squad's task worktree and each worker worktree run once. */
  readonly readWorktreeSetup: () => WorktreeSetupSettings;
  readonly query: <T>(read: (projection: TaskProjection) => T) => T;
  readonly readResult: (ref: string) => string;
  readonly reacquireTaskLease: (
    taskId: string,
    binding: RuntimeBinding,
    parent?: Pick<SquadState, "squadRunId" | "subject">,
  ) => Promise<void>;
  readonly releaseTaskLease: (
    taskId: string,
    binding: RuntimeBinding,
    executionId: string,
    squadRunId: string,
  ) => Promise<void>;
  /** Settles a schedule-occurrence run's occurrence at run terminal; idempotent per claim fence. */
  readonly settleScheduleOccurrence: (settlement: SquadScheduleSettlement, binding: RuntimeBinding) => Promise<void>;
  /**
   * Closes an ended assignment task (release any held lease, then cancel) so its execution
   * worktable slot leaves at stage end, not at squad convergence. Called only for attempts
   * whose dispatch already reached an outcome or was rejected.
   */
  readonly settleChildTask: (
    child: {
      readonly squadRunId: string;
      readonly taskId: string;
      readonly workerId: string;
      readonly runtimeSessionId: string | null;
      readonly reason: string;
    },
    binding: RuntimeBinding,
  ) => Promise<void>;
  readonly createChildTask: (
    child: {
      /** The parent task of a task-subject run; a schedule-occurrence run's children are parentless. */
      readonly parentTaskId: string | null;
      readonly squadRunId: string;
      readonly key: string;
      readonly workerId: string;
      readonly prompt: string;
      readonly ownedPaths: readonly string[];
    },
    binding: RuntimeBinding,
  ) => Promise<string>;
  readonly recordOwnershipCheck: (
    child: {
      readonly parentTaskId: string | null;
      readonly squadRunId: string;
      readonly taskId: string;
      readonly executionId: string;
      readonly check: WorkerOwnershipCheck;
    },
    binding: RuntimeBinding,
  ) => Promise<void>;
  readonly publishSynthesisReport: (
    report: {
      readonly taskId: string;
      readonly squadRunId: string;
      readonly reportPath: string;
      readonly body: string;
      readonly leaderRuntimeSessionId: string;
    },
    binding: RuntimeBinding,
  ) => Promise<void>;
  readonly runtimeSpawner: () => {
    readonly spawn: (
      payload: JsonObject,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) => Promise<JsonObject>;
    /** The trusted-schedule channel a schedule-occurrence run's leader turns dispatch through. */
    readonly spawnScheduled: (
      payload: JsonObject,
      scheduled: TrustedScheduleRuntime,
      binding: RuntimeBinding,
      onPrepared?: (dispatchId: string, runtimeSessionId: string) => void,
    ) => Promise<JsonObject>;
    readonly cancel: (payload: JsonObject, binding: RuntimeBinding) => Promise<JsonObject>;
  };
}) {
  const states = new Map(latestSquadStates(input.rootDir)),
    publicationAcks = squadPublicationAcks(input.rootDir),
    /** Initial dispatches are reserved before their first leader turn is durable. */
    initialDispatches = new Set<string>();
  const dispatchRows = (state: SquadState): readonly TaskDispatchRow[] =>
      squadDispatchRows(state, input.query, input.rootDir),
    workerRows = (state: SquadState) => squadWorkerRows(state, dispatchRows),
    hasRunningWorkers = (state: SquadState): boolean => squadHasRunningWorkers(state, workerRows),
    terminalRow = (state: SquadState, runtimeSessionId: string): TaskDispatchRow | undefined =>
      squadTerminalRow(state, runtimeSessionId, dispatchRows),
    resultText = (resultRef: string | null | undefined): string => squadResultText(resultRef, input.readResult),
    publication = makeSquadPublicationController({
      rootDir: input.rootDir,
      now: input.now,
      states,
      publicationAcks,
      subjectCurrent: (state) => subjectCurrent(state),
      query: input.query,
      publishObservation: input.publishObservation,
      settleScheduleOccurrence: input.settleScheduleOccurrence,
      runtimeSpawner: input.runtimeSpawner,
    });
  /** The run's admission liveness: a task subject needs its execution current, a schedule subject its occurrence claim. */
  function subjectCurrent(state: SquadState): boolean {
    return input.query((projection) => squadRunSubjectCurrent(projection, state.subject));
  }
  /** Subject-specific admission before each dispatching step: reacquire the task lease, or re-witness the claim. */
  async function admitRunSubject(state: SquadState): Promise<void> {
    const task = squadTaskRef(state);
    if (task) {
      await input.reacquireTaskLease(task.taskId, state.binding, state);
      return;
    }
    input.query((projection) => requireSquadRunSubjectCurrent(projection, state.subject));
  }
  const start = async (action: JsonObject, binding: RuntimeBinding): Promise<JsonObject> => {
    const taskId = requiredSquadText(action.taskId, "taskId"),
      activeRun = readStates().find(
        (state) =>
          state.subject.kind === "task" && state.subject.taskId === taskId && !terminal(state) && subjectCurrent(state),
      );
    if (activeRun)
      throw cellCriterionError(
        "squad_run_active",
        `Task ${taskId} already has active Squad run ${activeRun.squadRunId}.`,
        "run",
        "squad/task-run-available",
        [`Run ha squad status ${activeRun.squadRunId}; cancel it before starting another Squad run for this Task.`],
      );
    const squadId = requiredSquadText(action.squadId, "squadId"),
      runtimeInstanceId = requiredSquadText(action.runtimeInstanceId, "runtimeInstanceId"),
      cwd = await resolveSquadCwd(input.rootDir, action.cwd, input.query, taskId, input.readWorktreeSetup()),
      squad = squadForRun(squadId),
      baseSha = localGitObjectRefStore.headCommit(cwd);
    let mission: string;
    let publicMission: string;
    await input.reacquireTaskLease(taskId, binding);
    try {
      const taskMission = input.query((projection) =>
        deriveTaskMission(input.rootDir, cwd, projection, taskId, "squad.run"),
      );
      mission = optionalText(action.prompt) ?? taskMission.mission;
      publicMission =
        optionalText(action.prompt) ?? input.query((projection) => projection.read(taskId).snapshot.task!.title);
    } catch (error) {
      throw cellCriterionError(
        errorCode(error, "squad_task_unavailable"),
        errorText(error),
        "run",
        "squad/task-mission-ready",
        [`Run ha task show ${taskId}, make its mission dispatchable, then retry ha squad run ${squadId}.`],
      );
    }
    const squadRunId = `squad_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      state: SquadState = {
        schema: "squad-run/v1",
        squadRunId,
        stateDispatchId: null,
        squadId,
        subject: {
          kind: "task",
          taskId,
          executionId: input.query((projection) => projection.currentLease(taskId))!.executionId,
        },
        scheduleRuntime: null,
        runtimeInstanceId,
        cwd,
        baseSha,
        mission,
        publicMission,
        model: optionalText(action.model),
        effort: optionalText(action.effort),
        permissionMode: optionalText(action.permissionMode),
        leaderAgentId: squad.leader,
        roster: squad.roster,
        workers: squad.workers,
        leaderTurnBudget: squad.leaderTurnBudget,
        binding: {
          actor: binding.actor,
          source: binding.source,
        },
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
        squadRunId,
        leaderRuntimeSessionId: running.currentLeaderRuntimeSessionId,
        status: "leader_running",
        summary: `squad-run ${squadId}: ${squadRunId}`,
      };
    } catch (error) {
      const prepared = states.get(squadRunId);
      const failed = revise(prepared ?? state, { phase: "failed", error: errorText(error) });
      if (prepared?.stateDispatchId) await writeState(failed);
      throw cellCriterionError(errorCode(error, "squad_leader_failed"), failed.error!, "run", "squad/leader-dispatch", [
        `Inspect the runtime instance and leader Agent, then retry ha squad run ${squadId}.`,
      ]);
    }
  };

  /**
   * The schedule dispatch route's entry: a claimed occurrence starts a Squad run riding that
   * claim. Single-flight is the occurrence claim itself; the run settles the occurrence when its
   * own phase turns terminal, so the claim stays held for the run's whole life.
   */
  const startScheduled = async (
    claimed: {
      readonly squadId: string;
      readonly subject: Extract<SquadRunSubjectV1, { readonly kind: "schedule-occurrence" }>;
      readonly schedule: TrustedScheduleRuntime;
      readonly mission: string;
      readonly cwd: string;
    },
    binding: RuntimeBinding,
  ): Promise<JsonObject> => {
    if (
      readStates().some(
        (state) =>
          squadScheduleSubject(state)?.scheduleId === claimed.subject.scheduleId &&
          squadScheduleSubject(state)?.claimFence === claimed.subject.claimFence,
      )
    )
      throw cellCriterionError(
        "squad_run_active",
        `Schedule ${claimed.subject.scheduleId} occurrence ${claimed.subject.occurrenceId} already has Squad run.`,
        "run",
        "squad/occurrence-run-available",
      );
    const squad = squadForRun(claimed.squadId),
      squadRunId = `squad_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      leaderInstance = input.query((projection) => {
        const row = projection.getEntity("agent", squad.leader);
        return row === null ? null : (readProjectedAgentDeclaration(row.value).instance ?? null);
      }),
      state: SquadState = {
        schema: "squad-run/v1",
        squadRunId,
        stateDispatchId: null,
        squadId: claimed.squadId,
        subject: claimed.subject,
        scheduleRuntime: claimed.schedule,
        runtimeInstanceId: leaderInstance,
        cwd: claimed.cwd,
        baseSha: localGitObjectRefStore.headCommit(claimed.cwd),
        mission: claimed.mission,
        publicMission: claimed.mission,
        model: null,
        effort: null,
        // A detect schedule states its no-write boundary up front: the run's workers share the
        // occurrence cwd and refuse writes; remediate keeps the governed default.
        permissionMode: claimed.schedule.mode === "detect" ? "read-only" : null,
        leaderAgentId: squad.leader,
        roster: squad.roster,
        workers: squad.workers,
        leaderTurnBudget: squad.leaderTurnBudget,
        binding: {
          actor: binding.actor,
          source: binding.source,
        },
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
      const running = await spawnLeader(state, { kind: "initial" }),
        initialTurn = running.leaderTurns[0];
      return {
        outcome: "applied",
        opId: `squad-scheduled:${squadRunId}`,
        ...(initialTurn && running.currentLeaderRuntimeSessionId
          ? { dispatchId: initialTurn.dispatchId, runtimeSessionId: running.currentLeaderRuntimeSessionId }
          : {}),
        squadRunId,
        status: "leader_running",
        summary: `squad-run ${claimed.squadId}: ${squadRunId}`,
      };
    } catch (error) {
      const prepared = states.get(squadRunId);
      const failed = revise(prepared ?? state, { phase: "failed", error: errorText(error) });
      if (prepared?.stateDispatchId) await writeState(failed);
      throw cellCriterionError(errorCode(error, "squad_leader_failed"), failed.error!, "run", "squad/leader-dispatch", [
        `Inspect the runtime instance and leader Agent; the schedule occurrence settles failed.`,
      ]);
    }
  };

  const cancel = async (squadRunId: string, binding: RuntimeBinding): Promise<JsonObject> => {
    if (!validSquadRunId(squadRunId))
      throw cellCriterionError(
        "invalid_squad_run_id",
        "Use the squad_<24 lowercase hex characters> handle returned by ha squad run.",
        "cancel",
        "squad/run-id",
      );
    const state = readSquadRunState(squadRunId);
    if (!state) {
      const observed = input.query((projection) => projection.readSquadRun(squadRunId));
      if (observed)
        throw cellCriterionError(
          "execution_scope_mismatch",
          `Squad run ${squadRunId} has no control state on this node. Owner: ${JSON.stringify(observed.state.owner)}. Use its owner's authorized cancel entry.`,
          "cancel",
          "squad/run-owner",
        );
      throw cellCriterionError(
        "squad_run_not_found",
        `Squad run ${squadRunId} does not exist.`,
        "cancel",
        "squad/run-present",
      );
    }
    if (state.phase !== "cancelled")
      recordState(
        revise(state, {
          currentLeaderRuntimeSessionId: null,
          workerWaits: [],
          pendingLeaderTriggers: [],
          phase: "cancelled",
          error: null,
        }),
      );
    const runtimeSessionIds = [
      ...state.leaderTurns.map((turn) => turn.runtimeSessionId),
      ...state.workerAttempts.flatMap((attempt) => (attempt.runtimeSessionId ? [attempt.runtimeSessionId] : [])),
    ];
    const results = await Promise.allSettled(
      [...new Set(runtimeSessionIds)].map((runtimeSessionId) =>
        input.runtimeSpawner().cancel({ runtimeSessionId }, binding),
      ),
    );
    const [publicationResult] = await Promise.allSettled([publication.publishState(states.get(squadRunId)!)]);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0)
      throw cellCriterionError(
        "squad_cancel_incomplete",
        `Squad run ${squadRunId} recorded cancellation, but ${String(failures.length)} runtime cancellation(s) failed.` +
          (publicationResult?.status === "rejected"
            ? ` Canonical publication is unconfirmed: ${errorText(publicationResult.reason)}`
            : ""),
        "cancel",
        "squad/cancellation-complete",
        [`Retry ha squad cancel ${squadRunId}; already-cancelled runtimes are idempotent.`],
      );
    const retained = await reclaimWorkerCheckouts(state.cwd, state.workerAttempts);
    if (publicationResult?.status === "rejected") throw publicationResult.reason;
    return {
      squadRunId,
      status: "cancelled",
      summary: [`squad-run ${state.squadId}: cancelled`, ...retained].join("\n"),
    };
  };

  function squadForRun(squadId: string) {
    const entityStore = {
        get: (kind: string, id: string) => input.query((projection) => projection.getEntity(kind, id)),
      },
      stored = entityStore.get("squad", squadId);
    if (!stored)
      throw cellCriterionError(
        "squad_not_found",
        `${squadId} is not an installed squad.`,
        "run",
        "squad/entity-present",
        [`Run ha squad install --source <squad-package>, then retry ha squad run ${squadId}.`],
      );
    const squad = parseSquadDeclarationV1(stored.value),
      missing = [...new Set([squad.leader, ...squad.workers])]
        .map((agentId) => {
          // The store read itself throws invalid_entity_contract for a stored declaration the
          // current schema rejects; storedAgentDeclarationOutcome isolates both failure shapes.
          const outcome = storedAgentDeclarationOutcome({
            agentId,
            read: () => {
              const agent = entityStore.get("agent", agentId);
              return agent === null ? null : readProjectedAgentDeclaration(agent.value);
            },
          });
          if (outcome.kind === "ok") {
            if (outcome.value.lifecycleState !== "retired") return null;
            return {
              agentId,
              hint: `Agent ${agentId} is retired.${outcome.value.retirement?.successor ? ` Use agent/${outcome.value.retirement.successor} instead` : " Choose an active agent"}`,
            };
          }
          return {
            agentId,
            hint: outcome.kind === "invalid" ? outcome.error.message : `Install agent/${agentId}`,
          };
        })
        .filter((entry): entry is { readonly agentId: string; readonly hint: string } => entry !== null);
    if (missing.length)
      throw cellCriterionError(
        "squad_agent_not_found",
        `Squad ${squad.id} references unavailable agents: ${missing.map(({ agentId }) => agentId).join(", ")}.`,
        "run",
        "squad/member-declarations",
        missing.map(({ hint }) => `${hint}, then retry ha squad run ${squad.id}.`),
      );
    return squad;
  }

  const observeOutcome = async (event: RuntimeOutcomeEvent): Promise<void> => {
    await observeRuntimeSession(event.payload.runtimeSessionId);
  };

  const reconcile = async (): Promise<void> => {
    await publication.flushPublications();
    await publication.settleEndedScheduleSubjects();
    for (const candidate of readStates()) {
      if (terminal(candidate)) continue;
      if (!subjectCurrent(candidate)) continue;
      let state = readSquadRunState(candidate.squadRunId);
      if (!state || terminal(state)) continue;
      if (state.phase === "planning" && state.leaderTurns.length === 0 && !initialDispatches.has(state.squadRunId)) {
        await spawnLeader(state, { kind: "initial" });
        continue;
      }
      const currentLeader = state.currentLeaderRuntimeSessionId;
      if (currentLeader && terminalRow(state, currentLeader)) {
        await observeRuntimeSession(currentLeader);
        state = readSquadRunState(candidate.squadRunId);
        if (!state || terminal(state)) continue;
      }
      const lastTurn = state.leaderTurns.at(-1);
      if (!state.currentLeaderRuntimeSessionId && lastTurn?.decision?.kind === "plan")
        state = await dispatchPlan(state, lastTurn.decision, lastTurn.turnId);
      const discovered = discoverWorkerCallbacks(state);
      if (discovered !== state) {
        await writeState(discovered);
      }
      if (
        !discovered.currentLeaderRuntimeSessionId &&
        discovered.pendingLeaderTriggers.length &&
        !hasRunningWorkers(discovered)
      )
        await spawnPendingLeader(discovered);
    }
  };

  async function observeRuntimeSession(runtimeSessionId: string): Promise<void> {
    for (const candidate of readStates()) {
      if (terminal(candidate)) continue;
      if (!subjectCurrent(candidate)) continue;
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
    const updated = discoverWorkerCallbacks(
      revise(state, {
        observedWorkerRuntimeSessionIds: [...state.observedWorkerRuntimeSessionIds, runtimeSessionId],
        workerWaits: state.workerWaits.filter((candidate) => candidate.runtimeSessionId !== runtimeSessionId),
        pendingLeaderTriggers: [...state.pendingLeaderTriggers, trigger],
      }),
    );
    await writeState(updated);
    if (!updated.currentLeaderRuntimeSessionId && !hasRunningWorkers(updated)) await spawnPendingLeader(updated);
  }

  async function continueLeader(state: SquadState, runtimeSessionId: string): Promise<void> {
    const row = dispatchRows(state).find((dispatch) => dispatch.runtimeSessionId === runtimeSessionId),
      turn = state.leaderTurns.find((candidate) => candidate.runtimeSessionId === runtimeSessionId);
    if (!turn) return;
    if (row?.outcome === "cancelled") {
      await cancel(state.squadRunId, state.binding);
      return;
    }
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
      decision = parseLeaderDecision(resultText(row.resultRef), state.workers);
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
    await writeState(updated);

    if (decision.kind === "plan") updated = await dispatchPlan(updated, decision, turn.turnId);

    updated = discoverWorkerCallbacks(updated);
    await writeState(updated);
    if (updated.pendingLeaderTriggers.length && !hasRunningWorkers(updated)) {
      await spawnPendingLeader(updated);
      return;
    }
    const running = hasRunningWorkers(updated);
    if (decision.kind === "converged") {
      const task = squadTaskRef(updated);
      let error = running
        ? "Leader declared convergence while worker dispatches were still running."
        : convergenceError(updated, decision);
      if (error === null) {
        try {
          if (task) {
            await input.reacquireTaskLease(task.taskId, updated.binding, updated);
            await input.publishSynthesisReport(
              {
                taskId: task.taskId,
                squadRunId: updated.squadRunId,
                reportPath: synthesisReportPath(updated)!,
                body: decision.report!,
                leaderRuntimeSessionId: runtimeSessionId,
              },
              updated.binding,
            );
          }
          // A schedule-occurrence run keeps its synthesis in the converged turn's dispatch
          // result; an occurrence-owned artifact namespace is a pending owner ruling.
        } catch (cause) {
          consumeKnownError(cause);
          error = `Leader synthesis report publication failed: ${errorText(cause)}`;
        }
      }
      const ended = revise(updated, {
        phase: error ? "failed" : "converged",
        error,
      });
      await writeState(ended);
      await reclaimWorkerCheckouts(ended.cwd, ended.workerAttempts);
      return;
    }
    if (running) {
      await writeState(revise(updated, { phase: "workers_running", error: null }));
      return;
    }
    await retryLeader(updated, turn, "Leader returned no work and did not declare convergence.");
  }

  async function dispatchPlan(
    state: SquadState,
    decision: Extract<LeaderDecision, { readonly kind: "plan" }>,
    turnId: string,
  ): Promise<SquadState> {
    let updated = state;
    for (const plan of decision.dispatches) {
      const existing = updated.workerAttempts.find(
        (attempt) => attempt.leaderTurnId === turnId && attempt.workerId === plan.workerId,
      );
      if (existing?.runtimeSessionId || existing?.rejection) continue;
      const active = workerRows(updated).find(
        ({ attempt, row }) =>
          attempt.workerId === plan.workerId &&
          attempt.leaderTurnId !== turnId &&
          attempt.rejection === null &&
          (!row || row.outcome === null),
      );
      updated = active ? recordWorkerWait(updated, active.attempt) : await spawnWorker(updated, plan, turnId);
    }
    // A task subject hands the parent task back to its workers' independent child leases; a
    // schedule subject holds its occurrence claim until the run itself turns terminal.
    const task = squadTaskRef(updated);
    if (task) await input.releaseTaskLease(task.taskId, updated.binding, task.executionId, updated.squadRunId);
    return updated;
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
    await writeState(retrying);
    await spawnPendingLeader(retrying);
  }

  async function spawnWorker(state: SquadState, plan: WorkerPlan, leaderTurnId: string): Promise<SquadState> {
    const previous = state.workerAttempts.find(
        (attempt) => attempt.leaderTurnId === leaderTurnId && attempt.workerId === plan.workerId,
      ),
      attemptId = previous?.attemptId ?? `worker-${state.workerAttempts.length + 1}`;
    let attempt: WorkerAttempt = previous ?? {
      attemptId,
      workerId: plan.workerId,
      leaderTurnId,
      taskId: null,
      executionId: null,
      ownedPaths: plan.ownedPaths ?? [],
      ownershipCheck: null,
      dispatchId: null,
      runtimeSessionId: null,
      worktree: null,
      rejection: null,
    };
    const save = async (current: SquadState): Promise<SquadState> => {
      const updated = revise(current, {
        workerAttempts: [...current.workerAttempts.filter((row) => row.attemptId !== attemptId), attempt],
        phase: "workers_running",
      });
      await writeState(updated);
      return updated;
    };
    state = await save(state);
    try {
      for (const { attempt: other, row } of workerRows(state)) {
        if (other.attemptId === attemptId || other.rejection || row?.outcome) continue;
        const overlap = overlappingWorkerPaths(attempt.ownedPaths, other.ownedPaths);
        if (overlap) throw new Error(`Ownership conflict with ${other.taskId ?? other.attemptId}: ${overlap}`);
      }
      await admitRunSubject(state);
      const parentTask = squadTaskRef(state);
      const taskId = await input.createChildTask(
        {
          parentTaskId: parentTask?.taskId ?? null,
          squadRunId: state.squadRunId,
          key: `${state.squadRunId}:${leaderTurnId}:${attemptId}`,
          workerId: plan.workerId,
          prompt: plan.prompt,
          ownedPaths: attempt.ownedPaths,
        },
        state.binding,
      );
      attempt = { ...attempt, taskId };
      state = await save(state);
      const accepted = input
        .query((projection) =>
          readTaskDispatches({
            projection,
            rootDir: input.rootDir,
            taskId,
          }),
        )
        .dispatches.find((row) => row.agentId === plan.workerId);
      if (accepted) {
        attempt = {
          ...attempt,
          dispatchId: accepted.dispatchId,
          runtimeSessionId: accepted.runtimeSessionId,
          executionId: accepted.executionId,
        };
        return save(state);
      }
      const childLease = input.query((projection) => projection.read(taskId).snapshot).lease;
      // A previous dispatch can hand off its lease before recording its receipt. The spawner
      // validates the stable runtime identity; the coordinator must not reclaim that lease.
      if (childLease?.phase !== "held" || isSameExecution(childLease.actor, state.binding.actor))
        await input.reacquireTaskLease(taskId, state.binding, state);
      const executionId = input.query((projection) => projection.read(taskId).snapshot).lease?.executionId;
      if (!executionId) throw new Error(`Child ${taskId} has no execution lease.`);
      const worktree =
        state.permissionMode === "read-only"
          ? null
          : await prepareWorkerWorktree(
              state,
              // Stages share the Commander branch: a later worker starts from what earlier stages delivered there.
              attempt.worktree?.baseSha ?? localGitObjectRefStore.headCommit(state.cwd),
              plan.workerId,
              attemptId,
              { rootDir: input.rootDir, taskId, ...input.readWorktreeSetup() },
            );
      attempt = { ...attempt, worktree, executionId };
      state = await save(state);
      const receipt = await input.runtimeSpawner().spawn(
          {
            agentId: state.leaderAgentId,
            squadId: state.squadId,
            squadRun: state.stateDispatchId
              ? { squadRunId: state.squadRunId, ownerDispatchId: state.stateDispatchId, turnId: attemptId }
              : {
                  squadRunId: state.squadRunId,
                  squadId: state.squadId,
                  subject: state.subject,
                  mission: state.publicMission,
                  leaderAgentId: state.leaderAgentId,
                },
            targetAgentId: plan.workerId,
            prompt: workerPrompt(plan.prompt, worktree, attempt.ownedPaths),
            cwd: cwdPayload(input.rootDir, worktree?.cwd ?? state.cwd),
            taskId,
            ...(state.effort ? { effort: state.effort } : {}),
            ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
            dispatchKey: `${state.squadRunId}:${leaderTurnId}:${attemptId}`,
          },
          state.binding,
        ),
        dispatchId = requiredReceiptText(receipt, "dispatchId"),
        runtimeSessionId = requiredReceiptText(receipt, "runtimeSessionId"),
        completed = { ...attempt, dispatchId, runtimeSessionId };
      attempt = completed;
      return save(state);
    } catch (error) {
      const lease = attempt.taskId
        ? input.query((projection) => projection.read(attempt.taskId!).snapshot).lease
        : null;
      if (lease && isSameExecution(lease.actor, state.binding.actor))
        await input.releaseTaskLease(attempt.taskId!, state.binding, attempt.executionId!, state.squadRunId);
      attempt = { ...attempt, rejection: errorText(error) };
      const updated = revise(await save(state), {
        pendingLeaderTriggers: [...state.pendingLeaderTriggers, { kind: "worker_rejected", attemptId }],
      });
      await writeState(updated);
      return updated;
    }
  }

  /**
   * Settles assignment tasks of ended attempts before the next leader turn: each leader
   * callback drains the finished stage's worktable slots, so later stages and parallel
   * squads are not blocked by assignments this run will never run again. A settlement
   * failure is reported and retried on the next leader callback (the terminal-status
   * check keeps it idempotent); it must not stall the run's progression.
   */
  async function settleEndedAssignments(state: SquadState): Promise<void> {
    for (const { attempt, row } of workerRows(state)) {
      if (!attempt.taskId || (attempt.rejection === null && (row === undefined || row.outcome === null))) continue;
      const settled = input.query((projection) => projection.read(attempt.taskId!).snapshot.task?.status);
      if (settled !== undefined && isTerminalStatus(settled)) continue;
      try {
        await input.settleChildTask(
          {
            squadRunId: state.squadRunId,
            taskId: attempt.taskId,
            workerId: attempt.workerId,
            runtimeSessionId: attempt.runtimeSessionId,
            reason: `Squad ${state.squadRunId} ended attempt ${attempt.attemptId} for worker ${attempt.workerId}; assignment lifecycle belongs to this run.`,
          },
          state.binding,
        );
      } catch (error) {
        consumeKnownError(error);
        console.warn(
          `[squad] settling ended assignment ${attempt.taskId} failed: ${errorText(error)}; retrying on the next leader callback.`,
        );
      }
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
      if (state.leaderTurns.length >= state.leaderTurnBudget)
        throw new Error(`leader turn budget ${state.leaderTurnBudget} exhausted`);
      await admitRunSubject(state);
      const parentTask = squadTaskRef(state);
      for (const attempt of state.workerAttempts) {
        if (!attempt.worktree || !attempt.taskId || !attempt.executionId || attempt.ownershipCheck) continue;
        const check = await checkWorkerOwnership(attempt.worktree, attempt.ownedPaths);
        await input.recordOwnershipCheck(
          {
            parentTaskId: parentTask?.taskId ?? null,
            squadRunId: state.squadRunId,
            taskId: attempt.taskId,
            executionId: attempt.executionId,
            check,
          },
          state.binding,
        );
        state = revise(state, {
          workerAttempts: state.workerAttempts.map((row) =>
            row.attemptId === attempt.attemptId ? { ...row, ownershipCheck: check } : row,
          ),
        });
        await writeState(state);
      }
      await settleEndedAssignments(state);
      return await spawnLeader(state, trigger);
    } catch (error) {
      const failed = revise(state, {
        phase: "failed",
        currentLeaderRuntimeSessionId: null,
        error: errorText(error),
      });
      await writeState(failed);
      await reclaimWorkerCheckouts(failed.cwd, failed.workerAttempts);
      return failed;
    }
  }

  async function spawnLeader(state: SquadState, trigger: LeaderTrigger): Promise<SquadState> {
    const initial = trigger.kind === "initial" && state.leaderTurns.length === 0;
    if (initial) initialDispatches.add(state.squadRunId);
    try {
      input.query((projection) => requireSquadRunSubjectCurrent(projection, state.subject));
      if (trigger.kind !== "initial") await admitRunSubject(state);
      const scheduleRuntime = state.scheduleRuntime,
        drainedTriggers = trigger.kind === "initial" ? [] : state.pendingLeaderTriggers,
        turnId = `leader-${state.leaderTurns.length + 1}`,
        prompt =
          trigger.kind === "initial"
            ? initialLeaderPrompt(state)
            : callbackLeaderPrompt(state, drainedTriggers, dispatchRows(state), resultText),
        payload: JsonObject = {
          ...(state.runtimeInstanceId ? { runtimeInstanceId: state.runtimeInstanceId } : {}),
          agentId: state.leaderAgentId,
          squadId: state.squadId,
          squadRun:
            trigger.kind !== "initial" && state.stateDispatchId
              ? { squadRunId: state.squadRunId, ownerDispatchId: state.stateDispatchId, turnId }
              : {
                  squadRunId: state.squadRunId,
                  squadId: state.squadId,
                  subject: state.subject,
                  mission: state.publicMission,
                  leaderAgentId: state.leaderAgentId,
                },
          ...(state.permissionMode ? { permissionMode: state.permissionMode } : {}),
          prompt,
          cwd: cwdPayload(input.rootDir, state.cwd),
          ...(squadTaskRef(state) ? { taskId: squadTaskRef(state)!.taskId } : {}),
          ...(state.model ? { model: state.model } : {}),
          ...(state.effort ? { effort: state.effort } : {}),
          ...(trigger.kind !== "initial" && state.leaderProviderSessionId
            ? { providerSessionId: state.leaderProviderSessionId }
            : {}),
          dispatchKey:
            trigger.kind === "initial"
              ? `${state.squadRunId}:leader:initial`
              : `${state.squadRunId}:leader:${triggerKey(trigger)}`,
        },
        onPrepared =
          trigger.kind === "initial"
            ? (dispatchId: string) => {
                state = { ...state, stateDispatchId: dispatchId };
                recordState(state);
              }
            : undefined,
        receipt = scheduleRuntime
          ? await input.runtimeSpawner().spawnScheduled(payload, scheduleRuntime, state.binding, onPrepared)
          : await input.runtimeSpawner().spawn(payload, state.binding, onPrepared),
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
          pendingLeaderTriggers: trigger.kind === "initial" ? state.pendingLeaderTriggers : [],
          phase: "leader_running",
          error: null,
        });
      await writeState(updated);
      return updated;
    } finally {
      if (initial) initialDispatches.delete(state.squadRunId);
    }
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

  function readSquadRunState(id: string): SquadState | null {
    return states.get(id) ?? null;
  }
  function readStates(): readonly SquadState[] {
    return [...states.values()];
  }

  function recordState(state: SquadState): void {
    if (!state.stateDispatchId) throw new Error("Squad state has no owning dispatch stream.");
    states.set(state.squadRunId, state);
    appendRuntimeWorkerRecord(input.rootDir, state.stateDispatchId, {
      kind: "squad_run_state",
      squadRunId: state.squadRunId,
      revision: state.revision,
      state,
      observation: squadRunObservation(state),
    });
    if (state.phase === "cancelled")
      appendRuntimeWorkerRecord(input.rootDir, state.stateDispatchId, {
        kind: "squad_run_cancelled",
        squadRunId: state.squadRunId,
        revision: state.revision,
      });
  }
  async function writeState(state: SquadState): Promise<void> {
    recordState(state);
    await publication.publishState(state);
    if (terminal(state)) await publication.settleScheduleSubjectRun(state);
  }

  return { start, startScheduled, cancel, observeOutcome, reconcile, flushPublications: publication.flushPublications };
}
