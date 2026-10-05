import { useState } from "react";
import type { AgentDispatchPreview } from "../runtime-control.ts";
import { t } from "../i18n/index.tsx";
import { Modal } from "./primitives/Modal.tsx";
import { Button } from "./primitives/Button.tsx";

// Read-only rendering of an agent-dispatch-preview/v1 receipt: the mission as authored and
// the full prompt the daemon would inject at this dispatch's launch boundary. The renderer
// assembles nothing — every byte shown here came back from the daemon's dryRun call.
export function DispatchPreviewModal({
  preview,
  onClose,
}: {
  readonly preview: AgentDispatchPreview;
  readonly onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(preview.prompt);
    setCopied(true);
  };
  return (
    <Modal
      testId="dispatch-preview"
      wide
      title={t("agentRuntime.previewTitle")}
      hint={t("agentRuntime.previewHint")}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <Button testId="dispatch-preview-copy" onClick={() => void copy()}>
            {t(copied ? "agentRuntime.previewCopied" : "agentRuntime.previewCopy")}
          </Button>
          <span className="flex-1" />
          <Button variant="primary" onClick={onClose}>
            {t("agentRuntime.previewClose")}
          </Button>
        </div>
      }
    >
      <section className="mb-3">
        <b className="ui-micro font-bold uppercase tracking-[0.08em] text-text-muted">
          {t("agentRuntime.previewMission")}
        </b>
        <p
          data-testid="dispatch-preview-mission"
          className="mt-1 [overflow-wrap:anywhere] whitespace-pre-wrap rounded border border-border bg-surface px-2 py-1.5 font-mono ui-micro text-text"
        >
          {preview.mission}
        </p>
      </section>
      <section>
        <b className="ui-micro font-bold uppercase tracking-[0.08em] text-text-muted">
          {t("agentRuntime.previewPrompt")}
        </b>
        <p
          data-testid="dispatch-preview-prompt"
          className="mt-1 [overflow-wrap:anywhere] whitespace-pre-wrap rounded border border-border bg-surface px-2 py-1.5 font-mono ui-micro text-text"
        >
          {preview.prompt}
        </p>
      </section>
    </Modal>
  );
}
