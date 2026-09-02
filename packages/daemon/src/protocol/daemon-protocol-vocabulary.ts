import type {
  CredentialKind,
  DaemonRepoMode,
  PeopleCommandClass,
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
export const relationStateWords = ["active", "edge_retired", "deleted"] as const;
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

export const reviewVerdictWords = ["approved", "changes_requested", "dismissed"] as const;

export const receiptOutcomeWords = ["applied", "pending", "no_changes", "indeterminate", "op_rejected"] as const;

export const daemonRepoModeWords = Object.freeze([
  "local",
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

// The named use-case projections of dec_5B135F46 CH4, mirrored on the transport path. The kernel
// catalog (`use-case-projection-catalog.ts`) stays the authority for what a projection *means*;
// this is only the wire enum, and the bidirectional check below fails compilation the moment the
// two disagree — so the mirror cannot drift without the kernel type being changed to match.
export const useCaseProjectionNameWords = Object.freeze([
  "schedule-plane",
  "schedule-run-history",
  "runtime-session-groups",
] as const satisfies readonly UseCaseProjectionName[]);

export const useCaseProjectionNameWordsAreExact: [UseCaseProjectionName] extends [
  (typeof useCaseProjectionNameWords)[number],
]
  ? true
  : never = true;

export const useCaseProjectionFacetWords = Object.freeze(["plane", "runs", "groups"] as const);
