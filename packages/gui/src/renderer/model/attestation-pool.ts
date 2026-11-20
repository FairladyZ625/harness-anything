import type { GateResult, GateStatus, TaskRow } from "./types.ts";

/**
 * 总池两级信息架构的地址词表:第一级是域(decisions=决策待裁,taskCloseout=任务收口),
 * 第二级只在任务收口域内(taskCloseout=三 lane 全览,gates/consents/breakGlass=聚焦
 * 单 lane)。跨域平铺的旧 "all" tab 随域分组撤销;四个 lane id 保持不变,旧的深链
 * 存储值仍可读,仅 "all" 落到存储校验的兜底初始栈。
 */
export const ATTESTATION_POOL_TABS = ["decisions", "taskCloseout", "gates", "consents", "breakGlass"] as const;
export type AttestationPoolTabId = (typeof ATTESTATION_POOL_TABS)[number];

/** 任务收口域内的第二级 tab(含全览);决策域的浏览/过滤由决策区自带,不占这个词表。 */
export const TASK_CLOSEOUT_TABS = ["taskCloseout", "gates", "consents", "breakGlass"] as const;

export type GateAttestMode = NonNullable<GateResult["attestation"]>["mode"];

export interface GateAttestationItem {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly gateId: string;
  readonly mode: GateAttestMode;
  readonly gateStatus: GateStatus;
  readonly adapterId: string;
  readonly detail?: string;
  readonly executionId: string;
}

export interface ConsentItem {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly reviewId: string;
}

export interface AttestationPoolLanes {
  readonly gates: readonly GateAttestationItem[];
  readonly breakGlass: readonly GateAttestationItem[];
  readonly consents: readonly ConsentItem[];
}

export function taskGateAttestations(task: TaskRow): {
  readonly gates: readonly GateAttestationItem[];
  readonly breakGlass: readonly GateAttestationItem[];
} {
  const gates: GateAttestationItem[] = [],
    breakGlass: GateAttestationItem[] = [];
  for (const { name, attestation, status, detail } of task.gates) {
    if (!attestation || !status) continue;
    const lane = attestation.mode === "approve" ? gates : breakGlass;
    lane.push({
      ...attestation,
      taskId: task.taskId,
      taskTitle: task.title,
      gateId: name,
      gateStatus: status,
      ...(detail ? { detail } : {}),
    });
  }
  return { gates, breakGlass };
}

export function taskConsentPending(task: TaskRow): ConsentItem | null {
  if (!task.consentTarget) return null;
  return { taskId: task.taskId, taskTitle: task.title, reviewId: task.consentTarget.reviewId };
}

export function deriveAttestationLanes(tasks: readonly TaskRow[]): AttestationPoolLanes {
  const lanes: { gates: GateAttestationItem[]; breakGlass: GateAttestationItem[]; consents: ConsentItem[] } = {
    gates: [],
    breakGlass: [],
    consents: [],
  };
  for (const task of tasks) {
    const attestations = taskGateAttestations(task);
    lanes.gates.push(...attestations.gates);
    lanes.breakGlass.push(...attestations.breakGlass);
    const consent = taskConsentPending(task);
    if (consent) lanes.consents.push(consent);
  }
  return lanes;
}
