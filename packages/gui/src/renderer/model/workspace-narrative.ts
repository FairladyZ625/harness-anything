import type { MessageKey } from "../i18n/index.tsx";
import type { CadenceFeedEvent } from "./cadence.ts";
import type { SnapshotStatus, TaskRow } from "./types.ts";

/**
 * 工作页概况的纯派生(原型 v2,dec_AF44708E8F70F04E59FF751F9C/CH1):
 * 「没有 agent 在跑」的判据、按天收束的进展、子组归属、task_plan 的 Brief 目标行、
 * 人读相对时长。纪律:只消费已取投影,不做 IO、不新增读面;判定镜像 daemon 议程
 * 读面的同一批信号(lease / active execution),不从任务状态词推断。
 */

/** 与 daemon agenda `inFlight` 同判据的行形状:lease 持有者 + execution 快照。 */
export interface RuntimeCarrierFields {
  readonly coordinationStatus: TaskRow["coordinationStatus"];
  readonly leaseHolder?: string;
  readonly executions?: TaskRow["executions"];
}

/**
 * 标着在做、但没有 agent 在跑:active 且无 lease、无 active execution——
 * 与 daemon `repo.agenda.read` 的 inFlight 判据互补,不信任务状态词。
 */
export function noAgentRunning(task: RuntimeCarrierFields): boolean {
  return (
    task.coordinationStatus === "active" &&
    task.leaseHolder === undefined &&
    !(task.executions ?? []).some(({ state }) => state === "active")
  );
}

/**
 * 一天里一个任务走过的步骤(收束后的事件种类)。呈现层的 label/tone 由视图查表,
 * 模型只给语义种类;未列出的 canonical 事件 type 不进步骤(完整流仍在检修页)。
 * consent/witness/dismissed/abandoned 只由任务详情的进展时间线用(快照上的记录,
 * canonical 事件流不产这几种),同一张词表,不另开第二套。
 */
export type WorkStepKind =
  | "start"
  | "dispatch"
  | "submit"
  | "approved"
  | "rejected"
  | "returned"
  | "completed"
  | "reopened"
  | "fact"
  | "gatePass"
  | "gateFail"
  | "gateCheck"
  | "consent"
  | "witness"
  | "dismissed"
  | "abandoned";

/** 步骤种类的文案键单源:工作概况的 STEP_META、任务详情时间线与适配层摘要同一张表。 */
export const WORK_STEP_LABEL_KEY: Readonly<Record<WorkStepKind, MessageKey>> = {
  start: "views.workspace.step.start",
  dispatch: "views.workspace.step.dispatch",
  submit: "views.workspace.step.submit",
  approved: "views.workspace.step.approved",
  rejected: "views.workspace.step.rejected",
  returned: "views.workspace.step.returned",
  completed: "views.workspace.step.completed",
  reopened: "views.workspace.step.reopened",
  fact: "views.workspace.step.fact",
  gatePass: "views.workspace.step.gatePass",
  gateFail: "views.workspace.step.gateFail",
  gateCheck: "views.workspace.step.gateCheck",
  consent: "views.workspace.step.consent",
  witness: "views.workspace.step.witness",
  dismissed: "views.workspace.step.dismissed",
  abandoned: "views.workspace.step.abandoned",
};

const STEP_BY_EVENT: Readonly<Record<string, WorkStepKind | undefined>> = {
  execution_started: "start",
  runtime_dispatch_requested: "dispatch",
  runtime_session_started: "dispatch",
  execution_submitted: "submit",
  task_completed: "completed",
  task_reopened: "reopened",
  fact_recorded: "fact",
};

function stepOf(event: CadenceFeedEvent): WorkStepKind | null {
  if (event.type === "review_recorded") {
    if (event.reviewVerdict === "approved") return "approved";
    if (event.reviewVerdict === "changes_requested") return "rejected";
    return null;
  }
  if (event.type === "submission_returned") return "returned";
  if (event.type === "completion_gate_verified") {
    if (event.gateResult === "pass") return "gatePass";
    if (event.gateResult === "fail") return "gateFail";
    return null;
  }
  return STEP_BY_EVENT[event.type] ?? null;
}

export interface WorkTaskDayPath {
  readonly taskId: string;
  readonly title: string | null;
  /** 该任务当天第一个事件的时间,呈现层自行格式化。 */
  readonly firstAt: string;
  readonly steps: readonly WorkStepKind[];
}

export interface WorkDayGroup {
  readonly dateKey: string;
  readonly paths: readonly WorkTaskDayPath[];
  readonly counts: {
    readonly completed: number;
    readonly submitted: number;
    readonly rejected: number;
    readonly returned: number;
  };
}

/**
 * 升序事件窗 → 按天收束的进展(新的一天在前,天内每任务一条路径)。
 * 连续同类步骤收成一步;没有可收束步骤的任务不出路径。
 */
export function workDayGroups(input: {
  readonly events: readonly CadenceFeedEvent[];
  readonly titles: ReadonlyMap<string, string>;
  readonly dateKeyOf: (iso: string) => string | null;
}): readonly WorkDayGroup[] {
  const days = new Map<string, Map<string, WorkTaskDayPath & { steps: WorkStepKind[] }>>();
  for (const event of input.events) {
    if (event.taskId === null || event.at === null) continue;
    const dateKey = input.dateKeyOf(event.at);
    if (dateKey === null) continue;
    let day = days.get(dateKey);
    if (day === undefined) {
      day = new Map();
      days.set(dateKey, day);
    }
    const step = stepOf(event);
    let path = day.get(event.taskId);
    if (path === undefined) {
      path = {
        taskId: event.taskId,
        title: input.titles.get(`task/${event.taskId}`) ?? null,
        firstAt: event.at,
        steps: [],
      };
      day.set(event.taskId, path);
    }
    if (step !== null && path.steps.at(-1) !== step) path.steps.push(step);
  }
  return [...days.entries()].map(([dateKey, tasks]) => {
    const paths = [...tasks.values()].filter(({ steps }) => steps.length > 0);
    return {
      dateKey,
      paths,
      counts: {
        completed: paths.filter(({ steps }) => steps.includes("completed")).length,
        submitted: paths.filter(({ steps }) => steps.includes("submit")).length,
        rejected: paths.filter(({ steps }) => steps.includes("rejected")).length,
        returned: paths.filter(({ steps }) => steps.includes("returned")).length,
      },
    };
  });
}

export interface WorkSubgroupInputTask {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly status: SnapshotStatus;
}

export interface WorkSubgroup {
  /** 组任务 id;`_loose` 是直接挂在根下的零散叶子。 */
  readonly key: string;
  readonly title: string | null;
  readonly loose: boolean;
  /** 相对根的层级:根的直接子组为 0。 */
  readonly depth: number;
  readonly memberTaskIds: readonly string[];
  readonly counts: Readonly<Partial<Record<SnapshotStatus, number>>>;
  /** 在途:active / submitted / in_review。 */
  readonly inFlight: number;
}

const IN_FLIGHT: ReadonlySet<SnapshotStatus> = new Set(["active", "submitted", "in_review"]);

/**
 * 叶子按「最近的子组」归属(从叶子沿父链向上、遇到根之前的第一个组);
 * 直接挂在根下的叶子归零散组。组排序:零散在前,再按未完成数、总数降序。
 */
export function workSubgroups(input: {
  readonly rootTaskId: string;
  readonly groups: readonly { readonly taskId: string; readonly parentTaskId: string | null; readonly title: string }[];
  readonly leaves: readonly WorkSubgroupInputTask[];
}): readonly WorkSubgroup[] {
  const groupIds = new Set(input.groups.map(({ taskId }) => taskId)),
    groupById = new Map(input.groups.map((group) => [group.taskId, group])),
    parentOf = new Map<string, string | null>([
      ...input.groups.map(({ taskId, parentTaskId }) => [taskId, parentTaskId] as const),
      ...input.leaves.map(({ taskId, parentTaskId }) => [taskId, parentTaskId] as const),
    ]),
    depthCache = new Map<string, number>();
  const depthOf = (groupId: string): number => {
    const cached = depthCache.get(groupId);
    if (cached !== undefined) return cached;
    const parent = parentOf.get(groupId) ?? null,
      depth = parent === input.rootTaskId || parent === null ? 0 : depthOf(parent) + 1;
    depthCache.set(groupId, depth);
    return depth;
  };
  const subgroupKeyOf = (leaf: WorkSubgroupInputTask): string => {
    const seen = new Set<string>([leaf.taskId]);
    let parentId = leaf.parentTaskId;
    while (parentId !== null && parentId !== input.rootTaskId && !seen.has(parentId)) {
      if (groupIds.has(parentId)) return parentId;
      seen.add(parentId);
      parentId = parentOf.get(parentId) ?? null;
    }
    return "_loose";
  };
  const members = new Map<string, WorkSubgroupInputTask[]>();
  for (const leaf of input.leaves) {
    const key = subgroupKeyOf(leaf);
    const bucket = members.get(key);
    if (bucket === undefined) members.set(key, [leaf]);
    else bucket.push(leaf);
  }
  return [...members.entries()]
    .map(([key, leaves]) => {
      const group = key === "_loose" ? undefined : groupById.get(key),
        counts: Partial<Record<SnapshotStatus, number>> = {};
      for (const { status } of leaves) counts[status] = (counts[status] ?? 0) + 1;
      return {
        key,
        title: group?.title ?? null,
        loose: key === "_loose",
        depth: key === "_loose" ? 0 : depthOf(key),
        memberTaskIds: leaves.map(({ taskId }) => taskId),
        counts,
        inFlight: leaves.filter(({ status }) => IN_FLIGHT.has(status)).length,
      };
    })
    .sort((left, right) => {
      if (left.loose !== right.loose) return left.loose ? -1 : 1;
      const leftLeaves = members.get(left.key) ?? [],
        rightLeaves = members.get(right.key) ?? [],
        unfinished = (leaves: WorkSubgroupInputTask[]) =>
          leaves.filter(({ status }) => status !== "done" && status !== "cancelled").length;
      return (
        unfinished(rightLeaves) - unfinished(leftLeaves) ||
        rightLeaves.length - leftLeaves.length ||
        left.depth - right.depth
      );
    });
}

/** task_plan.md 的 Brief 段:目标一行的唯一来源;没有 Brief 或为空就是 null,不猜。 */
export function workspaceGoalLine(planBody: string): string | null {
  const lines = planBody.split(/\r?\n/u);
  let inside = false;
  const collected: string[] = [];
  for (const line of lines) {
    if (/^##\s/u.test(line)) {
      if (inside) break;
      inside = /^##\s+Brief\s*$/u.test(line);
      continue;
    }
    if (inside && line.trim() !== "") collected.push(line.trim());
  }
  return collected.length > 0 ? collected.join("\n\n") : null;
}
