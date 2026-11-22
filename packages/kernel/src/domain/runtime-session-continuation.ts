/**
 * Unattended session-continuation fence (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1; RJ2).
 *
 * The fence governs only automatic wakeups (Inbox, Schedule). Explicit operator recovery
 * (`--resume`, `--resume-dispatch`, `--recover-dispatch`), provider-fallback and fresh dispatches keep
 * their existing contracts: the fence answers `governed: false` for them and decides nothing.
 *
 * For an unattended wakeup, provider `--resume` inheritance is keyed by `(agentId, taskId, dispatchLineage)`:
 * - the prior attempt has no physical stop proof          => refuse (single-executor worktree fence, CH2);
 * - the employee changed                                  => `handoff` (never inherit a provider session);
 * - lineage mismatch or an unclean / absent prior turn    => `fresh` cold start (never resume a dead session);
 * - otherwise, when the runtime can resume the session    => `continue`.
 */

export const sessionLaunchOrigins = [
  "unattended_inbox_wakeup",
  "unattended_schedule",
  "manual_resume",
  "manual_recover_dispatch",
  "provider_fallback",
  "fresh_dispatch",
] as const;
export type SessionLaunchOrigin = (typeof sessionLaunchOrigins)[number];
export const unattendedLaunchOrigins = ["unattended_inbox_wakeup", "unattended_schedule"] as const;
export type UnattendedLaunchOrigin = (typeof unattendedLaunchOrigins)[number];

export type RuntimeContinuationMode = "continue" | "fresh" | "handoff";
export type PriorAttemptStopProof = "proven_stopped" | "unproven" | "none";
/** Only a completed turn or a turn parked on a ruling is a clean point to resume from. */
export type PriorTerminalKind =
  | "completed_turn"
  | "awaiting_ruling"
  | "failed"
  | "cancelled"
  | "stalled"
  | "unreachable"
  | "none";

export interface SessionContinuationFenceInput {
  readonly origin: SessionLaunchOrigin;
  readonly requestedAgentId: string | null;
  readonly previousAgentId: string | null;
  readonly taskId: string | null;
  readonly previousTaskId: string | null;
  readonly dispatchLineageMatches: boolean;
  readonly providerSessionId: string | null;
  readonly runtimeSupportsResume: boolean;
  readonly priorStopProof: PriorAttemptStopProof;
  readonly priorTerminalKind: PriorTerminalKind;
  readonly hasHandoffPacket: boolean;
}

export type SessionContinuationFenceVerdict =
  | { readonly governed: false; readonly origin: SessionLaunchOrigin }
  | {
      readonly governed: true;
      readonly origin: UnattendedLaunchOrigin;
      readonly mode: RuntimeContinuationMode;
      readonly allowProviderResume: boolean;
      readonly reason:
        | "same_employee_clean_continuation"
        | "employee_switched_with_handoff"
        | "lineage_mismatch"
        | "unclean_prior_terminal"
        | "no_prior_session"
        | "provider_resume_unavailable";
    };

export type SessionContinuationFenceCode = "unattended_prior_stop_unproven" | "unattended_handoff_packet_missing";

export class SessionContinuationFenceError extends Error {
  override name = "SessionContinuationFenceError";
  readonly code: SessionContinuationFenceCode;
  constructor(code: SessionContinuationFenceCode) {
    super(
      code === "unattended_prior_stop_unproven"
        ? "unattended wakeup refused: the prior attempt has no proven_stopped proof"
        : "unattended wakeup refused: the employee changed and no handoff packet exists",
    );
    this.code = code;
  }
}

export function isUnattendedLaunchOrigin(origin: SessionLaunchOrigin): origin is UnattendedLaunchOrigin {
  return (unattendedLaunchOrigins as readonly string[]).includes(origin);
}

/** Decide how an unattended wakeup may continue; throws {@link SessionContinuationFenceError} when it may not start. */
export function assertSessionContinuationFence(input: SessionContinuationFenceInput): SessionContinuationFenceVerdict {
  const origin = input.origin;
  if (!isUnattendedLaunchOrigin(origin)) return { governed: false, origin };
  if (input.priorStopProof === "unproven") throw new SessionContinuationFenceError("unattended_prior_stop_unproven");
  const verdict = (
    mode: RuntimeContinuationMode,
    reason: Extract<SessionContinuationFenceVerdict, { governed: true }>["reason"],
  ): SessionContinuationFenceVerdict => ({
    governed: true,
    origin,
    mode,
    allowProviderResume: mode === "continue",
    reason,
  });
  if (
    input.requestedAgentId !== null &&
    input.previousAgentId !== null &&
    input.requestedAgentId !== input.previousAgentId
  ) {
    if (!input.hasHandoffPacket) throw new SessionContinuationFenceError("unattended_handoff_packet_missing");
    return verdict("handoff", "employee_switched_with_handoff");
  }
  if (input.taskId !== input.previousTaskId || !input.dispatchLineageMatches)
    return verdict("fresh", "lineage_mismatch");
  if (input.priorTerminalKind === "none") return verdict("fresh", "no_prior_session");
  if (input.priorTerminalKind !== "completed_turn" && input.priorTerminalKind !== "awaiting_ruling")
    return verdict("fresh", "unclean_prior_terminal");
  if (input.providerSessionId === null || !input.runtimeSupportsResume)
    return verdict("fresh", "provider_resume_unavailable");
  return verdict("continue", "same_employee_clean_continuation");
}
