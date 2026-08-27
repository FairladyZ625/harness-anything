import type { DecisionRow, FactRef, RelationEdge, TaskRow, Project, EventEntry } from "../src/renderer/model/types.ts";
import type { WorkspaceSummaryRead } from "../src/api/renderer-dto.ts";
import type {
  AgentRuntimeSessionDto,
  AgentRuntimeInstanceDto,
  AgentRuntimeOverviewResult,
} from "../../daemon/src/agent-runtime-contract.ts";
import type {
  AgentEntityDetail,
  AgentEntityRow,
  SquadEntityDetail,
  SquadEntityRow,
} from "../../daemon/src/agent-entities.ts";
import type { RuntimeDockRow } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";

/**
 * G10 实体互链不变量 · fixture 实体宇宙(entity-id-links.vitest.ts 的数据面)。
 *
 * 七类可寻址实体各一(部分类有第二实例做互链负例),实体 ID 在此单点声明。
 * DOM 扫描的「针」就是这些 ID 字符串:凡渲染产物文本里出现它们而没有
 * button/a/role 祖先,即违反「显示的实体 ID 必须是通往该实体的路」。
 *
 * 非可寻址标识符(executionId、dispatchId、personId、providerSessionId、
 * presetId、kindId、repoId、claim 锚)刻意不进针表:它们没有详情页,
 * 不变量对它们没有「路」可指。
 */

export const REPO_ID = "repo-g10";

export const TASK_A_ID = "task_g10alpha";
export const TASK_B_ID = "task_g10beta";
export const DECISION_ID = "dec_g10alpha";
export const DECISION_B_ID = "dec_g10beta";
export const FACT_ID = "F-g10a";
export const FACT_REF = `fact/${TASK_A_ID}/${FACT_ID}`;
export const AGENT_ID = "g10-agent";
export const SQUAD_ID = "g10-squad";
export const PROVIDER_ID = "g10-provider";
export const SESSION_ID = "g10-session";

/** 扫描针:fixture 实体宇宙的全部实体标识(按长度降序,便于重叠合并)。 */
export const ENTITY_ID_NEEDLES: readonly string[] = [
  FACT_REF,
  TASK_A_ID,
  TASK_B_ID,
  DECISION_ID,
  DECISION_B_ID,
  AGENT_ID,
  SQUAD_ID,
  PROVIDER_ID,
  SESSION_ID,
].sort((a, b) => b.length - a.length);

const AT = "2026-08-20T00:00:00.000Z";

export function fixtureTaskRow(taskId: string, title: string): TaskRow {
  return {
    taskId,
    title,
    projectId: REPO_ID,
    coordinationStatus: "active",
    rawStatus: "active",
    freshness: "fresh",
    packageDisposition: "active",
    closeoutReadiness: "not_required",
    engine: "local",
    source: "local-document",
    module: "gui",
    lastKnownAt: AT,
    gates: [],
    docs: [],
    events: [{ at: AT, projectId: REPO_ID, taskId, summary: "fixture 事件行" }] satisfies EventEntry[],
  };
}

export const FIXTURE_TASKS: TaskRow[] = [
  fixtureTaskRow(TASK_A_ID, "G10 探针任务甲"),
  fixtureTaskRow(TASK_B_ID, "G10 探针任务乙"),
];

/** proposed 态第二条决策:DecisionsView 只对 proposed 渲染 VerdictCard,需要它覆盖决策卡的 ID 面。 */
const PROPOSED_DECISION: DecisionRow = {
  decisionId: DECISION_B_ID,
  title: "G10 探针决策乙(待批)",
  state: "proposed",
  question: "proposed 决策卡渲染哪些实体 ID?",
  proposedBy: { kind: "agent", id: AGENT_ID },
  arbiter: { kind: "agent", id: AGENT_ID },
  chosen: [{ id: "CH1", text: "覆盖决策卡", evidence: [FACT_REF] }],
  rejected: [{ id: "RJ1", text: "不覆盖", evidence: [], whyNot: "门会漏面" }],
  claims: [],
  judgmentConsents: [],
  proposedAt: AT,
};

export const FIXTURE_DECISIONS: DecisionRow[] = [
  PROPOSED_DECISION,
  {
    decisionId: DECISION_ID,
    title: "G10 探针决策",
    state: "in_effect",
    question: "实体互链不变量以什么判据机械化?",
    proposedBy: { kind: "agent", id: AGENT_ID },
    arbiter: { kind: "human", id: "person-zeyu" },
    chosen: [{ id: "CH1", text: "渲染 DOM 后按实体 ID 扫描", evidence: [FACT_REF] }],
    rejected: [{ id: "RJ1", text: "按字段名列黑名单", evidence: [], whyNot: "新加一个字段就绕过去" }],
    claims: [{ id: "CH1", text: "判据必须是机制不是文案", loadBearing: true, fulfillment: "standing_policy" }],
    judgmentConsents: [],
    proposedAt: AT,
  },
];

export const FIXTURE_FACTS: FactRef[] = [
  {
    anchor: `${TASK_A_ID}/${FACT_ID}`,
    taskId: TASK_A_ID,
    category: "finding",
    text: "fixture 事实行:实体 ID 必须可激活。",
    at: AT,
    confidence: "high",
  },
];

export const FIXTURE_RELATIONS: RelationEdge[] = [
  { from: `decision/${DECISION_ID}`, to: `task/${TASK_A_ID}`, kind: "derives", provenance: "local-document" },
  { from: `decision/${DECISION_ID}/CH1`, to: FACT_REF, kind: "evidenced-by", provenance: "local-document" },
  { from: `task/${TASK_A_ID}`, to: FACT_REF, kind: "produces", provenance: "local-document" },
  { from: `task/${TASK_A_ID}`, to: `task/${TASK_B_ID}`, kind: "depends-on", provenance: "local-document" },
  {
    from: `decision/${DECISION_B_ID}`,
    to: `decision/${DECISION_ID}`,
    kind: "supersedes",
    provenance: "local-document",
  },
];

export const FIXTURE_PROJECT: Project = {
  id: REPO_ID,
  name: "G10 Probe Repo",
  path: "/tmp/g10-probe",
  preset: "preset-g10",
  engines: ["local"],
  watermarkAt: AT,
  decisionCount: 1,
  factCount: 1,
};

const DECISION_STATES = [
  "proposed",
  "rejected",
  "deferred",
  "superseded",
  "in_effect",
  "outcome_retired",
  "unknown",
] as const;

export const FIXTURE_WORKSPACE_SUMMARY: WorkspaceSummaryRead = {
  schema: "daemon.workspace-summary/v1",
  ok: true,
  status: "ready",
  tasks: { total: FIXTURE_TASKS.length, byStatus: { active: FIXTURE_TASKS.length } },
  decisions: {
    total: 1,
    inboxCount: 0,
    byState: Object.fromEntries(DECISION_STATES.map((state) => [state, state === "in_effect" ? 1 : 0])),
    groups: [
      { id: "g10-group", states: ["proposed", "in_effect"], count: 2, decisionIds: [DECISION_B_ID, DECISION_ID] },
    ],
  },
  watermark: 1,
  sourceRevision: 1,
  warnings: [],
};

const DEFINITION_SNAPSHOT = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: PROVIDER_ID,
  installationId: "g10-install",
  kindId: "codex",
  providerId: "provider-openai",
  model: "gpt-g10",
  reasoningEffort: null,
  baseUrl: null,
  authMode: "subscription",
} as const;

export const FIXTURE_SESSION_DTO: AgentRuntimeSessionDto = {
  runtimeSessionId: SESSION_ID,
  providerSessionId: "provider-external-g10",
  instanceId: PROVIDER_ID,
  installationId: "g10-install",
  kindId: "codex",
  definitionSnapshotRef: "artifact:runtime-definition/g10",
  definitionSnapshot: DEFINITION_SNAPSHOT,
  liveness: "live",
  attachCapability: "supported",
  streamCursor: "stream:4",
  associations: [
    {
      taskId: TASK_A_ID,
      executionId: "exec-g10",
      holder: { personId: "person-zeyu", executorId: null },
      lease: { phase: "held", expiresAt: AT },
    },
  ],
  activity: { lastObservedAt: AT, outcome: null, exitCode: null, resultRef: null },
};

export const FIXTURE_INSTANCE: AgentRuntimeInstanceDto = {
  schemaVersion: 2,
  instanceId: PROVIDER_ID,
  name: "G10 Provider",
  installationId: "g10-install",
  providerId: "provider-openai",
  models: ["gpt-g10"],
  defaultModel: "gpt-g10",
  enabled: true,
  permissionMode: "workspace-write",
  kindId: "codex",
  codex: {
    reasoningEffort: null,
    baseUrl: null,
    baseUrlConfigured: false,
    wire_api: null,
    requires_openai_auth: null,
    http_headers: null,
  },
  authMode: "subscription",
  authState: "authenticated",
  authReadiness: { status: "ready", code: null, hint: null },
  isolationState: "enforced",
};

export const FIXTURE_RUNTIME_OVERVIEW: AgentRuntimeOverviewResult = {
  ok: true,
  status: "ready",
  installations: [
    {
      installationId: "g10-install",
      kindId: "codex",
      protocolFamily: "codex",
      version: "g10",
      attachCapability: "supported",
      lastObservedAt: AT,
    },
  ],
  instances: [FIXTURE_INSTANCE],
  sessions: [FIXTURE_SESSION_DTO],
  watermark: 1,
  sourceRevision: 1,
};

export const FIXTURE_AGENT_ROW: AgentEntityRow = {
  id: AGENT_ID,
  name: "G10 Agent",
  runtimeType: "codex",
  role: "commander",
  layer: "user",
  validity: "valid",
  issues: [],
};
export const FIXTURE_SQUAD_ROW: SquadEntityRow = {
  id: SQUAD_ID,
  name: "G10 Squad",
  leader: AGENT_ID,
  workers: [AGENT_ID],
  layer: "user",
  validity: "valid",
  issues: [],
};
export const FIXTURE_AGENT_DETAIL: AgentEntityDetail = {
  id: AGENT_ID,
  name: "G10 Agent",
  runtimeType: "codex",
  role: "worker",
  instructions: "run the g10 probe",
  model: null,
  skills: [],
  prompts: [],
  preset: null,
};
export const FIXTURE_SQUAD_DETAIL: SquadEntityDetail = {
  id: SQUAD_ID,
  name: "G10 Squad",
  leader: AGENT_ID,
  workers: [AGENT_ID],
  leaderTurnBudget: 8,
  roster: "g10-agent",
};

/** 会话页 daemon 分组读面 fixture:一个 task 组,最新一轮就是探针会话。 */
export const FIXTURE_SESSION_GROUPS = {
  ok: true,
  status: "ready",
  totals: { groups: 1, sessions: 1 },
  truncated: false,
  watermark: 1,
  sourceRevision: 1,
  groups: [
    {
      key: TASK_A_ID,
      kind: "task" as const,
      label: "G10 探针任务甲",
      taskId: TASK_A_ID,
      latestStatus: "running" as const,
      latestActivityAt: AT,
      runningCount: 1,
      sessionCount: 1,
      roundCount: 1,
      latestRound: {
        runtimeSessionId: SESSION_ID,
        dispatchId: "dispatch-g10round",
        agentName: "G10 Agent",
        instanceId: PROVIDER_ID,
        status: "running" as const,
        startedAt: AT,
      },
    },
  ],
};

export const FIXTURE_DOCK_ROW: RuntimeDockRow = {
  dispatchId: "dispatch-g10",
  taskId: TASK_A_ID,
  executionId: "exec-g10",
  runtimeSessionId: SESSION_ID,
  instanceId: PROVIDER_ID,
  agentId: AGENT_ID,
  agentName: "G10 Agent",
  providerSessionId: null,
  eventStreamRef: null,
  startedAt: AT,
  endedAt: null,
  outcome: null,
  status: "running",
  squad: null,
  delegation: null,
};
