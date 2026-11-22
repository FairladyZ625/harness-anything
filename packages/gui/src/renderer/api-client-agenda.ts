import type {
  AgendaRestartRow,
  AgendaTaskRow,
  AgendaExecutionRow,
  AgendaDecisionRow,
  AgendaDecisionReviewRow,
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaRulingRow,
  AgendaAttentionItem,
  AgendaRegionWeights,
} from "../api/renderer-dto.ts";
import type { AgendaSuccess } from "./api-client.ts";
import { isRendererRecord, localErrorHint } from "./result-validation.ts";

export function readAgendaResult(value: unknown): AgendaSuccess {
  const result = value as Partial<AgendaSuccess>;
  const validPage =
    result &&
    isRendererRecord(result.page) &&
    Number.isInteger(result.page.sourceLimit) &&
    (result.page.cursor === null || typeof result.page.cursor === "string") &&
    (result.page.nextCursor === null || typeof result.page.nextCursor === "string");
  if (
    !result ||
    result.ok !== true ||
    (result.status !== "ready" && result.status !== "pending") ||
    !Array.isArray(result.inFlight) ||
    !Array.isArray(result.pinnedEntities) ||
    !Number.isSafeInteger(result.pinnedEntityOverflow) ||
    !result.inFlight.every(isAgendaTaskRow) ||
    !Array.isArray(result.awaitingRestart) ||
    !result.awaitingRestart.every(isAgendaRestartRow) ||
    !Array.isArray(result.awaitingYou) ||
    !result.awaitingYou.every(isAgendaAwaitsRow) ||
    !Array.isArray(result.answeredForYou) ||
    !result.answeredForYou.every(isAgendaAnsweredRow) ||
    !Array.isArray(result.awaitingRework) ||
    !result.awaitingRework.every(isAgendaTaskRow) ||
    !Array.isArray(result.awaitingAdjudication) ||
    !result.awaitingAdjudication.every(isAgendaExecutionRow) ||
    !Array.isArray(result.underReview) ||
    !result.underReview.every(isAgendaExecutionRow) ||
    !Array.isArray(result.decisionReviewInProgress) ||
    !result.decisionReviewInProgress.every(isAgendaDecisionReviewRow) ||
    !Array.isArray(result.awaitingDecisionReview) ||
    !result.awaitingDecisionReview.every(isAgendaDecisionRow) ||
    !Array.isArray(result.awaitingDecision) ||
    !result.awaitingDecision.every(isAgendaDecisionRow) ||
    (result.awaitingRuling !== undefined &&
      (!Array.isArray(result.awaitingRuling) || !result.awaitingRuling.every(isAgendaRulingRow))) ||
    !Array.isArray(result.waitingOnOthers) ||
    !result.waitingOnOthers.every(isAgendaTaskRow) ||
    !Array.isArray(result.stalled) ||
    !result.stalled.every(isAgendaTaskRow) ||
    !Array.isArray(result.dispatchable) ||
    !result.dispatchable.every(isAgendaTaskRow) ||
    !Array.isArray(result.attentionItems) ||
    !result.attentionItems.every(isAgendaAttentionItem) ||
    !isRegionWeights(result.regionWeights) ||
    typeof result.summary !== "string" ||
    !validPage ||
    !Number.isInteger(result.watermark) ||
    !Number.isInteger(result.sourceRevision)
  )
    throw new Error(localErrorHint(value, "Agenda bridge returned an invalid result."));
  return result as AgendaSuccess;
}

/** 注意力行(S1)同样只验形状:分数与原因的推导全在 daemon。 */
function isAgendaAttentionItem(value: unknown): value is AgendaAttentionItem {
  return (
    isRendererRecord(value) &&
    typeof value.ref === "string" &&
    typeof value.title === "string" &&
    typeof value.kind === "string" &&
    typeof value.region === "string" &&
    (value.workTaskId === null || typeof value.workTaskId === "string") &&
    isRendererRecord(value.attention) &&
    typeof value.attention.score === "number" &&
    Array.isArray(value.attention.reasons) &&
    value.attention.reasons.every(
      (reason) =>
        isRendererRecord(reason) && typeof reason.label === "string" && typeof reason.contribution === "number",
    )
  );
}

/** 区域权重:七个区域各一个有限数(空区域为 0,布局算法按 0 剔除)。 */
function isRegionWeights(value: unknown): value is AgendaRegionWeights {
  if (!isRendererRecord(value)) return false;
  return ["mine", "stuck", "run", "review", "queue", "recent", "works"].every(
    (key) => typeof value[key] === "number" && Number.isFinite(value[key]),
  );
}

/** 分组判据不在 renderer 重建:这里只验形状,分组语义全部来自 daemon 投影。 */
function isAgendaTaskRow(value: unknown): value is AgendaTaskRow {
  return (
    isRendererRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.pinned === "boolean" &&
    typeof value.updatedAt === "string" &&
    (value.leaseExecutionId === null || typeof value.leaseExecutionId === "string") &&
    Array.isArray(value.activeExecutionIds) &&
    value.activeExecutionIds.every((id) => typeof id === "string") &&
    isRendererRecord(value.blockingAssessment)
  );
}

function isAgendaRestartRow(value: unknown): value is AgendaRestartRow {
  return isAgendaTaskRow(value) && isRendererRecord(value) && typeof value.next === "string" && value.next.length > 0;
}

function isAgendaExecutionRow(value: unknown): value is AgendaExecutionRow {
  return (
    isRendererRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    typeof value.pinned === "boolean" &&
    typeof value.executionId === "string" &&
    typeof value.submittedAt === "string" &&
    isRendererRecord(value.blockingAssessment)
  );
}

/** 等业主裁决行:问题与选项原文是它的全部信息量,缺任一项即不是一行可答复的裁决。 */
function isAgendaRulingRow(value: unknown): value is AgendaRulingRow {
  return (
    isRendererRecord(value) &&
    typeof value.taskId === "string" &&
    typeof value.title === "string" &&
    (value.work === null || isRendererRecord(value.work)) &&
    typeof value.pinned === "boolean" &&
    typeof value.dispatchId === "string" &&
    typeof value.executionId === "string" &&
    (value.attention === "question" || value.attention === "guard") &&
    typeof value.question === "string" &&
    Array.isArray(value.options) &&
    value.options.every((option) => typeof option === "string") &&
    (value.rulingPath === undefined || typeof value.rulingPath === "string") &&
    typeof value.askedAt === "string" &&
    isRendererRecord(value.blockingAssessment)
  );
}

function isAgendaDecisionRow(value: unknown): value is AgendaDecisionRow {
  return (
    isRendererRecord(value) &&
    typeof value.decisionId === "string" &&
    typeof value.title === "string" &&
    ["low", "medium", "high"].includes(String(value.riskTier)) &&
    ["low", "medium", "high"].includes(String(value.urgency)) &&
    typeof value.proposedAt === "string"
  );
}

function isAgendaDecisionReviewRow(value: unknown): value is AgendaDecisionReviewRow {
  return (
    isRendererRecord(value) &&
    isAgendaDecisionRow(value) &&
    Array.isArray(value.reviewers) &&
    value.reviewers.every(
      (row) =>
        isRendererRecord(row) &&
        typeof row.dispatchId === "string" &&
        (row.reviewer === null || typeof row.reviewer === "string") &&
        (row.findingCount === null || Number.isSafeInteger(row.findingCount)),
    )
  );
}

function isAgendaAwaitsRow(value: unknown): value is AgendaAwaitsRow {
  return (
    isRendererRecord(value) &&
    typeof value.relationId === "string" &&
    Number.isSafeInteger(value.relationRevision) &&
    typeof value.sourceRef === "string" &&
    (value.wakeTaskId === undefined ||
      (typeof value.wakeTaskId === "string" &&
        value.wakeTaskId.length > 0 &&
        value.sourceRef === `task/${value.wakeTaskId}`)) &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.personId === "string" &&
    ["question", "acceptance", "consent", "reopen"].includes(String(value.askKind)) &&
    typeof value.question === "string" &&
    typeof value.askedAt === "string" &&
    typeof value.askedBy === "string"
  );
}

function isAgendaAnsweredRow(value: unknown): value is AgendaAnsweredRow {
  return (
    isRendererRecord(value) &&
    typeof value.relationId === "string" &&
    typeof value.sourceRef === "string" &&
    typeof value.title === "string" &&
    typeof value.status === "string" &&
    typeof value.personId === "string" &&
    ["question", "acceptance", "consent", "reopen"].includes(String(value.askKind)) &&
    typeof value.question === "string" &&
    typeof value.answer === "string" &&
    typeof value.answeredAt === "string" &&
    typeof value.answeredBy === "string"
  );
}
