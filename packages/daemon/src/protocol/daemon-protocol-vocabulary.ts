import type {
  BlockingLabel,
  CredentialKind,
  DaemonRepoMode,
  DecisionCapabilityId,
  DecisionCapabilityReason,
  MaterializationState,
  PeopleCommandClass,
  TaskBoardColumnId,
  TaskCapabilityId,
  TaskCapabilityReason,
  TaskPhaseReason,
  UseCaseProjectionName,
  taskPhaseSteps,
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

/** Wire mirror of the kernel WAL-to-Git materialization health vocabulary. */
export const materializationStateWords = Object.freeze([
  "ok",
  "retrying",
  "failed",
] as const satisfies readonly MaterializationState[]);
export const materializationStateWordsAreExact: [MaterializationState] extends [
  (typeof materializationStateWords)[number],
]
  ? true
  : never = true;

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

export const taskPhaseReasonWords = Object.freeze([
  "blocked_overlay",
  "terminal_cancelled",
  "phase_unresolved",
] as const satisfies readonly TaskPhaseReason[]);

export const taskPhaseReasonWordsAreExact: [TaskPhaseReason] extends [(typeof taskPhaseReasonWords)[number]]
  ? true
  : never = true;

export const taskPhaseStepWords = Object.freeze([
  "planned",
  "active",
  "in_review",
  "done",
] as const satisfies typeof taskPhaseSteps);

export const taskPhaseStepWordsAreExact: [typeof taskPhaseSteps] extends [typeof taskPhaseStepWords] ? true : never =
  true;

export const blockingLabelWords = Object.freeze([
  "relations",
  "cycle",
  "unresolved",
  "none",
] as const satisfies readonly BlockingLabel[]);

export const blockingLabelWordsAreExact: [BlockingLabel] extends [(typeof blockingLabelWords)[number]] ? true : never =
  true;

export const decisionCapabilityIdWords = Object.freeze([
  "accept",
  "reject",
  "defer",
  "supersede",
  "retire",
] as const satisfies readonly DecisionCapabilityId[]);

export const decisionCapabilityIdWordsAreExact: [DecisionCapabilityId] extends [
  (typeof decisionCapabilityIdWords)[number],
]
  ? true
  : never = true;

export const decisionCapabilityReasonWords = Object.freeze([
  "invalid_transition",
] as const satisfies readonly DecisionCapabilityReason[]);

export const decisionCapabilityReasonWordsAreExact: [DecisionCapabilityReason] extends [
  (typeof decisionCapabilityReasonWords)[number],
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
  "decision-pool-rows": "repo.decisions.list:full",
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

/** Schedule interval 时长词表(唯一实现)。毫秒 ↔ `90s`/`5m`/`2h`/`1d` 的解析与格式化在这里各只有
 * 一份:CLI 的 `--every`、daemon 读侧的 trigger summary、GUI 表单的时长控件都从这里取,三方不再
 * 各带一张单位表。词表决定 `nextRunAt`(kernel schedule.ts),所以口径分歧会直接变成不同节点算出
 * 的 due 时刻不同;要求因此不是"看起来一致"而是同一份实现 + format→parse 无损可逆。
 *
 * 住在协议词表文件里而不是自成一个模块,是三方可达性算出来的唯一交集:thin CLI 的 dist 静态图只
 * 认 `tools/check-cli-structure.mjs` 的 allowedStaticGraph(新模块进不去,kernel domain 与 kernel
 * barrel 还被它按名点名拒绝),而 GUI renderer 的 eslint `no-restricted-imports` 把任何含 kernel 段
 * 的路径整段禁掉——kernel 因此对 CLI 和 GUI 双向不可达,已在白名单里的协议词表是三方都能合法依赖的那一层。 */

/** interval 的下限。领域权威是 `packages/kernel/src/domain/schedule.ts` 的 `everyMs` schema
 * minimum 与 `validateScheduleV1` 谓词;此处只是给 protocol/CLI/GUI 一个不重复的引用点,不是
 * 第二个权威——要改下限得改 kernel,不是改这里。 */
export const SCHEDULE_MIN_EVERY_MS = 60_000;

const scheduleUnitMs = Object.freeze({ ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 });

export type ScheduleDurationUnit = keyof typeof scheduleUnitMs;

/** 词表的单位集合,由小到大。parse 认它、format 从中取能整除的最大单位、GUI 单位控件按它渲染
 * ——三方共用同一张表,是 `parseScheduleDuration(formatScheduleDuration(x)) === x` 成立的全部
 * 理由。`ms` 在表里不是装饰:领域只要求 `everyMs` 是 ≥ 60_000 的安全整数,并不要求它是整秒,
 * 所以词表必须在整个合法域上是全函数,否则 90_001 这类值格式化后就读不回来,而"读不回来"在
 * 表单里的表现就是静默改写用户的间隔。 */
export const scheduleDurationUnits: readonly ScheduleDurationUnit[] = Object.freeze([
  "ms",
  "s",
  "m",
  "h",
  "d",
] satisfies ScheduleDurationUnit[]);

export function scheduleDurationUnitMs(unit: ScheduleDurationUnit): number {
  return scheduleUnitMs[unit];
}

/** 毫秒 → {数值, 单位}:取能整除的最大单位。正数被大于它的单位取模必然不为 0,所以只需比余数。 */
export function splitScheduleDuration(everyMs: number): {
  readonly amount: number;
  readonly unit: ScheduleDurationUnit;
} {
  let chosen: ScheduleDurationUnit = "ms";
  for (const unit of scheduleDurationUnits) if (everyMs % scheduleUnitMs[unit] === 0) chosen = unit;
  return { amount: everyMs / scheduleUnitMs[chosen], unit: chosen };
}

export function formatScheduleDuration(everyMs: number): string {
  const { amount, unit } = splitScheduleDuration(everyMs);
  return `${amount}${unit}`;
}

export function parseScheduleDuration(value: string): number | null {
  const match = /^(\d+)(ms|[smhd])$/u.exec(value);
  if (match === null) return null;
  const milliseconds = Number(match[1]) * scheduleUnitMs[match[2] as ScheduleDurationUnit];
  return Number.isSafeInteger(milliseconds) && milliseconds >= SCHEDULE_MIN_EVERY_MS ? milliseconds : null;
}
