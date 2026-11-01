import { randomUUID } from "node:crypto";
import { readNodeAutoClaimPolicy, type NodeAutoClaimPolicy } from "./node-auto-claim-config.ts";

export type NodeAutoClaimReason =
  | "disabled"
  | "source_not_allowed"
  | "expired"
  | "agent_not_allowed"
  | "concurrency_limit"
  | "assignment_missing"
  | "accepted";

export interface NodeAutoClaimAssignment {
  readonly taskId: string;
  readonly expiresAt: string;
  readonly assignedByPersonId: string | null;
  readonly assignedByTeamIds: readonly string[];
}

export interface NodeAutoClaimDecision {
  readonly accepted: boolean;
  readonly reason: NodeAutoClaimReason;
}

export function decideNodeAutoClaim(input: {
  readonly policy: NodeAutoClaimPolicy;
  readonly assignment: NodeAutoClaimAssignment | null;
  readonly ownerPersonId: string;
  readonly now: string;
  readonly agentId: string;
  readonly activeCount: number;
}): NodeAutoClaimDecision {
  const { policy, assignment } = input;
  if (!policy.enabled) return { accepted: false, reason: "disabled" };
  if (assignment === null) return { accepted: false, reason: "assignment_missing" };
  const expiry = Date.parse(assignment.expiresAt),
    now = Date.parse(input.now);
  if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) return { accepted: false, reason: "expired" };
  if (input.activeCount >= policy.maxConcurrent) return { accepted: false, reason: "concurrency_limit" };
  if (!policy.allowedAgentIds.includes(input.agentId)) return { accepted: false, reason: "agent_not_allowed" };
  const sameOwner = assignment.assignedByPersonId === input.ownerPersonId,
    sourceAllowed =
      sameOwner ||
      (assignment.assignedByPersonId !== null &&
        policy.allowedSources.personIds.includes(assignment.assignedByPersonId)) ||
      assignment.assignedByTeamIds.some((teamId) => policy.allowedSources.teamIds.includes(teamId));
  return sourceAllowed ? { accepted: true, reason: "accepted" } : { accepted: false, reason: "source_not_allowed" };
}

export interface NodeAutoClaimLoop {
  readonly trigger: (reason: string) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly diagnostics: () => readonly NodeAutoClaimDiagnosticRow[];
}

export interface NodeAutoClaimDiagnosticRow {
  readonly repoId: string;
  readonly taskId: string | null;
  readonly reason: NodeAutoClaimReason | "config_invalid" | "authentication_required" | "claim_failed";
  readonly detail: string;
  readonly observedAt: string;
  readonly assignedByPersonId?: string;
  readonly agentId?: string;
}

export interface NodeAutoClaimLoopInput<TRepo, TCandidate> {
  readonly userRoot: string;
  readonly now: () => string;
  readonly ownerPersonIdFor: (repo: TRepo) => Promise<string | null>;
  readonly repos: () => readonly TRepo[];
  readonly repoIdOf: (repo: TRepo) => string;
  readonly candidates: (repo: TRepo) => Promise<readonly TCandidate[]>;
  readonly taskIdOf: (candidate: TCandidate) => string;
  readonly assignmentOf: (candidate: TCandidate) => Promise<NodeAutoClaimAssignment | null>;
  readonly activeTaskKeys: () => Promise<readonly string[]>;
  readonly agentIds: (repo: TRepo, policy: NodeAutoClaimPolicy) => readonly string[];
  readonly claimAndRun: (
    repo: TRepo,
    candidate: TCandidate,
    agentId: string,
    dispatchKey: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly onDiagnostic?: (row: NodeAutoClaimDiagnosticRow) => void;
}

export function openNodeAutoClaimLoop<TRepo, TCandidate>(
  input: NodeAutoClaimLoopInput<TRepo, TCandidate>,
): NodeAutoClaimLoop {
  const rows: NodeAutoClaimDiagnosticRow[] = [],
    controllers = new Set<AbortController>(),
    runs = new Set<Promise<void>>(),
    inFlight = new Set<string>(),
    settled = new Set<string>();
  let closed = false,
    pending: Promise<void> | null = null,
    queuedReason: string | null = null;
  const record = (row: NodeAutoClaimDiagnosticRow): void => {
    rows.push(row);
    if (rows.length > 200) rows.splice(0, rows.length - 200);
    input.onDiagnostic?.(row);
  };
  const scan = async (_reason: string): Promise<void> => {
    const configured = readNodeAutoClaimPolicy(input.userRoot);
    let slots: number;
    try {
      slots = new Set([...(await input.activeTaskKeys()), ...inFlight]).size;
    } catch (error) {
      record({
        repoId: "*",
        taskId: null,
        reason: "claim_failed",
        detail: error instanceof Error ? error.message : String(error),
        observedAt: input.now(),
      });
      throw error;
    }
    for (const repo of input.repos()) {
      if (closed) return;
      const repoId = input.repoIdOf(repo);
      if (configured.diagnostic === "invalid_json" || configured.diagnostic === "invalid_policy") {
        record({
          repoId,
          taskId: null,
          reason: "config_invalid",
          detail: configured.error ?? configured.diagnostic,
          observedAt: input.now(),
        });
        continue;
      }
      const policy = configured.policy;
      let ownerPersonId: string | null;
      try {
        ownerPersonId = await input.ownerPersonIdFor(repo);
      } catch (error) {
        record({
          repoId,
          taskId: null,
          reason:
            error instanceof Error && error.message.includes("authentication_required")
              ? "authentication_required"
              : "claim_failed",
          detail: error instanceof Error ? error.message : String(error),
          observedAt: input.now(),
        });
        throw error;
      }
      if (!policy.enabled || ownerPersonId === null) {
        record({
          repoId,
          taskId: null,
          reason: policy.enabled ? "source_not_allowed" : "disabled",
          detail: policy.enabled ? "node owner is unavailable" : "policy disabled",
          observedAt: input.now(),
        });
        continue;
      }
      let candidates: readonly TCandidate[];
      try {
        candidates = await input.candidates(repo);
      } catch (error) {
        record({
          repoId,
          taskId: null,
          reason:
            error instanceof Error && error.message.includes("authentication_required")
              ? "authentication_required"
              : "claim_failed",
          detail: error instanceof Error ? error.message : String(error),
          observedAt: input.now(),
        });
        throw error;
      }
      const agents = input.agentIds(repo, policy);
      for (const candidate of candidates) {
        const taskId = input.taskIdOf(candidate),
          activeTaskKey = `${repoId}:${taskId}`,
          agentId = agents[0];
        if (settled.has(activeTaskKey)) continue;
        if (inFlight.has(activeTaskKey)) {
          record({
            repoId,
            taskId,
            reason: "concurrency_limit",
            detail: "task is already being auto-claimed",
            observedAt: input.now(),
          });
          continue;
        }
        let assignment: NodeAutoClaimAssignment | null;
        try {
          assignment = await input.assignmentOf(candidate);
        } catch (error) {
          record({
            repoId,
            taskId,
            reason: "claim_failed",
            detail: error instanceof Error ? error.message : String(error),
            observedAt: input.now(),
          });
          throw error;
        }
        if (!agentId) {
          record({
            repoId,
            taskId,
            reason: "agent_not_allowed",
            detail: "no allowed local Agent",
            observedAt: input.now(),
          });
          continue;
        }
        const decision = decideNodeAutoClaim({
          policy,
          assignment,
          ownerPersonId,
          now: input.now(),
          agentId,
          activeCount: slots,
        });
        if (!decision.accepted) {
          record({
            repoId,
            taskId,
            reason: decision.reason,
            detail: decision.reason,
            observedAt: input.now(),
            ...(assignment?.assignedByPersonId ? { assignedByPersonId: assignment.assignedByPersonId } : {}),
          });
          continue;
        }
        record({
          repoId,
          taskId,
          reason: "accepted",
          detail: `starting with Agent ${agentId}`,
          observedAt: input.now(),
          ...(assignment?.assignedByPersonId ? { assignedByPersonId: assignment.assignedByPersonId } : {}),
          agentId,
        });
        slots += 1;
        inFlight.add(activeTaskKey);
        const controller = new AbortController();
        controllers.add(controller);
        let completed = false;
        const run = input
          .claimAndRun(
            repo,
            candidate,
            agentId,
            `node-auto-claim:${repoId}:${taskId}:${randomUUID()}`,
            controller.signal,
          )
          .then(
            () => {
              completed = true;
            },
            (error: unknown) => {
              if (controller.signal.aborted) return;
              record({
                repoId,
                taskId,
                reason: "claim_failed",
                detail: error instanceof Error ? error.message : String(error),
                observedAt: input.now(),
              });
            },
          )
          .finally(() => {
            controllers.delete(controller);
            inFlight.delete(activeTaskKey);
            runs.delete(run);
            if (completed) settled.add(activeTaskKey);
            void trigger("runtime-settled").catch((error: unknown) => {
              record({
                repoId,
                taskId,
                reason: "claim_failed",
                detail: error instanceof Error ? error.message : String(error),
                observedAt: input.now(),
              });
            });
          });
        runs.add(run);
      }
    }
  };
  const trigger = (reason: string): Promise<void> => {
    if (closed) return Promise.resolve();
    if (reason !== "runtime-settled") settled.clear();
    if (pending) {
      queuedReason = reason;
      return pending;
    }
    pending = (async () => {
      let nextReason: string | null = reason;
      while (!closed && nextReason !== null) {
        queuedReason = null;
        await scan(nextReason);
        nextReason = queuedReason;
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
  const close = async (): Promise<void> => {
    closed = true;
    for (const controller of controllers) controller.abort();
    await pending;
    await Promise.allSettled([...runs]);
  };
  return { trigger, close, diagnostics: () => rows };
}
