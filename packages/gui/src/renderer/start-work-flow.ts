/**
 * 「开始一项工作」向导的纯派生层。创建使用 GUI Action allowlist 中的
 * `repo.task.create`；任务与幂等键仍由 daemon 的中心转发写路分配。
 */

/** 幂等键原文的字段分隔符,避免跨字段拼出相同原文。 */
const FIELD_SEPARATOR = "\u0000";

/**
 * `task create` 契约声明的两个取值面(kernel `taskClasses` / `taskWorkKinds`)。
 * 渲染层不能把 kernel barrel 拖进浏览器包,所以字面镜像在这里,由 vitest 对着
 * kernel 的真实声明逐词核对 —— 任一边改词,测试当场红。
 */
export const START_WORK_TASK_CLASSES = Object.freeze(["standard", "work", "long_running"]);
export const START_WORK_WORK_KINDS = Object.freeze(["feat", "fix", "refactor", "docs", "test", "chore"]);
export const START_WORK_RISK_TIERS = Object.freeze(["low", "medium", "high"]);

/** 「开始一项工作」表单的全部可写字段。 */
export interface StartWorkDraft {
  readonly title: string;
  readonly intent: string;
  readonly presetId: string;
  readonly riskTier: string;
  readonly taskClass: string;
  readonly workKind: string;
  readonly parentTaskId: string | null;
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

/** 幂等键由完整表单内容派生,重复提交同一份意图复用中心回执。 */
export function startWorkIdempotencyKey(draft: StartWorkDraft): string {
  return `gui-start-work-${contentHash([
    draft.title.trim(),
    draft.intent.trim(),
    draft.presetId,
    draft.riskTier,
    draft.taskClass,
    draft.workKind,
    draft.parentTaskId ?? "",
  ])}`;
}

/**
 * 将用户 brief 写入 preset 的真实 task.plan scaffold。其它 section 保留模板正文,
 * 并标明它们需要按 Brief 校验;这样提交的是 daemon 可读取、可评估的 plan,而不是
 * 一份绕过 preset readiness contract 的自由文本。
 */
export function startWorkPlan(scaffold: string, title: string, intent: string, sectionNote: string): string | null {
  const lines = scaffold.replaceAll("{{title}}", title.trim()).split(/\r?\n/u),
    sections: { readonly start: number; readonly end: number; readonly heading: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##[ \t]+(.+?)\s*$/u.exec(lines[index] ?? "");
    if (!heading) continue;
    const previous = sections.at(-1);
    if (previous) sections[sections.length - 1] = { ...previous, end: index };
    sections.push({ start: index, end: lines.length, heading: heading[1]!.trim() });
  }
  if (sections.length === 0) return null;

  const briefIndex = sections.findIndex(({ heading }) => heading.toLocaleLowerCase("en-US") === "brief"),
    primaryIndex = briefIndex < 0 ? 0 : briefIndex,
    authoredIntent = intent
      .trim()
      .split(/\r?\n/u)
      .map((line) => (line.length === 0 ? ">" : `> ${line}`))
      .join("\n");
  for (let sectionIndex = sections.length - 1; sectionIndex >= 0; sectionIndex -= 1) {
    const section = sections[sectionIndex]!,
      contentStart = section.start + 1,
      content = lines.slice(contentStart, section.end);
    if (sectionIndex === primaryIndex) {
      lines.splice(contentStart, section.end - contentStart, "", authoredIntent, "");
      continue;
    }
    while (content.at(-1) === "") content.pop();
    content.push("", sectionNote);
    lines.splice(contentStart, section.end - contentStart, ...content);
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** 表单能不能提交:缺什么就说缺什么,不在界面上先画一个按不动的按钮。 */
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

/** 必要条件取自真实读面:daemon 健康、目录里这个 preset 的有效性、已解析 profile 的收口门。 */
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
