/**
 * 会话详情「先给做成了什么」的纯派生(task_6bc70402):结局裁决、耗时、产出清单。
 *
 * 三个量各有唯一来源,不在视图里再猜:
 * - 结局:daemon 的 `settlement`(终局裁决)优先;没有 settlement 时退回会话读面的
 *   `semanticState`/`activity.outcome`;仍在跑(live)就没有结局词。
 * - 耗时:起止都取台账时间(派工行 startedAt/endedAt);缺一端不编造,返回 null。
 * - 产出:提交 sha 与交付文件来自任务投影的执行记录(`submission`),结果报告来自派工行的
 *   `reportPath`(daemon 只在文档真实存在时才给该字段)。PR 号没有读面来源
 *   (`repo.works.briefs.read` 的 pullRequests 依赖 ciRuns,daemon 当前未传),这里不造。
 */
import type { AgentRuntimeSessionResult } from "@harness-anything/daemon/protocol";
import type { TaskDispatchProjectionRow, TaskSnapshotProjectionRow } from "../../api/renderer-dto.ts";
import { epochMsOf } from "../sessions-model.ts";

/** daemon 的终局裁决类型(协议未单独再导出,从会话读结果取成员,不另立镜像)。 */
export type SessionSettlement = NonNullable<AgentRuntimeSessionResult["settlement"]>;

/** 首屏结局词:成功 / 失败 / 取消 / 停手 / 无法判定 / 无法确认 / 运行中。 */
export type SessionVerdict = "succeeded" | "failed" | "cancelled" | "stopped" | "unknown" | "indeterminate" | "running";

/**
 * 结局的唯一判定:settlement 是 daemon 的终局裁决,先认它;没有再按语义状态/结局词退。
 * live 会话无论有没有旧结局都算「运行中」——正在发生的会话不该被上一轮结局抢先命名。
 */
export function sessionVerdict(input: {
  readonly liveness: string;
  readonly semanticState?: string;
  readonly outcome?: string | null;
  readonly settlement: Pick<SessionSettlement, "outcome"> | null | undefined;
}): SessionVerdict {
  if (input.liveness === "live") return "running";
  const word = input.settlement?.outcome ?? input.semanticState ?? input.outcome ?? null;
  switch (word) {
    case "succeeded":
    case "failed":
    case "cancelled":
    case "stopped":
      return word;
    case "unknown":
      return "unknown";
    // 语义状态里的这两个词都是「结束了但结论不成立」:ended-indeterminate 有退出但判不出结果,
    // unavailable 连结局证据都没有。首屏都按「无法确认」说,细节留给缺证据行。
    case "ended-indeterminate":
    case "unavailable":
      return "indeterminate";
    default:
      return "unknown";
  }
}

/** 结局词 → 首屏措辞:回答「做成了没有」,与组列表的状态词(状态机词)分开。 */
export const sessionVerdictKey: Readonly<Record<SessionVerdict, string>> = {
  succeeded: "agentRuntime.sessionVerdictSucceeded",
  failed: "agentRuntime.sessionVerdictFailed",
  cancelled: "agentRuntime.sessionVerdictCancelled",
  stopped: "agentRuntime.sessionVerdictStopped",
  unknown: "agentRuntime.sessionVerdictUnknown",
  indeterminate: "agentRuntime.sessionVerdictIndeterminate",
  running: "agentRuntime.sessionVerdictRunning",
};

/** 结局的词色档:与 StatusTag 的 tone 同一套语义(成功=done、失败=bad、停手/未知=neutral)。 */
export const sessionVerdictTone: Readonly<Record<SessionVerdict, "done" | "bad" | "cancel" | "neutral" | "active">> = {
  succeeded: "done",
  failed: "bad",
  cancelled: "cancel",
  stopped: "neutral",
  unknown: "neutral",
  indeterminate: "neutral",
  running: "active",
};

/**
 * 会话耗时:派工行的 startedAt→endedAt。仍在跑时没有 endedAt,用 `now` 到当前(调用方
 * 决定要不要传);两端任一缺失或时间不合理返回 null,由视图显示占位而不是算一个假数。
 */
export function sessionElapsedMs(
  row: Pick<TaskDispatchProjectionRow, "startedAt" | "endedAt"> | null,
  now?: number,
): number | null {
  if (row === null) return null;
  const start = epochMsOf(row.startedAt),
    end = row.endedAt === null ? (now ?? null) : epochMsOf(row.endedAt);
  if (start === null || end === null || end < start) return null;
  return end - start;
}

/** 本次产出的一条:kind 决定它在界面上的措辞与落点。 */
export type SessionOutput =
  | { readonly kind: "commit"; readonly commitSha: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "artifact"; readonly path: string }
  | { readonly kind: "report"; readonly path: string };

/**
 * 本次产出清单(按展示顺序、去重):提交 sha → 交付文件 → 任务产物 → 结果报告。
 * 执行记录以最后一次提交(`submittedAt` 最新)为准,不把历史轮次的清单混进来。
 * 提交 sha 为 null 的执行(纯产物交付)只有产物行,不造空提交行。
 */
export function sessionOutputs(input: {
  readonly executions: NonNullable<TaskSnapshotProjectionRow["snapshot"]["executions"]> | undefined;
  /** 本会话绑定的执行 id:有绑定时只认这一条;没有绑定(历史会话)才退到最近一次提交。 */
  readonly executionId?: string | null;
  readonly reportPath: string | null | undefined;
}): readonly SessionOutput[] {
  const outputs: SessionOutput[] = [];
  const submitted = [...(input.executions ?? [])].filter((execution) => {
    const archived = "archivedSubmission" in execution;
    return (
      execution.submittedAt !== null &&
      (archived ? execution.archivedSubmission !== null : execution.submission !== null)
    );
  });
  // 会话已绑定执行时只认那一条:退到「最近一次提交」会把上一轮迭代的产物列成本轮的
  // (实测运行中的会话显示 iteration 0 的交付文件,而它自己还没有提交)。
  const bound =
    input.executionId === undefined || input.executionId === null
      ? undefined
      : submitted.find((execution) => execution.executionId === input.executionId);
  const latest =
    input.executionId === undefined || input.executionId === null
      ? [...submitted].sort((left, right) => (right.submittedAt ?? "").localeCompare(left.submittedAt ?? ""))[0]
      : bound;
  if (latest !== undefined) {
    if ("archivedSubmission" in latest) {
      // 归档执行(v0)没有 commitSha 与 outputs,只有交付文件与证据引用:按能读到的字段出。
      const submission = latest.archivedSubmission;
      if (submission !== null) for (const path of submission.deliverables) outputs.push({ kind: "file", path });
    } else {
      const submission = latest.submission;
      if (submission !== null) {
        if (submission.commitSha !== null) outputs.push({ kind: "commit", commitSha: submission.commitSha });
        for (const path of submission.deliverables) outputs.push({ kind: "file", path });
        for (const anchor of submission.artifacts ?? []) outputs.push({ kind: "artifact", path: anchor.path });
      }
    }
  }
  if (typeof input.reportPath === "string" && input.reportPath.length > 0)
    outputs.push({ kind: "report", path: input.reportPath });
  const seen = new Set<string>();
  return outputs.filter((output) => {
    const key = output.kind === "commit" ? `commit:${output.commitSha}` : `${output.kind}:${output.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
