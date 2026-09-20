import { clip } from "../daemon-observe-model.ts";
import { t, type MessageKey } from "../i18n/core.ts";
import type { DecisionRow, FactRef } from "./types.ts";

/**
 * 工作空间的「人话」词表与标题解析(S6 可读性):canonical 事件 type、relation kind
 * 与实体前缀到双语文案的**呈现层**映射,外加节点/事件行的标题查表。
 *
 * 纪律:纯派生、不做 IO、不新增读面。标题只从已经传入视图的 task / fact / decision
 * 投影行里取;取不到就返回 null,由视图如实退回原始引用。未登记的事件 type 与
 * relation kind 一律如实返回原名——不猜、不补造。
 */

/** 节点标题与事实陈述的展示长度上限(超出截断,原文仍在悬停的原始引用旁)。 */
export const WORKSPACE_TITLE_LIMIT = 48;

/**
 * canonical 事件 type → 文案 key(kernel `taskEventTypes` / `task_bootstrapped` /
 * `factEventTypes` / `agentRuntimeEventTypes`)。这里只做措辞,不做任何生命周期判定。
 */
const EVENT_TYPE_KEYS: Readonly<Record<string, MessageKey>> = {
  task_created: "views.workspace.event.task_created",
  task_bootstrapped: "views.workspace.event.task_bootstrapped",
  execution_started: "views.workspace.event.execution_started",
  lease_renewed: "views.workspace.event.lease_renewed",
  execution_submitted: "views.workspace.event.execution_submitted",
  submission_forwarded: "views.workspace.event.submission_forwarded",
  submission_returned: "views.workspace.event.submission_returned",
  execution_executor_declared: "views.workspace.event.execution_executor_declared",
  execution_annotated: "views.workspace.event.execution_annotated",
  review_recorded: "views.workspace.event.review_recorded",
  review_consent_recorded: "views.workspace.event.review_consent_recorded",
  code_doc_reconciled: "views.workspace.event.code_doc_reconciled",
  code_doc_repointed: "views.workspace.event.code_doc_repointed",
  completion_gate_verified: "views.workspace.event.completion_gate_verified",
  task_completed: "views.workspace.event.task_completed",
  lease_released: "views.workspace.event.lease_released",
  task_transitioned: "views.workspace.event.task_transitioned",
  task_amended: "views.workspace.event.task_amended",
  task_archived: "views.workspace.event.task_archived",
  task_superseded: "views.workspace.event.task_superseded",
  task_deleted: "views.workspace.event.task_deleted",
  task_reopened: "views.workspace.event.task_reopened",
  task_contract_migrated: "views.workspace.event.task_contract_migrated",
  task_relation_added: "views.workspace.event.task_relation_added",
  fact_recorded: "views.workspace.event.fact_recorded",
  fact_reclassified: "views.workspace.event.fact_reclassified",
  fact_archived: "views.workspace.event.fact_archived",
  fact_unarchived: "views.workspace.event.fact_unarchived",
  runtime_installation_observed: "views.workspace.event.runtime_installation_observed",
  runtime_dispatch_requested: "views.workspace.event.runtime_dispatch_requested",
  runtime_dispatch_outcome_unknown: "views.workspace.event.runtime_dispatch_outcome_unknown",
  runtime_session_started: "views.workspace.event.runtime_session_started",
  runtime_session_provider_bound: "views.workspace.event.runtime_session_provider_bound",
  runtime_session_task_bound: "views.workspace.event.runtime_session_task_bound",
  runtime_session_liveness_changed: "views.workspace.event.runtime_session_liveness_changed",
  runtime_session_cancelled: "views.workspace.event.runtime_session_cancelled",
  runtime_session_exited: "views.workspace.event.runtime_session_exited",
  runtime_session_outcome_observed: "views.workspace.event.runtime_session_outcome_observed",
};

/** kernel `relationTypes` → 文案 key。 */
const RELATION_KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  supports: "views.workspace.relation.supports",
  supersedes: "views.workspace.relation.supersedes",
  refines: "views.workspace.relation.refines",
  narrows: "views.workspace.relation.narrows",
  derives: "views.workspace.relation.derives",
  blocks: "views.workspace.relation.blocks",
  relates: "views.workspace.relation.relates",
  implements: "views.workspace.relation.implements",
  "depends-on": "views.workspace.relation.dependsOn",
  produces: "views.workspace.relation.produces",
  evidences: "views.workspace.relation.evidences",
  "evidenced-by": "views.workspace.relation.evidencedBy",
  "refuted-by": "views.workspace.relation.refutedBy",
  "invalidated-by": "views.workspace.relation.invalidatedBy",
  "supersedes-fact": "views.workspace.relation.supersedesFact",
  executes: "views.workspace.relation.executes",
  reviews: "views.workspace.relation.reviews",
  owns: "views.workspace.relation.owns",
  dispatches: "views.workspace.relation.dispatches",
  authorizes: "views.workspace.relation.authorizes",
};

/** 实体引用前缀 → 文案 key(内建五类 + execution / runtime-session 两类执行面实体)。 */
const ENTITY_KIND_KEYS: Readonly<Record<string, MessageKey>> = {
  task: "views.workspace.entity.task",
  decision: "views.workspace.entity.decision",
  fact: "views.workspace.entity.fact",
  agent: "views.workspace.entity.agent",
  schedule: "views.workspace.entity.schedule",
  execution: "views.workspace.entity.execution",
  "runtime-session": "views.workspace.entity.runtimeSession",
};

/** 已登记的事件 type 给人话;没登记的如实返回原名(不猜语义)。 */
export function eventTypeLabel(type: string): string {
  const key = EVENT_TYPE_KEYS[type];
  return key === undefined ? type : t(key);
}

/** 已登记的 relation kind 给人话;没登记的如实返回原名。 */
export function relationKindLabel(kind: string): string {
  const key = RELATION_KIND_KEYS[kind];
  return key === undefined ? kind : t(key);
}

/** 已登记的实体前缀给人话;没登记的如实返回原前缀。 */
export function entityKindLabel(kind: string): string {
  const key = ENTITY_KIND_KEYS[kind];
  return key === undefined ? kind : t(key);
}

export interface WorkspaceTitleSources {
  readonly tasks: readonly { readonly taskId: string; readonly title: string }[];
  readonly facts: readonly FactRef[];
  readonly decisions: readonly DecisionRow[];
}

/**
 * 已返回的投影行 → 归一引用到标题的查表。fact 用其陈述的截断当标题;
 * 空标题不入表,以免用空串冒充「有标题」。
 */
export function workspaceTitleIndex(sources: WorkspaceTitleSources): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const { taskId, title } of sources.tasks)
    if (title !== "") index.set(`task/${taskId}`, clip(title, WORKSPACE_TITLE_LIMIT));
  for (const { anchor, text } of sources.facts) if (text !== "") index.set(anchor, clip(text, WORKSPACE_TITLE_LIMIT));
  for (const { decisionId, title } of sources.decisions)
    if (title !== "") index.set(`decision/${decisionId}`, clip(title, WORKSPACE_TITLE_LIMIT));
  return index;
}

export interface WorkspaceNodeLabel {
  /** 原始引用,退为次要信息(视图放在悬停或副行)。 */
  readonly ref: string;
  /** 人话实体类型;前缀没登记就是原前缀。 */
  readonly kindLabel: string;
  /** 读面里有标题就给标题(fact 为陈述截断),没有就是 null——不补造。 */
  readonly title: string | null;
  /** 去掉实体前缀的原始 id,标题缺位时当展示名。 */
  readonly id: string;
}

/** 归一引用 + 标题查表 → 节点展示三元组(类型 / 标题 / 原始引用)。 */
export function workspaceNodeLabel(ref: string, titles: ReadonlyMap<string, string>): WorkspaceNodeLabel {
  const separator = ref.indexOf("/"),
    kind = separator === -1 ? "" : ref.slice(0, separator),
    id = separator === -1 ? ref : ref.slice(separator + 1);
  return { ref, kindLabel: entityKindLabel(kind), title: titles.get(ref) ?? null, id };
}

/** 节点在一行里的展示名:有标题用标题,没有就如实用原始 id。 */
export function workspaceNodeText(node: WorkspaceNodeLabel): string {
  return node.title ?? node.id;
}
