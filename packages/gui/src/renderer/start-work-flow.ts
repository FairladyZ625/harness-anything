import type { TaskRow } from "./model/types.ts";

/**
 * G1「开始一项工作」与「当前仓搜索」的纯派生层(S5,task_654349ce)。
 *
 * 这里只做派生,不发任何请求:GUI 的写面是闭合 allowlist(`daemonGuiActionMethods`),
 * 里面**没有** task 创建 —— 唯一创建单写命令是 `ha task create`
 * (RPC `repo.task.create`,center-forward-write,commandType `CreateReplayTask`)。
 * 所以创建那一步由本模块拼出可复制的真实命令,而不是在界面上画一个没有接线的按钮。
 * 选型/必要条件/创建后核对三步接的都是现有读面,见任务包 progress.md 的映射表。
 *
 * 幂等:taskId 由中心按 opId(意图的内容寻址摘要)分配,两个边缘节点同时建同名任务得到
 * 两条独立任务;同一份意图重放则 opId 命中回放同一回执。命令另带 `--idempotency-key`,
 * 键由表单内容纯函数派生 —— 同一份表单重复执行命中中心的 `readTaskByIdempotencyKey`,
 * 复用同一条任务;表单改了键就变,不会把两件不同的工作并成一条。
 */

/** 索引行之间用它分隔再做子串匹配,避免跨字段拼出假命中。 */
const FIELD_SEPARATOR = "\u0000";

/** 统一实体索引的一行(`buildPaletteIndex` 产物的结构形状),搜索按它过滤。 */
export interface WorkSearchRow {
  readonly ref: string;
  readonly label: string;
  readonly sub?: string;
  readonly entity: string;
}

/** 搜索命中:类型与所属任务组都显式带出,不让用户从标题猜这行是什么、属于谁。 */
export interface WorkSearchHit {
  readonly ref: string;
  readonly label: string;
  readonly entity: string;
  readonly detail: string | null;
  /** 所属任务组 = 任务树根(`TaskRow.rootTaskId`);非任务实体、或本身就是根时为 null。 */
  readonly group: { readonly taskId: string; readonly title: string } | null;
}

/**
 * 当前仓搜索:范围就是喂进来的索引,索引本身按 activeRepoId 装配,所以默认即当前仓,
 * 不另建索引也不跨仓查。过滤口径与关系图左栏、⌘K 面板一致(label / ref / sub 子串)。
 */
export function searchCurrentRepo(
  rows: readonly WorkSearchRow[],
  tasks: readonly TaskRow[],
  query: string,
  limit: number,
): readonly WorkSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const byTaskId = new Map(tasks.map((task) => [task.taskId, task]));
  const hits: WorkSearchHit[] = [];
  for (const row of rows) {
    if (hits.length >= limit) break;
    const haystack = [row.label, row.ref, row.sub ?? ""].join(FIELD_SEPARATOR).toLowerCase();
    if (!haystack.includes(needle)) continue;
    hits.push({
      ref: row.ref,
      label: row.label,
      entity: row.entity,
      detail: row.sub ?? null,
      group: groupOf(row.ref, byTaskId),
    });
  }
  return hits;
}

function groupOf(
  ref: string,
  byTaskId: ReadonlyMap<string, TaskRow>,
): { readonly taskId: string; readonly title: string } | null {
  if (!ref.startsWith("task/")) return null;
  const task = byTaskId.get(ref.slice("task/".length));
  const rootTaskId = task?.rootTaskId;
  if (task === undefined || rootTaskId === undefined || rootTaskId === task.taskId) return null;
  return { taskId: rootTaskId, title: task.rootTitle ?? rootTaskId };
}

/**
 * `task create` 契约声明的两个取值面(kernel `taskClasses` / `taskWorkKinds`)。
 * 渲染层不能把 kernel barrel 拖进浏览器包,所以字面镜像在这里,由 vitest 对着
 * kernel 的真实声明逐词核对 —— 任一边改词,测试当场红。
 */
export const START_WORK_TASK_CLASSES = Object.freeze(["standard", "milestone", "epic", "long_running"]);
export const START_WORK_WORK_KINDS = Object.freeze(["feat", "fix", "refactor", "docs", "test", "chore"]);

/** 「开始一项工作」表单的全部可写字段;命令是它的纯函数。 */
export interface StartWorkDraft {
  readonly title: string;
  /** 目标与交付要求正文。它不是 `task create` 的字段,创建后写进 task_plan.md。 */
  readonly intent: string;
  readonly presetId: string;
  readonly profileId: string | null;
  readonly taskClass: string;
  readonly workKind: string;
  readonly parentTaskId: string | null;
}

export interface StartWorkCommand {
  readonly argv: readonly string[];
  readonly text: string;
  readonly idempotencyKey: string;
}

/** POSIX shell 单引号转义:标题里的空格与引号不会把命令拆开。 */
function shellArgument(value: string): string {
  return /^[\w./:@=-]+$/u.test(value) ? value : `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/** FNV-1a(32 位),两轮不同种子拼成 16 位十六进制。纯函数、无随机源。 */
function contentHash(parts: readonly string[]): string {
  const text = parts.join(FIELD_SEPARATOR);
  const round = (seed: number) => {
    let hash = seed;
    for (let index = 0; index < text.length; index += 1) {
      hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return `${round(0x811c9dc5)}${round(0x7fffffff)}`;
}

/**
 * 幂等键由表单内容派生:同一份表单反复执行只会得到同一条任务(中心
 * `readTaskByIdempotencyKey` 命中即复用),任一字段改动则键改变。
 */
export function startWorkIdempotencyKey(draft: StartWorkDraft): string {
  return `gui-start-work-${contentHash([
    draft.title.trim(),
    draft.intent.trim(),
    draft.presetId,
    draft.profileId ?? "",
    draft.taskClass,
    draft.workKind,
    draft.parentTaskId ?? "",
  ])}`;
}

/**
 * 拼出真实的 `ha task create` 调用。只用 task-create 契约声明过的 flag
 * (`--title` / `--preset` / `--profile` / `--task-class` / `--kind` / `--parent` /
 * `--idempotency-key`),测试对着契约逐个核对,拼不出契约里没有的开关。
 */
export function startWorkCommand(draft: StartWorkDraft): StartWorkCommand {
  const idempotencyKey = startWorkIdempotencyKey(draft);
  const argv = [
    "ha",
    "task",
    "create",
    "--title",
    draft.title.trim(),
    "--preset",
    draft.presetId,
    ...(draft.profileId === null ? [] : ["--profile", draft.profileId]),
    "--task-class",
    draft.taskClass,
    "--kind",
    draft.workKind,
    ...(draft.parentTaskId === null ? [] : ["--parent", draft.parentTaskId]),
    "--idempotency-key",
    idempotencyKey,
  ];
  return { argv, text: argv.map(shellArgument).join(" "), idempotencyKey };
}

/** 创建之后把目标与交付要求写实的那一步:回执给出 packagePath,写完再发布。 */
export function startWorkPublishCommand(taskId: string): string {
  return `ha doc sync --submit --task ${taskId}`;
}

/** 表单能不能生成命令:缺什么就说缺什么,不在界面上先画一个按不动的按钮。 */
export function startWorkBlockers(draft: StartWorkDraft): readonly ("title" | "intent" | "preset")[] {
  return [
    ...(draft.title.trim().length === 0 ? (["title"] as const) : []),
    ...(draft.intent.trim().length === 0 ? (["intent"] as const) : []),
    ...(draft.presetId.length === 0 ? (["preset"] as const) : []),
  ];
}

export type StartWorkPreconditionId = "daemon" | "preset" | "completionGates";

/** 必要条件一行:状态 + 原始取值。措辞归视图,这里不评价。 */
export interface StartWorkPrecondition {
  readonly id: StartWorkPreconditionId;
  readonly state: "ok" | "blocked" | "unknown";
  readonly value: string;
}

/**
 * 必要条件取自真实读面:daemon 健康、目录里这个 preset 的有效性、已解析 profile 的收口门。
 * 读不到就是 unknown —— 空清单不冒充「没有门」。
 */
export function startWorkPreconditions(input: {
  readonly daemonState: string;
  readonly presetValidity: string | null;
  readonly completionGateIds: readonly string[] | null;
}): readonly StartWorkPrecondition[] {
  return [
    {
      id: "daemon",
      state: input.daemonState === "responsive" ? "ok" : "blocked",
      value: input.daemonState,
    },
    {
      id: "preset",
      state: input.presetValidity === null ? "unknown" : input.presetValidity === "valid" ? "ok" : "blocked",
      value: input.presetValidity ?? "",
    },
    {
      id: "completionGates",
      state: input.completionGateIds === null ? "unknown" : "ok",
      value: input.completionGateIds === null ? "" : input.completionGateIds.join(" · "),
    },
  ];
}

/**
 * 创建后核对:在当前任务投影里按标题找这次创建的任务。找不到就是找不到
 * (还没落定 / 还没刷新),不假装成功。同名多条时取最近创建的一条。
 */
export function locateCreatedTask(tasks: readonly TaskRow[], title: string): TaskRow | null {
  const needle = title.trim();
  if (needle.length === 0) return null;
  let found: TaskRow | null = null;
  for (const task of tasks) {
    if (task.title.trim() !== needle) continue;
    if (found === null || (task.createdAt ?? "") > (found.createdAt ?? "")) found = task;
  }
  return found;
}
