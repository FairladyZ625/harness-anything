import { useLayoutEffect, useState } from "react";
import type { AgentEntityAvailableRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { ActionError } from "./ActionError.tsx";
import { Hint } from "./parts.tsx";
import { Modal } from "../primitives/Modal.tsx";
import { Button } from "../primitives/Button.tsx";

// 详情页的退役/删除确认弹窗:两个对话框共用一个文件——它们是同一组生命周期动作的
// 两个形状(退役必填原因、可选接替者;删除必填原因,expected-version 由调用方从
// show 结果带进来,用户不输入版本号)。写入都走 view 传入的 workspace 动作,与 CLI
// 同一条 daemon 实体动作;被拒原因(如 agent_referenced)在按钮旁就地显示。

/** 退役 Agent:必填原因,可选接替者(从在用 Agent 里选,不含自身)。 */
export function RetireAgentDialog({
  open,
  agent,
  agents,
  busy,
  actionError = null,
  onCancel,
  onRetire,
}: {
  readonly open: boolean;
  readonly agent: { readonly id: string; readonly name: string };
  readonly agents: readonly AgentEntityAvailableRow[];
  readonly busy: boolean;
  readonly actionError?: string | null;
  readonly onCancel: () => void;
  readonly onRetire: (input: { readonly reason: string; readonly successor?: string }) => void;
}) {
  const [reason, setReason] = useState(""),
    [successor, setSuccessor] = useState("");
  useLayoutEffect(() => {
    if (!open) return;
    setReason("");
    setSuccessor("");
  }, [open]);
  // 接替者只列在用、非自身的 Agent;退役身份不能再被指定为接替者。
  const candidates = agents.filter((row) => row.retirement === null && row.id !== agent.id);
  return (
    <Modal
      open={open}
      testId="retire-agent-dialog"
      title={t("agentRuntime.retireTitle", { name: agent.name })}
      hint={t("agentRuntime.retireHint")}
      onClose={onCancel}
      footer={
        <div className="flex items-center gap-2">
          <Hint>{t("agentRuntime.retireFooter")}</Hint>
          <span className="flex-1" />
          <Button onClick={onCancel}>{t("agentRuntime.cancel")}</Button>
          <Button
            variant="primary"
            testId="retire-agent-confirm"
            disabled={busy || reason.trim() === ""}
            onClick={() => onRetire({ reason: reason.trim(), ...(successor ? { successor } : {}) })}
          >
            {t("agentRuntime.retireConfirm")}
          </Button>
        </div>
      }
    >
      {actionError ? <ActionError>{actionError}</ActionError> : null}
      <label className="mb-1.5 block ui-meta text-text-muted" htmlFor="retire-agent-reason">
        {t("agentRuntime.retireReasonLabel")}
      </label>
      <textarea
        id="retire-agent-reason"
        data-testid="retire-agent-reason"
        aria-label={t("agentRuntime.retireReasonLabel")}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="rt-instr"
        rows={3}
      />
      <label className="mb-1.5 mt-2.5 block ui-meta text-text-muted" htmlFor="retire-agent-successor">
        {t("agentRuntime.retireSuccessorLabel")}
      </label>
      <select
        id="retire-agent-successor"
        data-testid="retire-agent-successor"
        aria-label={t("agentRuntime.retireSuccessorLabel")}
        value={successor}
        onChange={(event) => setSuccessor(event.target.value)}
        className="control"
      >
        <option value="">{t("agentRuntime.retireNoSuccessor")}</option>
        {candidates.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name} ({row.id})
          </option>
        ))}
      </select>
    </Modal>
  );
}

/** 删除 Agent/Squad:必填原因;expected-version 已由调用方从 show 结果取得。 */
export function DeleteEntityDialog({
  open,
  kind,
  entity,
  busy,
  actionError = null,
  onCancel,
  onDelete,
}: {
  readonly open: boolean;
  readonly kind: "agent" | "squad";
  readonly entity: { readonly id: string; readonly name: string };
  readonly busy: boolean;
  readonly actionError?: string | null;
  readonly onCancel: () => void;
  readonly onDelete: (input: { readonly reason: string }) => void;
}) {
  const [reason, setReason] = useState("");
  useLayoutEffect(() => {
    if (!open) return;
    setReason("");
  }, [open]);
  return (
    <Modal
      open={open}
      testId={`delete-${kind}-dialog`}
      title={t("agentRuntime.deleteTitle", { name: entity.name })}
      hint={t("agentRuntime.deleteHint")}
      onClose={onCancel}
      footer={
        <div className="flex items-center gap-2">
          <Hint>{t("agentRuntime.deleteFooter")}</Hint>
          <span className="flex-1" />
          <Button onClick={onCancel}>{t("agentRuntime.cancel")}</Button>
          <Button
            variant="danger"
            testId={`delete-${kind}-confirm`}
            disabled={busy || reason.trim() === ""}
            onClick={() => onDelete({ reason: reason.trim() })}
          >
            {t("agentRuntime.deleteConfirm")}
          </Button>
        </div>
      }
    >
      {actionError ? <ActionError>{actionError}</ActionError> : null}
      <label className="mb-1.5 block ui-meta text-text-muted" htmlFor={`delete-${kind}-reason`}>
        {t("agentRuntime.deleteReasonLabel")}
      </label>
      <textarea
        id={`delete-${kind}-reason`}
        data-testid={`delete-${kind}-reason`}
        aria-label={t("agentRuntime.deleteReasonLabel")}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="rt-instr"
        rows={3}
      />
    </Modal>
  );
}
