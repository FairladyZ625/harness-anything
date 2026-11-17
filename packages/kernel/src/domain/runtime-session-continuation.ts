/**
 * Identity-fenced selective session continuation contract (`dec_E0CB793DAA21F49FF1E98D5067`).
 *
 * Provider session `--resume` inheritance is keyed by `(employeeId, taskId, dispatchLineage)`:
 * - Same employee + clean prior terminal + resumable provider session => `"continue"` (`--resume`).
 * - Employee identity changed => `"handoff"` (never inherit raw `providerSessionId`; require `HandoffPacketV1`).
 * - Unclean prior terminal (`cancelled` / `stalled` / `unreachable`), lineage mismatch, or non-resumable runtime => `"fresh"`.
 */

export type RuntimeContinuationMode = "continue" | "fresh" | "handoff";

export type PriorTerminalDispositionKind =
  | "awaiting_ruling"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "stalled"
  | "unreachable"
  | "none";

export interface SessionContinuationInput {
  readonly requestedAgentId: string | null;
  readonly previousAgentId: string | null;
  readonly taskId: string | null;
  readonly previousTaskId: string | null;
  readonly lineageMatches: boolean;
  readonly providerSessionId: string | null;
  readonly runtimeSupportsResume: boolean;
  readonly previousTerminalKind: PriorTerminalDispositionKind;
  readonly hasHandoffPacket: boolean;
}

export interface SessionContinuationDecision {
  readonly mode: RuntimeContinuationMode;
  readonly allowProviderResume: boolean;
  readonly blockedWithoutHandoff: boolean;
  readonly reason:
    | "same_employee_clean_continuation"
    | "employee_switched_with_handoff"
    | "employee_switched_requires_handoff_packet"
    | "lineage_mismatch"
    | "unclean_prior_terminal"
    | "provider_resume_unavailable";
}

/** Decide whether a continuation may reuse `--resume <providerSessionId>`, must cold-start, or requires handoff. */
export function resolveSessionContinuationMode(input: SessionContinuationInput): SessionContinuationDecision {
  if (
    input.requestedAgentId !== null &&
    input.previousAgentId !== null &&
    input.requestedAgentId !== input.previousAgentId
  )
    return {
      mode: "handoff",
      allowProviderResume: false,
      blockedWithoutHandoff: !input.hasHandoffPacket,
      reason: input.hasHandoffPacket ? "employee_switched_with_handoff" : "employee_switched_requires_handoff_packet",
    };

  if (input.taskId !== input.previousTaskId || !input.lineageMatches)
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "lineage_mismatch",
    };

  if (
    input.previousTerminalKind === "cancelled" ||
    input.previousTerminalKind === "stalled" ||
    input.previousTerminalKind === "unreachable"
  )
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "unclean_prior_terminal",
    };

  if (!input.providerSessionId || !input.runtimeSupportsResume)
    return {
      mode: "fresh",
      allowProviderResume: false,
      blockedWithoutHandoff: false,
      reason: "provider_resume_unavailable",
    };

  return {
    mode: "continue",
    allowProviderResume: true,
    blockedWithoutHandoff: false,
    reason: "same_employee_clean_continuation",
  };
}
