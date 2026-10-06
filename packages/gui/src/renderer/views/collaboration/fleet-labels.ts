import { t, type MessageKey } from "../../i18n/index.tsx";
import type { FleetFieldState, FleetOverviewNode } from "../../../api/renderer-dto.ts";
import type { StatusTone } from "../../components/primitives/StatusTag.tsx";

/**
 * 协作页舰队拓扑的人话化共享表(数据层 task_8ce646d94 交付的稳定契约):
 * daemon 的机器码(reason/标记串/声明前缀)只在查看侧翻译成 i18n 人话,机器码进
 * title 与 data-reason 供测试断言,不在正文露出。节点卡与详情抽屉共用同一份表,
 * 不在两个组件里各抄一份。
 */

export const PHASE_LABEL: Readonly<Record<string, MessageKey>> = {
  held: "collaboration.phase.held",
  reserving: "collaboration.phase.reserving",
  orphaned: "collaboration.phase.orphaned",
  released: "collaboration.phase.released",
};
export const PHASE_TONE: Readonly<Record<string, StatusTone>> = {
  held: "active",
  reserving: "wait",
  orphaned: "bad",
  released: "neutral",
};

/** daemon 稳定 reason 码 → 一句人话(为什么没有、何时会有);未收录的码显示通用说明,码进 title。 */
const REASON_LABELS: Readonly<Record<string, MessageKey>> = {
  "tls-session-fact-not-exposed": "collaboration.reason.onlineNotExposed",
  "replica-status-has-no-build-field": "collaboration.reason.buildNotInReplicaStatus",
  "edge-sync-internals-not-exposed": "collaboration.reason.syncInternalsNotExposed",
  "no-replica-sync-failure-record-in-lifecycle-read": "collaboration.reason.noSyncFailureRecord",
  "node-registry-not-queried": "collaboration.reason.registryNotQueried",
  "center-replica-ledger-has-no-row-for-node": "collaboration.reason.noReplicaRow",
  authorization_denied: "collaboration.reason.authorizationDenied",
  insufficient_scope: "collaboration.reason.insufficientScope",
};
/** 值域里的 daemon 标记串(如 owner 登记表查无此人)→ 人话;标记串进 title。 */
const VALUE_LABELS: Readonly<Record<string, MessageKey>> = {
  "not-in-registry": "collaboration.ownerNotRegistered",
};
/** notes 的 key 前缀(key=value 形态)→ 人话;整条声明串进 title。 */
const NOTE_LABELS: Readonly<Record<string, MessageKey>> = {
  "events-attribution": "collaboration.note.eventsAttribution",
  "edge-online": "collaboration.note.edgeOnline",
  "sync-internals": "collaboration.note.syncInternals",
};
/** warnings 的 key 前缀(key: detail 形态)→ 人话;整条 warning 串(含 detail)进 title。 */
const WARNING_LABELS: Readonly<Record<string, MessageKey>> = {
  "node-owner-registry-unavailable": "collaboration.warning.ownerRegistryUnavailable",
};
/** 整页读拒绝收据的稳定 code → 人话(与字段级裁剪共用 code 但措辞面向整页);码进 title/data-reason。 */
export const READ_ERROR_LABELS: Readonly<Record<string, MessageKey>> = {
  authorization_denied: "collaboration.readError.authorizationDenied",
  insufficient_scope: "collaboration.readError.insufficientScope",
  authentication_required: "collaboration.readError.authenticationRequired",
};

export function reasonText(reason: string): string {
  const message = REASON_LABELS[reason];
  return message === undefined ? t("collaboration.reason.unknown") : t(message);
}

export function noteLabel(note: string): string {
  const message = NOTE_LABELS[note.split("=", 1)[0] ?? ""];
  // 未识别的 daemon 声明原样保留:静默丢弃比露出更不诚实。
  return message === undefined ? note : t(message);
}

export function warningLabel(warning: string): string {
  const message = WARNING_LABELS[warning.split(":", 1)[0] ?? ""];
  return message === undefined ? warning : t(message);
}

export function fieldText(state: FleetFieldState): string {
  if (state.kind === "value") {
    const message = VALUE_LABELS[state.text];
    return message === undefined ? state.text : t(message);
  }
  return state.kind === "redacted" ? t("collaboration.noPermissionShort") : t("collaboration.notProvided");
}

/** 机器可断言的原始码(值标记或原因码);普通值无标记,返回 undefined 不占属性。 */
export function machineOf(state: FleetFieldState): string | undefined {
  return state.kind === "value" ? (VALUE_LABELS[state.text] === undefined ? undefined : state.text) : state.reason;
}

export type FleetLeaseRowView = Exclude<FleetOverviewNode["leases"], { readonly redacted: string }>[number];
