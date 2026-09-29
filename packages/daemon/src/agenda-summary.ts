import type {
  AgendaAnsweredRow,
  AgendaAwaitsRow,
  AgendaDecisionRow,
  AgendaExecutionRow,
  AgendaTaskRow,
  DaemonAgendaResult,
} from "./protocol/daemon-protocol.contract.ts";

export type AgendaCursorKey = "active" | "blocked" | "planned" | "submitted" | "inReview";
export type AgendaCursor = Readonly<
  Record<AgendaCursorKey | "decisions" | "awaitingYou" | "answeredForYou", string | null>
>;

export function decodeAgendaCursor(value: string): AgendaCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("agenda cursor is invalid");
  }
  const keys = [
    "active",
    "blocked",
    "planned",
    "submitted",
    "inReview",
    "decisions",
    "awaitingYou",
    "answeredForYou",
  ] as const;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(parsed, key) ||
        ((parsed as Record<string, unknown>)[key] !== null &&
          (typeof (parsed as Record<string, unknown>)[key] !== "string" || !(parsed as Record<string, string>)[key])),
    )
  )
    throw new Error("agenda cursor is invalid");
  return parsed as AgendaCursor;
}

export function encodeAgendaCursor(value: AgendaCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function renderAgendaSummary(
  groups: Pick<
    DaemonAgendaResult,
    | "pinnedEntities"
    | "pinnedEntityOverflow"
    | "awaitingYou"
    | "answeredForYou"
    | "attentionItems"
    | "inFlight"
    | "awaitingRework"
    | "awaitingAdjudication"
    | "underReview"
    | "decisionReviewInProgress"
    | "awaitingDecisionReview"
    | "awaitingDecision"
    | "waitingOnOthers"
    | "dispatchable"
  >,
): string {
  const workLabel = (row: AgendaTaskRow | AgendaExecutionRow) => (row.work ? ` [工作 ${row.work.title}]` : ""),
    attentionLine = (row: DaemonAgendaResult["attentionItems"][number], index: number) =>
      `${index + 1}. [${row.attention.score}] ${row.title} — ${row.attention.reasons.map(({ label, contribution }) => `${label} +${contribution}`).join("；")}`,
    blockerText = (blocker: AgendaTaskRow["blockingAssessment"]["blockers"][number]) =>
      blocker.kind === "awaits"
        ? `等 ${blocker.personId} ${blocker.askKind}: ${blocker.question}`
        : blocker.targetTaskId,
    taskLine = (row: AgendaTaskRow) =>
      `- ${row.pinned ? "📌 " : ""}${row.taskId} ${row.title}${workLabel(row)}${row.blockingAssessment.blockers.length ? `（阻塞: ${row.blockingAssessment.blockers.map(blockerText).join(", ")}）` : ""}` +
      (row.workspace?.kind === "worktree" ? `（worktree: ${row.workspace.path} ${row.workspace.state}）` : ""),
    awaitsLine = (row: AgendaAwaitsRow) =>
      `- [${row.askKind}] ${row.sourceRef} ${row.title} [${row.status}] — ${row.question}\n` +
      `  答复: ha relation unrelate ${row.relationId} --reason "<答复>" --expected-version ${row.relationRevision}` +
      `（或在 GUI 总览「等你答复」就地答复）`,
    answeredLine = (row: AgendaAnsweredRow) => {
      const [kind, id] = row.sourceRef.split("/");
      return (
        `- [${row.askKind}] ${row.sourceRef} ${row.title} [${row.status}] — 问: ${row.question}\n` +
        `  答（${row.answeredBy} @ ${row.answeredAt}）: ${row.answer}\n` +
        `  下一步: ha ${kind} show ${id}，据答复在源上继续（进度、状态或裁决）；源上一有写入即出列\n` +
        `  再次提问: ha relation relate --source-ref ${row.sourceRef} --target-ref person/${row.personId} ` +
        `--type awaits --rationale "<kind>: <新问题>" --expected-version <这条边的 revision：ha relation list 行里 id 后那一列>`
      );
    },
    executionLine = (row: AgendaExecutionRow) =>
      `- ${row.pinned ? "📌 " : ""}execution ${row.executionId} / ${row.taskId} ${row.title}${workLabel(row)}`,
    decisionLine = (row: AgendaDecisionRow) => `- decision ${row.decisionId} ${row.title}`,
    section = (title: string, filter: string, rows: readonly string[], total = rows.length) =>
      `${title} (${total}) — ${filter}\n${rows.length ? rows.join("\n") : "- 无"}`;
  return [
    section(
      "注意力顺序（前 7 条）",
      "daemon 中心打分；CLI 与 GUI 使用同一顺序",
      groups.attentionItems.slice(0, 7).map(attentionLine),
      groups.attentionItems.length,
    ),
    section(
      "📌 重点关注",
      "仓库级 Entity Pin（服从 --limit）",
      [
        ...groups.pinnedEntities.map(
          (row) => `- 📌 [${row.kind[0]?.toUpperCase()}${row.kind.slice(1)}] ${row.ref} ${row.title} [${row.status}]`,
        ),
        ...(groups.pinnedEntityOverflow ? [`- …另有 ${groups.pinnedEntityOverflow} 项已折叠`] : []),
      ],
      groups.pinnedEntities.length + groups.pinnedEntityOverflow,
    ),
    section(
      "等你处理",
      "指向你的 active awaits 边（question/acceptance/consent/reopen）；答复即 retire 该边，答复内容写进 --reason；答复后提问方可对同一对端点再次 relate 重新发起",
      groups.awaitingYou.map(awaitsLine),
    ),
    section(
      "已答复，待你跟进",
      "你名下（task 创建者 / decision 提案者）已被答复退役的 awaits 边；答复后源实体一有写入即出列",
      groups.answeredForYou.map(answeredLine),
    ),
    section(
      "Decision 评审中",
      "当前 reviewContentDigest 已有在飞 reviewer；只需等，或按 dispatch 回执查看 runtime",
      groups.decisionReviewInProgress.map(decisionLine),
    ),
    section(
      "待评审 Decision",
      "当前策略要求独立评审；下一步 ha decision dispatch-review <id>",
      groups.awaitingDecisionReview.map(decisionLine),
    ),
    section(
      "待裁 Decision",
      "当前切面可裁决（有效批准或策略免审）；提案人仍需独立判断，下一步 ha decision accept|reject|defer",
      groups.awaitingDecision.map(decisionLine),
    ),
    section("在飞线", "status=active 且（有 lease 或有 active execution）；只需等", groups.inFlight.map(taskLine)),
    section(
      "等我修",
      "status=active 且最新 execution=changes_requested 且无 lease、无 active execution；下一步 ha task start <taskId> 重开执行",
      groups.awaitingRework.map(taskLine),
    ),
    section(
      "待派审",
      "status=submitted 且有 submitted execution；下一步 ha task adjudicate --forward",
      groups.awaitingAdjudication.map(executionLine),
    ),
    section(
      "评审中",
      "status=in_review 且有未被 approved 覆盖的 submitted execution；评审报告就绪后 ha task review-consent，评审未出只需等",
      groups.underReview.map(executionLine),
    ),
    section(
      "球在别人手里",
      "status=blocked 或 blocking 非 clear（含 active awaits）；只需等",
      groups.waitingOnOthers.map(taskLine),
    ),
    section("可派队列", "status=planned 且 blocking=clear；下一步 ha runtime run", groups.dispatchable.map(taskLine)),
  ].join("\n\n");
}
