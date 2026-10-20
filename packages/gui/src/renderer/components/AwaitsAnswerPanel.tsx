import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChatCircleDots, CheckCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { agendaQueryKeys } from "../agenda-data.ts";
import {
  AWAITS_CHOICES,
  AWAITS_KIND_LABEL,
  composeAwaitsAnswer,
  useAwaitsAnswer,
  type AwaitsChoice,
  type AwaitsPanelSubject,
} from "../awaits-answer.ts";
import { t } from "../i18n/index.tsx";
import { formatTime } from "../model/time.ts";
import { EntityRefLink } from "./EntityRefLink.tsx";
import { ApprovalCard, type ApprovalDecision, type ApprovalRisk } from "./agent-ui/ApprovalCard.tsx";
import { Button } from "./primitives/Button.tsx";

const timeOf = (iso: string) => formatTime(iso, { style: "month-day-time" }) ?? iso;

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 font-mono ui-meta uppercase tracking-wide text-text-faint">{title}</div>
      {children}
    </section>
  );
}

/**
 * 「等你答复」面板(dec_DF67F23066BAFE444190A191B5):点开一条就看到谁问的、问的哪类事、
 * 原话与要你做什么,并按类型就地答复。答复 = 以当前 GUI 使用者身份 retire 这条 awaits 边,
 * 答复原文进 retire 理由;已答复(提问方跟进)模式只读,给出答复与来源链接。
 * 接入 ApprovalCard 统一风险徽标、预览与已裁决 FLIP 动效,统一采用 agent-question 语义。
 */
export function AwaitsAnswerPanel({
  repoId,
  subject,
  onClose,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly subject: AwaitsPanelSubject;
  readonly onClose: () => void;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  const row = subject.row;
  return createPortal(
    <div className="fixed inset-0 z-40 flex justify-end bg-bg/45" data-testid="awaits-answer-panel">
      <aside
        role="dialog"
        aria-label={t("components.awaitsAnswer.title")}
        className="glass glass-overlay flex h-full w-full max-w-[560px] flex-col border-l shadow-2xl shadow-black/40"
      >
        <header className="border-b border-border px-4 py-3">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className="rounded-md border border-agent-question-border bg-agent-question-surface px-1.5 py-0.5 font-mono ui-micro text-agent-question"
                  data-testid="awaits-answer-kind"
                >
                  {AWAITS_KIND_LABEL[row.askKind]()}
                </span>
                <span className="font-mono ui-micro text-text-faint">
                  {subject.mode === "answer"
                    ? t("components.awaitsAnswer.modeAnswer")
                    : t("components.awaitsAnswer.modeAnswered")}
                </span>
              </div>
              <h2 className="mt-2 flex items-start gap-2 ui-heading font-semibold leading-tight text-text">
                <ChatCircleDots weight="bold" className="mt-1 shrink-0 text-agent-question" aria-hidden />
                {row.title}
              </h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              ariaLabel={t("components.awaitsAnswer.close")}
              testId="awaits-answer-close-header"
            >
              <X weight="bold" />
            </Button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 font-mono ui-micro text-text-faint">
            <span className="flex min-w-0 items-center gap-1">
              {t("components.awaitsAnswer.source")}
              <EntityRefLink
                entityRef={row.sourceRef}
                onNavigate={onNavigateEntity}
                className="text-accent hover:underline"
              />
            </span>
            <span>{t("components.awaitsAnswer.sourceStatus", { status: row.status })}</span>
            {subject.mode === "answer" ? (
              <>
                <span>{t("components.awaitsAnswer.askedBy", { actor: subject.row.askedBy })}</span>
                <span>{t("components.awaitsAnswer.askedAt", { time: timeOf(subject.row.askedAt) })}</span>
              </>
            ) : (
              <span>{t("components.awaitsAnswer.askedPerson", { personId: subject.row.personId })}</span>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Section title={t("components.awaitsAnswer.question")}>
            <p className="whitespace-pre-wrap ui-prose leading-relaxed text-text" data-testid="awaits-answer-question">
              {row.question}
            </p>
          </Section>
          {subject.mode === "answer" ? (
            <div className="p-4">
              <AnswerForm repoId={repoId} row={subject.row} onClose={onClose} />
            </div>
          ) : (
            <>
              <Section title={t("components.awaitsAnswer.answer")}>
                <p
                  className="whitespace-pre-wrap ui-prose leading-relaxed text-text"
                  data-testid="awaits-answer-answer"
                >
                  {subject.row.answer}
                </p>
                <p className="mt-2 font-mono ui-micro text-text-faint">
                  {t("components.awaitsAnswer.answeredBy", {
                    actor: subject.row.answeredBy,
                    time: timeOf(subject.row.answeredAt),
                  })}
                </p>
              </Section>
              <Section title={t("components.awaitsAnswer.followUp")}>
                <p className="ui-body leading-relaxed text-text-muted">{t("components.awaitsAnswer.followUpHint")}</p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onNavigateEntity(row.sourceRef)}
                  testId="awaits-answer-open-source"
                >
                  {t("components.awaitsAnswer.openSource")}
                </Button>
              </Section>
              <Section title={t("components.awaitsAnswer.reask")}>
                <p className="ui-body leading-relaxed text-text-muted">{t("components.awaitsAnswer.reaskHint")}</p>
                {/* 与 `ha agenda` 已答复行的「再次提问」同一条命令:在同一来源上向同一个人新建 awaits。 */}
                <code
                  data-testid="awaits-answer-reask"
                  className="mt-2 block select-all whitespace-pre-wrap break-all rounded-md border border-border bg-surface px-2 py-1 font-mono ui-micro text-text"
                >
                  {`ha relation relate --source-ref ${row.sourceRef} --target-ref person/${row.personId} --type awaits --rationale "<kind>: <新问题>" --expected-version <revision>`}
                </code>
              </Section>
            </>
          )}
          <Section title={t("components.awaitsAnswer.channels")}>
            <p className="ui-micro leading-relaxed text-text-faint">{t("components.awaitsAnswer.channelsHint")}</p>
          </Section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function AnswerForm({
  repoId,
  row,
  onClose,
}: {
  readonly repoId: string;
  readonly row: Extract<AwaitsPanelSubject, { mode: "answer" }>["row"];
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient(),
    { feedback, submit } = useAwaitsAnswer(repoId),
    choices = AWAITS_CHOICES[row.askKind],
    [choice, setChoice] = useState<AwaitsChoice | null>(null),
    [comment, setComment] = useState(""),
    reason = composeAwaitsAnswer(choices.length ? choice : null, comment),
    pending = feedback?.state === "pending",
    done = feedback?.state === "success",
    ready = (choices.length === 0 || choice !== null) && reason.length > 0 && !pending && !done;

  const risk: ApprovalRisk = row.askKind === "consent" ? "protected" : row.askKind === "acceptance" ? "high" : "medium";

  const decidedState: ApprovalDecision | null = done
    ? {
        verdict: "approved",
        at: new Date().toISOString(),
        reason: "user",
      }
    : null;

  return (
    <div className="flex flex-col gap-3">
      <ApprovalCard
        title={row.title}
        summary={t(`components.awaitsAnswer.todo.${row.askKind}`)}
        risk={risk}
        previewLines={[row.question]}
        previewKind="changes"
        decided={decidedState}
        testId="awaits-approval-card"
        hideDefaultActions
      >
        <div className="flex flex-col gap-2.5 pt-1">
          {choices.length > 0 && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("components.awaitsAnswer.reply")}>
              {choices.map((item) => (
                <Button
                  key={item.id}
                  size="sm"
                  variant={choice?.id === item.id ? (item.tone === "danger" ? "danger" : "primary") : "plain"}
                  disabled={pending || done}
                  testId={`awaits-answer-choice-${item.id}`}
                  onClick={() => setChoice(item)}
                >
                  {item.label()}
                </Button>
              ))}
            </div>
          )}
          <label className="block ui-micro font-semibold text-text-muted">
            {t(`components.awaitsAnswer.commentLabel.${row.askKind}`)}
            <textarea
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={t(`components.awaitsAnswer.commentPlaceholder.${row.askKind}`)}
              rows={4}
              disabled={pending || done}
              data-testid="awaits-answer-comment"
              className="mt-1 w-full rounded-md border border-border bg-surface p-2 ui-meta font-normal leading-relaxed text-text outline-none transition-colors duration-100 focus:border-accent"
            />
          </label>
          {reason ? (
            <p className="font-mono ui-micro text-text-faint" data-testid="awaits-answer-preview">
              {t("components.awaitsAnswer.preview", { reason })}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            {!done && (
              <Button
                variant="primary"
                size="sm"
                disabled={!ready}
                testId="awaits-answer-submit"
                onClick={() => void submit(row, reason)}
              >
                {pending ? t("components.awaitsAnswer.submitting") : t("components.awaitsAnswer.submit")}
              </Button>
            )}
          </div>
        </div>
      </ApprovalCard>

      {feedback && feedback.state !== "pending" && (
        <div
          role="status"
          data-testid="awaits-answer-feedback"
          data-state={feedback.state}
          className={`flex items-start gap-1.5 rounded-md border px-2 py-1.5 ui-micro ${
            feedback.state === "success" ? "border-accent/40 text-accent" : "border-danger/40 text-danger"
          }`}
        >
          {feedback.state === "success" ? (
            <CheckCircle weight="bold" className="mt-0.5 shrink-0" aria-hidden />
          ) : (
            <WarningCircle weight="bold" className="mt-0.5 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 break-words">
            {feedback.hint}
            {feedback.code ? <span className="ml-1 font-mono">({feedback.code})</span> : null}
          </span>
        </div>
      )}

      <div className="flex justify-end gap-2">
        {feedback?.state === "conflict" && (
          <Button
            variant="ghost"
            size="sm"
            testId="awaits-answer-refresh"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: agendaQueryKeys.read(repoId) });
              onClose();
            }}
          >
            {t("components.awaitsAnswer.refresh")}
          </Button>
        )}
        {done && (
          <Button variant="ghost" size="sm" onClick={onClose} testId="awaits-answer-close-done">
            {t("components.awaitsAnswer.close")}
          </Button>
        )}
      </div>
    </div>
  );
}
