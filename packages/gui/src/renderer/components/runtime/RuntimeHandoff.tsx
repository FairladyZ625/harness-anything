import { useState } from "react";
import { runtimeCommandClient } from "../../runtime-command-client.ts";
import { t } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { TextInput } from "../primitives/TextInput.tsx";
import { Section } from "../primitives/Section.tsx";
import { isRendererRecord } from "../../result-validation.ts";

export function RuntimeHandoff({
  repoId,
  dispatchId,
  onNavigate,
}: {
  readonly repoId: string;
  readonly dispatchId: string;
  readonly onNavigate: (ref: string) => void;
}) {
  const [idempotencyKey] = useState(() => `gui-handoff-${crypto.randomUUID()}`);
  const [instance, setInstance] = useState(""),
    [prompt, setPrompt] = useState(""),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState<string | null>(null);
  const run = async (operation: "export" | "claim" | "revoke"): Promise<boolean> => {
    setBusy(true);
    setFeedback(null);
    try {
      const receipt = await runtimeCommandClient.handoff(repoId, {
        operation,
        dispatchId,
        ...(operation === "claim" ? { runtimeInstanceId: instance, prompt, idempotencyKey } : {}),
      });
      if (receipt.outcome !== "applied") {
        const error = isRendererRecord(receipt.error) ? receipt.error : null;
        setFeedback(String(error?.hint ?? receipt.rejectionExplanation ?? receipt.code ?? receipt.outcome));
        return false;
      }
      const checkpoint = isRendererRecord(receipt.checkpoint) ? receipt.checkpoint : null;
      setFeedback(
        operation === "revoke"
          ? t("agentRuntime.handoffRevoked")
          : checkpoint
            ? t("agentRuntime.handoffExported", { commit: String(checkpoint.commit) })
            : t(receipt.handoffResumed === false ? "agentRuntime.handoffAccepted" : "agentRuntime.handoffResumed"),
      );
      if (typeof receipt.runtimeSessionId === "string") onNavigate(`session/${receipt.runtimeSessionId}`);
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("agentRuntime.handoffTitle")}>
      <div data-testid="runtime-handoff" className="flex flex-col gap-2">
        <p className="ui-meta text-text-muted">{t("agentRuntime.handoffHint")}</p>
        <div className="flex flex-wrap gap-2">
          <Button testId="handoff-export" disabled={busy} onClick={() => void run("export")}>
            {t("agentRuntime.handoffExport")}
          </Button>
          <Button testId="handoff-revoke" disabled={busy} onClick={() => void run("revoke")}>
            {t("agentRuntime.handoffRevoke")}
          </Button>
        </div>
        <label className="flex flex-col gap-1 ui-meta">
          {t("agentRuntime.handoffInstance")}
          <TextInput
            testId="handoff-instance"
            label={t("agentRuntime.handoffInstance")}
            value={instance}
            onChange={setInstance}
            disabled={busy}
          />
        </label>
        <label className="flex flex-col gap-1 ui-meta">
          {t("agentRuntime.handoffPrompt")}
          <TextInput
            testId="handoff-prompt"
            label={t("agentRuntime.handoffPrompt")}
            value={prompt}
            onChange={setPrompt}
            disabled={busy}
          />
        </label>
        <Button
          testId="handoff-claim"
          disabled={busy || !instance.trim() || !prompt.trim()}
          onClick={() => void run("claim")}
        >
          {t("agentRuntime.handoffClaim")}
        </Button>
        {feedback && (
          <p role="status" className="break-words ui-meta">
            {feedback}
          </p>
        )}
      </div>
    </Section>
  );
}
