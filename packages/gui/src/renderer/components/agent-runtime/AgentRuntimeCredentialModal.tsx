import { useState } from "react";
import { t } from "../../i18n/index.tsx";
import { BTN } from "../ui/widgets.tsx";

export interface AgentRuntimeCredentialModalProps {
  readonly kindId: "claude-code" | "codex";
  readonly onClose: () => void;
  readonly onSubmit: (payload: {
    readonly kindId: "claude-code" | "codex";
    readonly apiKey: string;
    readonly baseUrl?: string;
  }) => void;
  readonly pending: boolean;
}

export function AgentRuntimeCredentialModal({
  kindId,
  onClose,
  onSubmit,
  pending
}: AgentRuntimeCredentialModalProps) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const trimmedKey = apiKey.trim();
  const trimmedUrl = baseUrl.trim();
  const canSubmit = trimmedKey.length > 0 && !pending;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      kindId,
      apiKey: trimmedKey,
      ...(trimmedUrl.length > 0 ? { baseUrl: trimmedUrl } : {})
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onClose();
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-border bg-surface p-4 shadow-xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="ui-title font-mono font-semibold">
            {t("views.agentRuntimeView.credentialModalTitle", { kindId })}
          </h2>
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
        <p className="ui-meta mb-3 text-text-faint">
          {t("views.agentRuntimeView.credentialModalHint", { kindId })}
        </p>
        <label className="mb-2 block">
          <span className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-text-faint">
            {t("views.agentRuntimeView.apiKeyLabel")}
          </span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            placeholder={kindId === "claude-code" ? "sk-ant-…" : "sk-…"}
            className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 font-mono text-[13px] text-text focus:border-accent focus:outline-none"
          />
        </label>
        <label className="mb-4 block">
          <span className="mb-1 block font-mono text-[11px] uppercase tracking-wide text-text-faint">
            {t("views.agentRuntimeView.baseUrlLabel")}
          </span>
          <input
            type="text"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            placeholder="https://api.example.com"
            className="w-full rounded-md border border-border bg-surface-raised px-3 py-1.5 font-mono text-[13px] text-text focus:border-accent focus:outline-none"
          />
        </label>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} disabled={pending} className={BTN}>
            {t("views.agentRuntimeView.cancel")}
          </button>
          <button type="submit" disabled={!canSubmit} className={BTN}>
            {pending ? t("views.agentRuntimeView.saving") : t("views.agentRuntimeView.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
