type RepoWritePhaseTransitionDefinition = {
  readonly parent: {
    readonly from: readonly (string | null)[];
    readonly to: string | null;
  };
  readonly child: {
    readonly from: readonly (string | null)[];
    readonly to: string | null;
  };
};

/**
 * The durable write protocol's one phase/transition authority.
 *
 * The parent and child observe different sides of the same transport event.
 * Keeping both projections in each row is intentional: it models the legal
 * window in which the child has prepared locally while the parent still has
 * only submitted knowledge.
 */
export const repoWritePhaseTransitions = {
  submit: {
    parent: { from: ["queued"], to: "submitted" },
    child: { from: [null], to: "preparing" }
  },
  prepared: {
    parent: { from: ["submitted"], to: "prepared" },
    child: { from: ["preparing"], to: "prepared" }
  },
  proceed: {
    parent: { from: ["prepared"], to: "proceeded" },
    child: { from: ["prepared"], to: "proceeding" }
  },
  terminal: {
    parent: { from: ["prepared", "proceeded"], to: null },
    child: { from: ["proceeding"], to: "terminal" }
  },
  "not-started": {
    parent: { from: ["submitted", "prepared", "proceeded"], to: null },
    child: { from: ["preparing", "prepared"], to: "failed" }
  },
  "outcome-unknown": {
    parent: { from: ["prepared", "proceeded"], to: null },
    child: { from: ["proceeding"], to: "unknown" }
  },
  "shutdown-before-proceed": {
    parent: { from: ["prepared", "proceeded"], to: null },
    child: { from: ["prepared"], to: "failed" }
  }
} as const satisfies Record<string, RepoWritePhaseTransitionDefinition>;

type RepoWritePhaseTransitionTable = typeof repoWritePhaseTransitions;

export type RepoWritePhaseTransitionName = keyof RepoWritePhaseTransitionTable;
export type RepoWritePhaseSide = keyof RepoWritePhaseTransitionTable["submit"];

type RepoWritePhaseTransitionSpec<
  Name extends RepoWritePhaseTransitionName,
  Side extends RepoWritePhaseSide
> = RepoWritePhaseTransitionTable[Name][Side];

export type RepoWritePhaseTransitionFrom<
  Side extends RepoWritePhaseSide,
  Name extends RepoWritePhaseTransitionName
> = RepoWritePhaseTransitionSpec<Name, Side>["from"][number];

export type RepoWritePhaseTransitionTo<
  Side extends RepoWritePhaseSide,
  Name extends RepoWritePhaseTransitionName
> = RepoWritePhaseTransitionSpec<Name, Side>["to"];

export type RepoWritePhaseFor<Side extends RepoWritePhaseSide> = Exclude<{
  [Name in RepoWritePhaseTransitionName]:
    | RepoWritePhaseTransitionSpec<Name, Side>["from"][number]
    | RepoWritePhaseTransitionSpec<Name, Side>["to"]
}[RepoWritePhaseTransitionName], null>;

export type RepoWriteParentPendingPhase = RepoWritePhaseFor<"parent">;
export type RepoWriteChildOperationPhase = RepoWritePhaseFor<"child">;

export function advanceRepoWritePhase<
  Side extends RepoWritePhaseSide,
  Name extends RepoWritePhaseTransitionName,
  From extends RepoWritePhaseTransitionFrom<Side, Name>
>(
  side: Side,
  transition: Name,
  from: From
): RepoWritePhaseTransitionTo<Side, Name>;
export function advanceRepoWritePhase(
  side: RepoWritePhaseSide,
  transition: RepoWritePhaseTransitionName,
  from: string | null
): string | null {
  const spec = repoWritePhaseTransitions[transition][side];
  if (!spec.from.includes(from as never)) {
    throw new Error(
      `Repo write ${side} phase cannot apply ${transition} from ${String(from)}`
    );
  }
  return spec.to;
}

// These type-only probes are deliberately kept beside the authority. If a
// transition is widened or a terminal outcome is accidentally reintroduced as
// a phase, typecheck fails here.
type RepoWriteAssertFalse<Value extends false> = Value;
type RepoWriteChildPreparationFromPrepared =
  "prepared" extends RepoWritePhaseTransitionFrom<"child", "prepared"> ? true : false;
type RepoWriteChildTerminalOutcomeIsPhase =
  "committed" extends RepoWriteChildOperationPhase ? true : false;
type _RepoWriteChildPreparationMustStartLocally =
  RepoWriteAssertFalse<RepoWriteChildPreparationFromPrepared>;
type _RepoWriteTerminalOutcomeMustStaySeparate =
  RepoWriteAssertFalse<RepoWriteChildTerminalOutcomeIsPhase>;
