import { useState } from "react";
import type { AgendaAwaitsRow } from "../../../api/renderer-dto.ts";
import { AWAITS_CHOICES, composeAwaitsAnswer, useAwaitsAnswer, type AwaitsChoice } from "../../awaits-answer.ts";
import { Button } from "../../components/primitives/Button.tsx";
import { SegCtl } from "../../components/primitives/SegCtl.tsx";
import { BoundedContent } from "../../components/primitives/BoundedContent.tsx";
import { t } from "../../i18n/index.tsx";

/** Same answer composition, validation and versioned mutation as AwaitsAnswerPanel, in the selected card. */
export function AgendaInboxAnswer({ repoId, row }: { readonly repoId: string; readonly row: AgendaAwaitsRow }) {
  const { feedback, submit } = useAwaitsAnswer(repoId);
  const [choice, setChoice] = useState<AwaitsChoice | null>(null);
  const [comment, setComment] = useState("");
  const choices = AWAITS_CHOICES[row.askKind];
  const reason = composeAwaitsAnswer(choices.length ? choice : null, comment);
  const pending = feedback?.state === "pending";
  const done = feedback?.state === "success";
  const ready = (choices.length === 0 || choice !== null) && reason.length > 0 && !pending && !done;
  return (
    <form
      aria-label={row.question}
      className="flex min-w-0 flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) void submit(row, reason);
      }}
    >
      <BoundedContent>
        <p className="whitespace-pre-wrap break-words ui-body text-text">{row.question}</p>
      </BoundedContent>
      {choices.length > 0 && (
        <SegCtl
          value={choice?.id ?? null}
          label={t("components.awaitsAnswer.reply")}
          disabled={pending || done}
          options={choices.map((item) => ({
            value: item.id,
            label: item.label(),
            testId: `agenda-answer-choice-${item.id}`,
          }))}
          onChange={(id) => setChoice(choices.find((item) => item.id === id) ?? null)}
        />
      )}
      <label className="ui-meta text-text-muted">
        {t(`components.awaitsAnswer.commentLabel.${row.askKind}`)}
        <textarea
          aria-label={t(`components.awaitsAnswer.commentLabel.${row.askKind}`)}
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          rows={3}
          disabled={pending || done}
          data-testid="agenda-answer-comment"
          className="mt-1 block w-full rounded-sm border border-border bg-surface p-2 text-text focus:border-accent"
        />
      </label>
      <Button
        variant="primary"
        size="sm"
        type="submit"
        disabled={!ready}
        loading={pending}
        testId="agenda-answer-submit"
      >
        {t("components.awaitsAnswer.submit")}
      </Button>
      {feedback && (
        <p
          role="status"
          data-testid="agenda-answer-feedback"
          data-state={feedback.state}
          className={`break-words ui-meta ${feedback.state === "error" || feedback.state === "conflict" ? "text-danger" : "text-text-muted"}`}
        >
          {feedback.hint}
        </p>
      )}
    </form>
  );
}
