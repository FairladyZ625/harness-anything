import { useMemo, useState } from "react";
import { t } from "../../i18n/index.tsx";
import { BTN } from "../ui/widgets.tsx";
import type { AgentRuntimeSpawnPayload } from "../../../api/renderer-dto.ts";

export interface AgentRuntimeSpawnModalProps {
  readonly onClose: () => void;
  readonly onSubmit: (payload: AgentRuntimeSpawnPayload) => void;
  readonly pending: boolean;
}

type KindId = "claude-code" | "codex";
type ProfileKind = "subscription-account" | "api-key" | "chatgpt-account";

const KIND_OPTIONS: { readonly key: KindId; readonly label: string }[] = [
  { key: "claude-code", label: "claude-code" },
  { key: "codex", label: "codex" }
];

function profileOptions(kindId: KindId): { readonly key: ProfileKind; readonly label: string }[] {
  if (kindId === "claude-code") {
    return [
      { key: "subscription-account", label: "subscription-account" },
      { key: "api-key", label: "api-key" }
    ];
  }
  return [
    { key: "chatgpt-account", label: "chatgpt-account" },
    { key: "api-key", label: "api-key" }
  ];
}

export function AgentRuntimeSpawnModal({ onClose, onSubmit, pending }: AgentRuntimeSpawnModalProps) {
  const [kindId, setKindId] = useState<KindId>("claude-code");
  const [profileKind, setProfileKind] = useState<ProfileKind>("subscription-account");
  const [prompt, setPrompt] = useState("");
  const [taskId, setTaskId] = useState("");
  const [cwd, setCwd] = useState("");

  const profileOptionsForKind = useMemo(() => profileOptions(kindId), [kindId]);
  const trimmedPrompt = prompt.trim();
  const trimmedCwd = cwd.trim();
  const trimmedTaskId = taskId.trim();
  const canSubmit = trimmedPrompt.length > 0 && trimmedCwd.length > 0 && !pending;

  const handleKindChange = (next: KindId) => {
    setKindId(next);
    const firstProfile = profileOptions(next)[0];
    if (firstProfile) setProfileKind(firstProfile.key);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      kindId,
      prompt: trimmedPrompt,
      cwd: trimmedCwd,
      authenticationProfileKind: profileKind,
      ...(trimmedTaskId.length > 0 ? { taskId: trimmedTaskId } : {})
    });
  };

  const selectClass = "w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 font-mono text-[13px] text-text focus:border-accent focus:outline-none";
  const inputClass = `${selectClass} placeholder:text-text-faint`;
  const labelClass = "mb-1 block font-mono text-[11px] uppercase tracking-wide text-text-faint";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg rounded-lg border border-border bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="ui-title font-mono font-semibold">{t("views.agentRuntimeView.spawnModalTitle")}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="text-text-faint hover:text-text"
            aria-label={t("views.agentRuntimeView.close")}
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={labelClass}>{t("views.agentRuntimeView.spawnKind")}</span>
            <select
              value={kindId}
              onChange={(event) => handleKindChange(event.target.value as KindId)}
              disabled={pending}
              className={selectClass}
            >
              {KIND_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={labelClass}>{t("views.agentRuntimeView.spawnProfile")}</span>
            <select
              value={profileKind}
              onChange={(event) => setProfileKind(event.target.value as ProfileKind)}
              disabled={pending}
              className={selectClass}
            >
              {profileOptionsForKind.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-3 block">
          <span className={labelClass}>{t("views.agentRuntimeView.spawnCwd")}</span>
          <input
            type="text"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            placeholder="/Users/you/project"
            className={inputClass}
          />
        </label>
        <label className="mt-3 block">
          <span className={labelClass}>{t("views.agentRuntimeView.spawnPrompt")}</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            disabled={pending}
            spellCheck={false}
            placeholder={t("views.agentRuntimeView.spawnPromptPlaceholder")}
            className={`${inputClass} resize-y`}
          />
        </label>
        <label className="mt-3 block">
          <span className={labelClass}>{t("views.agentRuntimeView.spawnTaskId")}</span>
          <input
            type="text"
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            placeholder="task_01…"
            className={inputClass}
          />
        </label>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={BTN}>
            {t("views.agentRuntimeView.cancel")}
          </button>
          <button type="submit" disabled={!canSubmit} className={BTN}>
            {pending ? t("views.agentRuntimeView.spawning") : t("views.agentRuntimeView.spawn")}
          </button>
        </div>
      </form>
    </div>
  );
}
