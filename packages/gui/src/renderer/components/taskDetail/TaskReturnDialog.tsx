import { useLayoutEffect, useState } from "react";
import { ArrowCounterClockwise, Plus } from "@phosphor-icons/react";
import { Modal } from "../primitives/Modal.tsx";
import { Button } from "../primitives/Button.tsx";

export function TaskReturnDialog({
  open,
  onClose,
  onReturn,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onReturn: (mode: "resume" | "fresh", feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState("");
  // 组件随退场动画常驻,重新打开时清空上次反馈——与旧的条件挂载逐次新建等价。
  useLayoutEffect(() => {
    if (open) setFeedback("");
  }, [open]);
  return (
    <Modal
      open={open}
      title="打回任务"
      testId="task-return-dialog"
      onClose={onClose}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            disabled={!feedback.trim()}
            onClick={() => onReturn("resume", feedback.trim())}
            testId="task-return-resume"
          >
            <ArrowCounterClockwise size={14} weight="bold" aria-hidden />
            续跑原会话
          </Button>
          <Button
            disabled={!feedback.trim()}
            onClick={() => onReturn("fresh", feedback.trim())}
            testId="task-return-fresh"
          >
            <Plus size={14} weight="bold" aria-hidden />
            全新 Worker
          </Button>
        </div>
      }
    >
      <label className="flex flex-col gap-2 ui-body">
        返工反馈
        <textarea
          autoFocus
          rows={5}
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          className="w-full resize-y rounded border border-border-strong bg-surface p-2 text-text"
        />
      </label>
    </Modal>
  );
}
