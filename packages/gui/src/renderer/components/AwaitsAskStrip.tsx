import { useState } from "react";
import { ChatCircleDots } from "@phosphor-icons/react";
import { useAgendaQuery } from "../agenda-data.ts";
import { AWAITS_KIND_LABEL, type AwaitsPanelSubject } from "../awaits-answer.ts";
import { t } from "../i18n/index.tsx";
import { AwaitsAnswerPanel } from "./AwaitsAnswerPanel.tsx";

/**
 * 任务 / 决策详情里的「等你答复」条:同一条 agenda 读面(与总览共用缓存)里挂在本实体上、
 * 指向你的 active awaits 边与你名下的已答复边,点开即同一个答复面板。
 */
export function AwaitsAskStrip({
  repoId,
  sourceRef,
  onNavigateEntity,
}: {
  readonly repoId: string;
  readonly sourceRef: string;
  readonly onNavigateEntity: (ref: string) => void;
}) {
  const agenda = useAgendaQuery(repoId).data,
    [panel, setPanel] = useState<AwaitsPanelSubject | null>(null),
    subjects: AwaitsPanelSubject[] = [
      ...(agenda?.awaitingYou ?? [])
        .filter((row) => row.sourceRef === sourceRef)
        .map((row) => ({ mode: "answer" as const, row })),
      ...(agenda?.answeredForYou ?? [])
        .filter((row) => row.sourceRef === sourceRef)
        .map((row) => ({ mode: "answered" as const, row })),
    ];
  if (subjects.length === 0) return null;
  return (
    <div className="shrink-0 space-y-1 border-b border-border bg-accent/[0.06] px-3 py-1.5 lg:px-4">
      {subjects.map((subject) => (
        <button
          key={subject.row.relationId}
          type="button"
          data-testid={`awaits-ask-strip-${subject.row.relationId}`}
          onClick={() => setPanel(subject)}
          className="flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-surface-raised"
        >
          <ChatCircleDots weight="bold" className="shrink-0 text-accent" aria-hidden />
          <span className="shrink-0 font-mono ui-micro text-accent">
            {subject.mode === "answer"
              ? t("components.awaitsAnswer.awaitingYou")
              : t("components.awaitsAnswer.answeredForYou")}{" "}
            · {AWAITS_KIND_LABEL[subject.row.askKind]()}
          </span>
          <span className="min-w-0 flex-1 truncate ui-meta text-text">
            {subject.mode === "answer" ? subject.row.question : subject.row.answer}
          </span>
          <span className="shrink-0 rounded border border-accent/40 px-1.5 font-mono ui-micro text-accent">
            {subject.mode === "answer" ? t("components.awaitsAnswer.openAnswer") : t("components.awaitsAnswer.answer")}
          </span>
        </button>
      ))}
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
