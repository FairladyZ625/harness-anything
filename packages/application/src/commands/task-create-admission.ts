import type { TaskProjection } from "@harness-anything/kernel";
import type { CommandAction, CommandOperationPort } from "./command-ports.ts";

/** The decision, identity and profile rules a task create must satisfy before its package compiles.
 *  Package compilation stays with the host that owns preset assets; these rules read only the action
 *  and the decision projection. */
export interface TaskCreateAdmissionCell extends Pick<CommandOperationPort, "cellCodedError"> {
  readonly projection: Pick<TaskProjection, "readDecision">;
}

/** The compiled package fields the risk-tier profile rule inspects. */
export interface TaskCreateProfileCandidate {
  readonly lightweightPresetIds: readonly string[];
  readonly defaultNonLightweightProfileId: string | null;
  readonly snapshot: { readonly identity: { readonly id: string }; readonly profile: { readonly id: string } };
}

const importModes = ["migration", "import"];

function isImportCreateMode(action: CommandAction): boolean {
  return importModes.includes(String(action.createMode ?? ""));
}

/** Compiles with the caller's profile, then recompiles once when the risk tier selects another one:
 *  low risk takes the preset's lightweight profile, medium and high never stay on it. */
export function selectTaskCreateProfile<Compiled extends TaskCreateProfileCandidate>(
  cell: TaskCreateAdmissionCell,
  action: CommandAction,
  compile: (profileId?: string) => Compiled,
): Compiled {
  const compiled = compile();
  if (action.profileId !== undefined) return compiled;
  if (
    action.riskTier === "low" &&
    // The lightweight plan template is deliberately three sections, so it cannot carry the
    // Recurrence Gate a fix task owes. Keep low-risk fixes on the baseline profile.
    action.workKind !== "fix" &&
    compiled.lightweightPresetIds.includes(compiled.snapshot.identity.id) &&
    compiled.snapshot.profile.id !== "lightweight"
  )
    return compile("lightweight");
  if (action.riskTier !== "low" && compiled.snapshot.profile.id === "lightweight") {
    const profileId = compiled.defaultNonLightweightProfileId;
    if (profileId === null)
      throw cell.cellCodedError(
        "invalid_field",
        `Preset ${compiled.snapshot.identity.id} declares only the lightweight profile; medium and high tasks require a non-lightweight default profile.`,
      );
    return compile(profileId);
  }
  return compiled;
}

export function taskDecisionTarget(cell: TaskCreateAdmissionCell, action: CommandAction): string | null {
  const decisionRef = action.decisionRef;
  if (decisionRef === undefined || decisionRef === null || decisionRef === "") {
    if (action.taskClass === "work" && !isImportCreateMode(action))
      throw cell.cellCodedError(
        "decision_required",
        'Work requires an in_effect Decision. Run ha decision list; if none fits, run ha decision propose --help, then accept the selected Decision with ha decision accept <decision-id> --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision <decision-id>.',
      );
    return null;
  }
  if (typeof decisionRef !== "string" || !/^dec_[A-Za-z0-9_-]+(?:\/CH[1-9][0-9]*)?$/u.test(decisionRef))
    throw cell.cellCodedError("invalid_field", "--decision must be <decision-id>[/CH<n>], for example dec_.../CH1.");
  const [decisionId, clauseId = "CH1"] = decisionRef.split("/"),
    decision = cell.projection.readDecision(decisionId!).decision;
  if (decision === null)
    throw cell.cellCodedError(
      "decision_not_found",
      `Decision ${decisionId} does not exist. Run ha decision list; if none fits, run ha decision propose --help, then accept the selected Decision with ha decision accept <decision-id> --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision <decision-id>.`,
    );
  if (decision.state !== "in_effect")
    throw cell.cellCodedError(
      "decision_not_in_effect",
      `Decision ${decisionId} is ${decision.state}. Run ha decision list; if it is the selected direction, accept it with ha decision accept ${decisionId} --rationale "<reason>" --judgment-only "<judgment>"; retry with ha work create --title "<name>" --decision ${decisionId}.`,
    );
  if (!decision.chosen.some(({ id }) => id === clauseId))
    throw cell.cellCodedError(
      "decision_clause_not_found",
      `Decision ${decisionId} has no chosen clause ${clauseId}; use a clause shown by ha decision show ${decisionId}.`,
    );
  return `decision/${decisionId}/${clauseId}`;
}
