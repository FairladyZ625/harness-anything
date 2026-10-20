import { useState, type FormEvent } from "react";
import { LayoutGroup, motion } from "motion/react";
import { ChatCircleDots, X } from "@phosphor-icons/react";

/**
 * 运行中半路插话引流器(dec_C0AF8CBBFFECF71F4F34FB76F9 CH2 / Affect UI AgentSteering):
 * 用户在 Agent 执行过程中输入追加指令/纠偏纸条(Steer Note)放入待吸收队列,Agent
 * 推进到下一步时经 motion layoutId/FLIP 平滑滑入目标步骤卡(与 AgentPlan 共用
 * LayoutGroup),或选择立即中断(Interrupt)。
 *
 * 状态归调用方:组件只渲染 queued 纸条并回调 onEnqueue/onWithdraw/onInterrupt;
 * 「推进到下一步 → 纸条转 absorbed」的时机由调用方的响应式状态流驱动(W1-T1),
 * absorbed 纸条由 AgentPlan 渲染同一 layoutId,FLIP 过渡由 motion 完成。
 */

/** 插话纸条:queued=待吸收队列;absorbed=已滑入目标步骤卡(AgentPlan 渲染)。 */
export interface SteerNote {
  readonly id: string;
  readonly text: string;
  /** 目标步骤 id;缺省=吸收进下一个推进到的步骤。 */
  readonly targetStepId?: string;
  readonly createdAt: number;
  readonly state: "queued" | "absorbed";
}

/** layoutId 前缀:AgentPlan 以同一前缀渲染 absorbed 纸条,FLIP 才能跨组件接续。 */
export const STEER_NOTE_LAYOUT_PREFIX = "steer-note";

export function steerNoteLayoutId(noteId: string): string {
  return `${STEER_NOTE_LAYOUT_PREFIX}-${noteId}`;
}

export function AgentSteering({
  notes,
  running = true,
  steps,
  onEnqueue,
  onWithdraw,
  onInterrupt,
  layoutGroupId,
  testId,
}: {
  /** 只渲染 queued 纸条;absorbed 的由 AgentPlan 渲染。 */
  readonly notes: readonly SteerNote[];
  /** 运行中才可插话/中断;非运行态输入区禁用并说明。 */
  readonly running?: boolean;
  /** 目标步骤候选(可缺省:不选则吸收进下一步)。 */
  readonly steps?: readonly { readonly id: string; readonly title: string }[];
  readonly onEnqueue: (text: string, targetStepId?: string) => void;
  readonly onWithdraw?: (noteId: string) => void;
  /** 缺省不渲染中断按钮(没有可中断的执行时)。 */
  readonly onInterrupt?: () => void;
  /** 与 AgentPlan 传同一 id,layoutId 过渡跨组件生效。 */
  readonly layoutGroupId?: string;
  readonly testId?: string;
}) {
  const [draft, setDraft] = useState("");
  const [targetStepId, setTargetStepId] = useState<string>("");
  const queued = notes.filter((note) => note.state === "queued");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (text === "" || !running) return;
    onEnqueue(text, targetStepId === "" ? undefined : targetStepId);
    setDraft("");
  };

  const body = (
    <div data-testid={testId} className="flex min-w-0 flex-col gap-2">
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-1.5">
        <label className="font-semibold ui-meta" htmlFor={testId !== undefined ? `${testId}-input` : "steer-input"}>
          插话 / 纠偏纸条
        </label>
        <div className="flex min-w-0 items-start gap-1.5">
          <textarea
            id={testId !== undefined ? `${testId}-input` : "steer-input"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={!running}
            placeholder={running ? "追加指令或纠偏意见，Agent 推进到下一步时吸收" : "Agent 未在运行"}
            rows={2}
            data-testid={testId !== undefined ? `${testId}-textarea` : undefined}
            className="min-w-0 flex-1 resize-y rounded-md border border-border-strong bg-surface px-2 py-1.5 ui-meta text-text disabled:opacity-45"
          />
          {steps !== undefined && steps.length > 0 && (
            <select
              value={targetStepId}
              onChange={(event) => setTargetStepId(event.target.value)}
              disabled={!running}
              aria-label="目标步骤"
              data-testid={testId !== undefined ? `${testId}-target` : undefined}
              className="ui-control max-w-36 shrink-0 rounded-md border border-border bg-surface-raised px-1.5 ui-micro"
            >
              <option value="">下一步</option>
              {steps.map((step) => (
                <option key={step.id} value={step.id}>
                  {step.title}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={!running || draft.trim() === ""}
            data-testid={testId !== undefined ? `${testId}-enqueue` : undefined}
            className="ui-control rounded-md border border-transparent bg-accent px-2.5 font-semibold text-accent-fg disabled:cursor-not-allowed disabled:opacity-45"
          >
            <span className="inline-flex items-center gap-1.5">
              <ChatCircleDots aria-hidden />
              加入队列
            </span>
          </button>
          {onInterrupt !== undefined && (
            <button
              type="button"
              onClick={onInterrupt}
              disabled={!running}
              data-testid={testId !== undefined ? `${testId}-interrupt` : undefined}
              className="ui-control rounded-md border border-border-strong px-2.5 text-text hover:border-text-faint disabled:opacity-45"
            >
              立即中断
            </button>
          )}
        </div>
      </form>
      {queued.length > 0 && (
        <ul className="flex min-w-0 flex-col gap-1" aria-label="待吸收队列">
          {queued.map((note) => (
            <li key={note.id}>
              <motion.div
                layoutId={steerNoteLayoutId(note.id)}
                data-testid={testId !== undefined ? `${testId}-note-${note.id}` : undefined}
                className="flex min-w-0 items-start gap-1.5 rounded-md border border-border bg-surface px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words ui-meta">{note.text}</span>
                {onWithdraw !== undefined && (
                  <button
                    type="button"
                    aria-label="撤回纸条"
                    data-testid={testId !== undefined ? `${testId}-withdraw-${note.id}` : undefined}
                    onClick={() => onWithdraw(note.id)}
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-xs text-text-faint hover:text-danger"
                  >
                    <X aria-hidden />
                  </button>
                )}
              </motion.div>
            </li>
          ))}
        </ul>
      )}
      {queued.length === 0 && <p className="m-0 ui-micro text-text-faint">{running ? "队列为空" : "Agent 未在运行"}</p>}
    </div>
  );

  return layoutGroupId !== undefined ? <LayoutGroup id={layoutGroupId}>{body}</LayoutGroup> : body;
}
