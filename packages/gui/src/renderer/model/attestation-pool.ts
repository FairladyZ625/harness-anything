import type { TaskRow } from "./types.ts";

/**
 * 待办签发总池的任务侧 lane 派生(纯函数)。判据只消费 daemon 投影行已有的状态:
 * `closeoutAssessment.blocker`(consent=评审已批待同意)与 `gates[].status`
 * (failed/missing/signoff_missing),加上冻结在 submission 里的 `completionContract`
 * (witness.adapterId 与 allowOverride)。renderer 不发明第二套门禁判定——缺契约的
 * legacy cut 不猜适配器,不进任何 lane。
 */

export const ATTESTATION_POOL_TABS = ["all", "decisions", "gates", "consents", "breakGlass"] as const;
export type AttestationPoolTabId = (typeof ATTESTATION_POOL_TABS)[number];

/** gate 签发动作:approve=打勾签注(纯人工门或双控缺签);override=特批放行(豁免已记录失败或未取得自动见证)。 */
export type GateAttestMode = "approve" | "override";

export interface GateAttestationItem {
  readonly taskId: string;
  readonly taskTitle: string;
  readonly gateId: string;
  readonly mode: GateAttestMode;
  /** 投影里的真实 gate 状态:missing=缺见证,signoff_missing=机器已过缺人签,failed=机器失败。 */
  readonly gateStatus: "missing" | "signoff_missing" | "failed";
  /** 冻结契约声明的见证适配器;legacy 无契约时为 null(如实展示,不猜)。 */
  readonly adapterId: string | null;
  readonly detail?: string;
  readonly executionId: string | null;
}

export interface ConsentItem {
  readonly taskId: string;
  readonly taskTitle: string;
}

export interface AttestationPoolLanes {
  readonly gates: readonly GateAttestationItem[];
  readonly breakGlass: readonly GateAttestationItem[];
  readonly consents: readonly ConsentItem[];
}

interface FrozenContractGate {
  readonly adapterId: string | null;
  readonly allowOverride: boolean;
  readonly executionId: string;
}

/**
 * 当前 cut 的冻结契约 gate 表(gateId → 见证适配器 + execution)。镜像 kernel
 * `currentExecutionCuts` 的判据:只认 native execution/v1、当前迭代、已带 submission;
 * 同迭代多个 cut 是歧义,不选边,返回空表。
 */
function currentCutContractGates(task: TaskRow): ReadonlyMap<string, FrozenContractGate> {
  const gates = new Map<string, FrozenContractGate>();
  const cuts = (task.executions ?? []).filter(
    (execution): execution is Extract<typeof execution, { readonly schema: "execution/v1" }> =>
      execution.schema === "execution/v1" && execution.iteration === task.iteration && execution.submission !== null,
  );
  if (cuts.length !== 1) return gates;
  const cut = cuts[0]!;
  // archival 变体的 submission 不带冻结契约(Omit<SubmissionV1, "completionContract">):
  // 缺契约即无可判定适配器,与「没有 cut」同样处理,不猜。
  for (const requirement of cut.submission?.completionContract?.gates ?? []) {
    // 迁移保留的历史要求没有适配器,永远不能签注或特批,不进任何 lane。
    if (requirement.witness.kind !== "adapter") continue;
    gates.set(requirement.gateId, {
      adapterId: requirement.witness.adapterId,
      allowOverride: requirement.allowOverride === true,
      executionId: cut.executionId,
    });
  }
  return gates;
}

/**
 * 单任务的人签动作,判据与 kernel `judgeGateWitnesses`/`witnessCommand` 同一条
 * (dec_59FA45A407 四形态):待签 = manual-attest 的 missing,或自动已 pass 的
 * signoff_missing(双控缺人签);特批 = 非 manual-attest 且契约声明 allowOverride
 * 的 failed(豁免已记录的失败回执)或 missing(本 cut 未取得任何自动见证,如
 * runner 不可达/采集不可用,daemon 记 waivedReceiptId:null)——未声明
 * allowOverride 的门 daemon 必拒(invalid_command),不给 CTA。done/历史接受的门
 * 只读;waived 只在展示层标注人为放行,不进任何 lane。
 */
export function taskGateAttestations(task: TaskRow): {
  readonly gates: readonly GateAttestationItem[];
  readonly breakGlass: readonly GateAttestationItem[];
} {
  const gates: GateAttestationItem[] = [],
    breakGlass: GateAttestationItem[] = [];
  if (task.canonicalStatus === "done") return { gates, breakGlass };
  const contract = currentCutContractGates(task);
  for (const gate of task.gates) {
    const frozen = contract.get(gate.name) ?? null,
      adapterId = frozen?.adapterId ?? null;
    const base = {
      taskId: task.taskId,
      taskTitle: task.title,
      gateId: gate.name,
      adapterId,
      executionId: frozen?.executionId ?? null,
      ...(gate.detail ? { detail: gate.detail } : {}),
    };
    if ((gate.status === "missing" && adapterId === "manual-attest") || gate.status === "signoff_missing")
      gates.push({ ...base, mode: "approve", gateStatus: gate.status });
    else if (
      (gate.status === "failed" || gate.status === "missing") &&
      frozen?.allowOverride === true &&
      adapterId !== "manual-attest"
    )
      breakGlass.push({ ...base, mode: "override", gateStatus: gate.status });
  }
  return { gates, breakGlass };
}

/** 评审已批准、只差一次人的同意(kernel closeoutAssessment.blocker=consent)。 */
export function taskConsentPending(task: TaskRow): ConsentItem | null {
  if (task.closeoutBlocker !== "consent") return null;
  return { taskId: task.taskId, taskTitle: task.title };
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
