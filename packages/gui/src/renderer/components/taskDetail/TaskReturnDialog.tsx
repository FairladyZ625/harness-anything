import { useLayoutEffect, useState } from "react";
import { ArrowCounterClockwise, Plus } from "@phosphor-icons/react";
import { Modal } from "../primitives/Modal.tsx";
import { Button } from "../primitives/Button.tsx";
import { AnnotateDiffViewer, type DiffFile } from "../agent-ui/AnnotateDiffViewer.tsx";
import { t } from "../../i18n/index.tsx";

export function TaskReturnDialog({
  open,
  onClose,
  onReturn,
  diffFiles,
  initialFeedback,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReturn: (mode: "resume" | "fresh", feedback: string) => void;
  readonly diffFiles?: readonly DiffFile[];
  readonly initialFeedback?: string;
}) {
  const [feedback, setFeedback] = useState("");
  // 组件随退场动画常驻,重新打开时清空上次反馈——与旧的条件挂载逐次新建等价。
  useLayoutEffect(() => {
    if (open) setFeedback(initialFeedback ?? "");
  }, [initialFeedback, open]);
  return (
    <Modal
      open={open}
      title={t("components.taskReturnDialog.title")}
      testId="task-return-dialog"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t("components.taskReturnDialog.cancel")}
          </Button>
          <Button
            disabled={!feedback.trim()}
            onClick={() => onReturn("resume", feedback.trim())}
            testId="task-return-resume"
          >
            <ArrowCounterClockwise size={14} weight="bold" aria-hidden />
            {t("components.taskReturnDialog.resumeSession")}
          </Button>
          <Button
            disabled={!feedback.trim()}
            onClick={() => onReturn("fresh", feedback.trim())}
            testId="task-return-fresh"
          >
            <Plus size={14} weight="bold" aria-hidden />
            {t("components.taskReturnDialog.freshWorker")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {diffFiles && diffFiles.length > 0 && (
          <section className="flex flex-col gap-2">
            <span className="font-mono ui-meta text-text">{t("components.taskReturnDialog.diffReview")}</span>
            <AnnotateDiffViewer
              files={diffFiles}
              onBatchSend={(prompt) => {
                setFeedback((prev) => (prev.trim() ? `${prev.trim()}\n\n${prompt}` : prompt));
              }}
            />
          </section>
        )}
        <label className="flex flex-col gap-2 ui-body">
          {t("components.taskReturnDialog.feedbackLabel")}
          <textarea
            autoFocus
            rows={5}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            className="w-full resize-y rounded border border-border-strong bg-surface p-2 text-text"
          />
        </label>
      </div>
    </Modal>
  );
}
