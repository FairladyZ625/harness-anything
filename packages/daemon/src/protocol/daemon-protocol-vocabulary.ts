import type {
  CredentialKind,
  DaemonRepoMode,
  PeopleCommandClass,
  TaskBoardColumnId,
  TaskCapabilityId,
  TaskCapabilityReason,
  UseCaseProjectionName,
} from "../../../kernel/src/index.ts";

// daemon-status-vocabulary:generated:start
export const taskStatusWords = ["planned", "active", "blocked", "in_review", "done", "cancelled"] as const;

export const decisionStateWords = [
  "proposed",
  "in_effect",
  "rejected",
  "deferred",
  "superseded",
  "outcome_retired",
] as const;

export const factLivenessWords = ["standing", "superseded_fact"] as const;

// daemon-status-vocabulary:generated:end

export const executionV1StateWords = ["active", "submitted", "changes_requested", "accepted"] as const;

export const executionStateWords = ["active", "submitted", "changes_requested", "accepted", "abandoned"] as const;

export const leasePhaseWords = ["reserving", "held", "orphaned", "released"] as const;

/** Wire copies of the Relation vocabulary; the status-vocabulary ratchet pins them to the kernel authority. */
export const relationStateWords = ["active", "retired"] as const;
export const relationFreshnessWords = ["current", "suspect", "orphaned"] as const;
export const relationTypeWords = [
  "supports",
  "supersedes",
  "refines",
  "narrows",
  "derives",
  "blocks",
  "relates",
  "implements",
  "depends-on",
  "produces",
  "evidences",
  "evidenced-by",
  "refuted-by",
  "invalidated-by",
  "supersedes-fact",
  "executes",
  "reviews",
  "owns",
  "dispatches",
  "authorizes",
] as const;
export const relationStrengthWords = ["strong", "weak"] as const;
export const relationDirectionWords = ["directed", "undirected"] as const;
export const relationOriginWords = ["declared", "imported_snapshot", "generated", "inferred"] as const;

export const packageDispositionWords = ["active", "archived", "tombstoned"] as const;

// The `task-board-rows` projection's wire mirrors. Same bidirectional check as the other mirrors
// below: the kernel judgment stays the authority for what a column or a rejection reason means,
// and a mirror that stops matching it fails compilation instead of drifting onto the wire.
export const taskBoardColumnWords = Object.freeze([
  "open",
  "blocked",
  "in_review",
  "terminal",
] as const satisfies readonly TaskBoardColumnId[]);

export const taskBoardColumnWordsAreExact: [TaskBoardColumnId] extends [(typeof taskBoardColumnWords)[number]]
  ? true
  : never = true;

export const taskCapabilityIdWords = Object.freeze([
  "start",
  "progress",
  "submit",
  "review",
  "complete",
] as const satisfies readonly TaskCapabilityId[]);

export const taskCapabilityIdWordsAreExact: [TaskCapabilityId] extends [(typeof taskCapabilityIdWords)[number]]
  ? true
  : never = true;

export const taskCapabilityReasonWords = Object.freeze([
  "invalid_disposition",
  "invalid_transition",
  "lease_required",
  "lease_conflict",
  "completion_blocked",
  "blocked",
  "unknown",
] as const satisfies readonly TaskCapabilityReason[]);

export const taskCapabilityReasonWordsAreExact: [TaskCapabilityReason] extends [
  (typeof taskCapabilityReasonWords)[number],
]
  ? true
  : never = true;

export const reviewVerdictWords = ["approved", "changes_requested", "dismissed"] as const;

export const receiptOutcomeWords = ["applied", "pending", "no_changes", "indeterminate", "op_rejected"] as const;

export const daemonRepoModeWords = Object.freeze([
  "local",
  "remote-proxy",
  "remote-center",
  "remote-edge",
] as const satisfies readonly DaemonRepoMode[]);

export const daemonRepoModeWordsAreExact: [DaemonRepoMode] extends [(typeof daemonRepoModeWords)[number]]
  ? true
  : never = true;

// Transport vocabulary mirrors stay dependency-free on the thin CLI path. The
// bidirectional type checks keep the kernel's people registry types authoritative
// without loading its runtime barrel (and Effect) in dependency-free contract jobs.
export const peopleCommandClassWords = Object.freeze([
  "admin",
  "repo-write",
  "repo-read",
  "arbiter",
] as const satisfies readonly PeopleCommandClass[]);

export const peopleCommandClassWordsAreExact: [PeopleCommandClass] extends [(typeof peopleCommandClassWords)[number]]
  ? true
  : never = true;

export const credentialKindWords = Object.freeze([
  "unix-socket-owner-boundary",
  "windows-named-pipe-client",
  "ssh-username",
  "ssh-forced-command-person",
  "ssh-tunnel-token-subject",
  "email-address",
  "password-account",
  "oauth-subject",
  "api-token",
] as const satisfies readonly CredentialKind[]);

export const credentialKindWordsAreExact: [CredentialKind] extends [(typeof credentialKindWords)[number]]
  ? true
  : never = true;

// The use-case projections of dec_5B135F46 CH4 that `repo.projection.read` serves by name. The
// kernel catalog (`use-case-projection-catalog.ts`) stays the authority for what a projection
// *means*; this is only the wire selector, and the checks below fail compilation the moment it
// names something the catalog does not, or the catalog gains a name with no delivery channel.
export const useCaseProjectionNameWords = Object.freeze([
  "schedule-plane",
  "schedule-run-history",
  "runtime-session-groups",
] as const satisfies readonly UseCaseProjectionName[]);

/**
 * Catalog projections whose fields ride on an existing read's rows instead of `repo.projection.read`
 * — `task-board-rows` is carried by `repo.tasks.list`, which is why it has no selector above. Which
 * read carries a projection is transport truth, so it is declared here and not in the kernel catalog.
 */
export const rowDeliveredUseCaseProjections = Object.freeze({
  "task-board-rows": "repo.tasks.list",
} as const satisfies Readonly<Record<string, string>>);

/**
 * Every catalog projection has exactly one delivery channel: a `repo.projection.read` selector above
 * or a row-delivering read. Adding a name to the kernel catalog without choosing one fails here.
 */
export const useCaseProjectionDeliveryIsTotal: [UseCaseProjectionName] extends [
  (typeof useCaseProjectionNameWords)[number] | keyof typeof rowDeliveredUseCaseProjections,
]
  ? true
  : never = true;

export const useCaseProjectionNameWordsAreServed: [(typeof useCaseProjectionNameWords)[number]] extends [
  UseCaseProjectionName,
]
  ? true
  : never = true;

export const useCaseProjectionFacetWords = Object.freeze(["plane", "runs", "groups"] as const);
