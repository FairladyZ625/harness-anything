import { useMemo, useState } from "react";
import type { WorkBrief, WorkBriefSentencePart } from "../../../api/renderer-dto.ts";
import { t } from "../../i18n/index.tsx";
import { type AwaitsPanelSubject } from "../../awaits-answer.ts";
import { AwaitsAnswerPanel } from "../../components/AwaitsAnswerPanel.tsx";
import { STATUS_META } from "../../components/badges.tsx";
import type { SnapshotStatus } from "../../model/types.ts";
import { DenseRow, RowTime } from "../../components/primitives/DenseRow.tsx";
import { Drawer } from "../../components/primitives/Drawer.tsx";
import { Empty } from "../../components/primitives/Empty.tsx";
import { PageHeader } from "../../components/primitives/PageHeader.tsx";
import { Region } from "../../components/primitives/Region.tsx";
import { StatusTag, type StatusTone } from "../../components/primitives/StatusTag.tsx";
import { useWorkBriefsQuery } from "./my-asks-data.ts";

/**
 * 重构区「你交代的事」页(task_a3ffd5ceb;dec_C612E69B7C7E3480A5F9D2CAD3 CH1)。每行一件
 * 业主交代的事(一个工作根),只有三样:标题、状态、一句人话说明——全部由 daemon 读面
 * `repo.works.briefs.read` 从台账数据算出,GUI 只做本地化,不复制推导。排序等你在最上,
 * 其次卡住、在做;已完成折叠且只留近 7 天(过滤在读面)。首屏不出现 ID、revision 与计数
 * 统计;点行进单层抽屉看其下任务、PR 与评审,能就地办的(答复)直接开答复面板。
 */
export function MyAsksView({
  repoId,
  onOpenTask,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly onOpenTask: (taskId: string) => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const briefsQuery = useWorkBriefsQuery(repoId),
    [detail, setDetail] = useState<WorkBrief | null>(null),
    [panel, setPanel] = useState<AwaitsPanelSubject | null>(null),
    [doneOpen, setDoneOpen] = useState(false);
  const briefs = useMemo(() => briefsQuery.data?.briefs ?? [], [briefsQuery.data]),
    openBriefs = briefs.filter(({ bucket }) => bucket !== "done"),
    doneBriefs = briefs.filter(({ bucket }) => bucket === "done");

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-testid="my-asks-view">
      <PageHeader title={t("views.myAsks.title")} note={t("views.myAsks.note")} testId="my-asks-header" />
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-1" data-testid="my-asks-board">
        {briefsQuery.error instanceof Error ? (
          <p role="alert" className="px-3.5 py-2 text-sm text-danger">
            {t("views.myAsks.readError", { message: briefsQuery.error.message })}
          </p>
        ) : briefsQuery.data === undefined ? (
          <p className="px-3.5 py-2 text-sm text-text-muted">{t("views.myAsks.loading")}</p>
        ) : (
          <>
            <Region title={t("views.myAsks.regionOpen")}>
              {openBriefs.length === 0 ? (
                <div className="px-3.5 py-2">
                  <Empty>{t("views.myAsks.emptyOpen")}</Empty>
                </div>
              ) : (
                <div data-testid="my-asks-rows">
                  {openBriefs.map((brief) => (
                    <div key={brief.taskId} data-testid={`my-asks-row-${brief.taskId}`}>
                      <DenseRow
                        relaxed
                        tag={<StatusTag tone={BUCKET_TONE[brief.bucket]} label={t(BUCKET_LABEL[brief.bucket])} />}
                        title={brief.title}
                        reason={sentenceOf(brief.sentenceParts)}
                        onClick={() => setDetail(brief)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Region>
            {doneBriefs.length > 0 ? (
              <Region
                title={t("views.myAsks.regionDone")}
                footer={
                  <button
                    type="button"
                    data-testid="my-asks-done-toggle"
                    onClick={() => setDoneOpen((open) => !open)}
                    className="ml-auto text-accent underline-offset-2 hover:underline"
                  >
                    {doneOpen ? t("views.myAsks.doneCollapse") : t("views.myAsks.doneExpand")}
                  </button>
                }
              >
                {doneOpen ? (
                  <div data-testid="my-asks-done-rows">
                    {doneBriefs.map((brief) => (
                      <div key={brief.taskId} data-testid={`my-asks-row-${brief.taskId}`}>
                        <DenseRow
                          relaxed
                          tag={<StatusTag tone="done" label={t("views.myAsks.bucketDone")} />}
                          title={brief.title}
                          reason={sentenceOf(brief.sentenceParts)}
                          time={brief.deliveredAt === null ? undefined : <RowTime at={brief.deliveredAt} />}
                          onClick={() => setDetail(brief)}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="px-3.5 py-2">
                    <Empty>{t("views.myAsks.doneFolded")}</Empty>
                  </div>
                )}
              </Region>
            ) : null}
          </>
        )}
      </div>

      {/* 单层抽屉:这件事之下的等待提问、任务、PR 与评审;再往下走完整任务详情。 */}
      <Drawer open={detail !== null} onClose={() => setDetail(null)} ariaLabel={detail?.title}>
        {detail !== null ? (
          <BriefDetail brief={detail} onOpenTask={onOpenTask} onAnswer={(ask) => setPanel(ask)} />
        ) : null}
      </Drawer>

      {panel ? (
        <AwaitsAnswerPanel
          repoId={repoId}
          subject={panel}
          onClose={() => setPanel(null)}
          onNavigateEntity={(ref) => {
            setPanel(null);
            onNavigateEntity(ref);
          }}
        />
      ) : null}
    </div>
  );
}

const BUCKET_LABEL = {
    waiting: "views.myAsks.bucketWaiting",
    stuck: "views.myAsks.bucketStuck",
    running: "views.myAsks.bucketRunning",
    unclear: "views.myAsks.bucketUnclear",
    done: "views.myAsks.bucketDone",
  } as const,
  BUCKET_TONE: Record<keyof typeof BUCKET_LABEL, StatusTone> = {
    waiting: "wait",
    stuck: "bad",
    running: "active",
    unclear: "neutral",
    done: "done",
  },
  ASK_VERB = {
    question: "views.myAsks.askQuestion",
    acceptance: "views.myAsks.askAcceptance",
    consent: "views.myAsks.askConsent",
    reopen: "views.myAsks.askReopen",
  } as const,
  TASK_TONE: Record<string, StatusTone> = {
    planned: "plan",
    active: "active",
    submitted: "wait",
    in_review: "wait",
    blocked: "bad",
    done: "done",
    cancelled: "cancel",
  };

/** 抽屉任务行的状态词:同一份 STATUS_META 词汇,读时取词随 locale 切换。 */
function taskStatusLabel(status: string): string {
  return STATUS_META[status as SnapshotStatus]?.label ?? status;
}

/** 分句次序由 daemon 定;这里只把每个分句翻成当前语言,用「;」连成一句。 */
function sentenceOf(parts: readonly WorkBriefSentencePart[]): string {
  const clauses = parts.map((part) => {
    switch (part.kind) {
      case "ask":
        return t("views.myAsks.partAsk", { title: part.title, verb: t(ASK_VERB[part.askKind]) });
      case "blocked":
        return t("views.myAsks.partBlocked", { title: part.title });
      case "executing":
        return t("views.myAsks.partExecuting", { title: part.title });
      case "review":
        return t("views.myAsks.partReview", { title: part.title });
      case "planned":
        return t("views.myAsks.partPlanned");
      case "delivered":
        return t("views.myAsks.partDelivered", { title: part.title });
      case "retired":
        return t("views.myAsks.partRetired");
    }
  });
  return clauses.length > 0 ? clauses.join(t("views.myAsks.partJoin")) : t("views.myAsks.sentenceUnknown");
}

function BriefDetail({
  brief,
  onOpenTask,
  onAnswer,
}: {
  readonly brief: WorkBrief;
  readonly onOpenTask: (taskId: string) => void;
  readonly onAnswer: (subject: AwaitsPanelSubject) => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-testid="my-asks-drawer">
      <StatusTag tone={BUCKET_TONE[brief.bucket]} label={t(BUCKET_LABEL[brief.bucket])} />
      <h2 className="ui-title text-text">{brief.title}</h2>
      <p className="ui-meta text-text-muted">{sentenceOf(brief.sentenceParts)}</p>
      {brief.asks.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">{t("views.myAsks.drawerAsks")}</h3>
          {brief.asks.map((ask) => (
            <div key={ask.relationId} className="rounded-xs border border-border px-3 py-2">
              <p className="text-sm text-text">{ask.question}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid={`my-asks-answer-${ask.relationId}`}
                  onClick={() => onAnswer({ mode: "answer", row: ask })}
                  className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
                >
                  {t("views.myAsks.actionAnswer")}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenTask(ask.sourceRef.replace(/^task\//u, ""))}
                  className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
                >
                  {t("views.myAsks.actionOpenTask")}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}
      {brief.openTasks.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">{t("views.myAsks.drawerTasks")}</h3>
          {brief.openTasks.map((task) => (
            <DenseRow
              key={task.taskId}
              tag={<StatusTag tone={TASK_TONE[task.status] ?? "neutral"} label={taskStatusLabel(task.status)} />}
              title={task.title}
              time={<RowTime at={task.updatedAt} />}
              onClick={() => onOpenTask(task.taskId)}
            />
          ))}
        </section>
      ) : null}
      {brief.deliveredTasks.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">
            {t("views.myAsks.drawerDelivered")}
          </h3>
          {brief.deliveredTasks.map((task) => (
            <DenseRow
              key={task.taskId}
              tag={<StatusTag tone="done" label={taskStatusLabel(task.status)} />}
              title={task.title}
              time={<RowTime at={task.updatedAt} />}
              onClick={() => onOpenTask(task.taskId)}
            />
          ))}
        </section>
      ) : null}
      {brief.pullRequests.length > 0 ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="font-mono ui-meta uppercase tracking-wide text-text-faint">{t("views.myAsks.drawerPulls")}</h3>
          {brief.pullRequests.map((pull) => (
            <DenseRow
              key={`${pull.taskId}:${pull.branch}`}
              tag={
                <StatusTag
                  tone={pull.pass === false ? "bad" : pull.pass === true ? "done" : "neutral"}
                  label={
                    pull.pass === null
                      ? t("views.myAsks.ciPending")
                      : pull.pass
                        ? t("views.myAsks.ciPass")
                        : t("views.myAsks.ciFail")
                  }
                />
              }
              title={
                pull.prNumber === null ? pull.branch : t("views.myAsks.prTitle", { number: String(pull.prNumber) })
              }
              hoverTitle={pull.branch}
              time={<RowTime at={pull.occurredAt} />}
              onClick={() => onOpenTask(pull.taskId)}
            />
          ))}
        </section>
      ) : null}
      <div className="mt-1">
        <button
          type="button"
          data-testid="my-asks-drawer-open-work"
          onClick={() => onOpenTask(brief.taskId)}
          className="h-7 rounded-xs border border-border bg-text/10 px-3 text-text-muted ui-meta hover:text-text"
        >
          {t("views.myAsks.actionOpenWork")}
        </button>
      </div>
    </div>
  );
}
