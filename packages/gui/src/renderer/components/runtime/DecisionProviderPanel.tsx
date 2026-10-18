import { useLayoutEffect, useState } from "react";
import type { DecisionProviderRecord } from "@harness-anything/kernel";
import { Button } from "../primitives/Button.tsx";
import { Field, FieldGrid } from "../primitives/Fields.tsx";
import { Modal } from "../primitives/Modal.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { TextInput } from "../primitives/TextInput.tsx";
import { Toggle } from "../primitives/Toggle.tsx";
import { t } from "../../i18n/index.tsx";
import type { DecisionProviderCreateInput, DecisionProviderUpdateInput } from "../../decision-provider-client.ts";
import { ActionError } from "./ActionError.tsx";
import { Card, CardBody, CardHead, CardTitle, Hint, Right } from "./parts.tsx";

export type ProviderEntryType = "llm" | "decisions";

export function ProviderTypeDialog({
  open,
  onClose,
  onChoose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChoose: (type: ProviderEntryType) => void;
}) {
  return (
    <Modal
      open={open}
      testId="provider-type-dialog"
      title={t("decisionProvider.typeDialogTitle")}
      hint={t("decisionProvider.typeDialogHint")}
      onClose={onClose}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <button
          type="button"
          data-testid="provider-type-llm"
          onClick={() => onChoose("llm")}
          className="rounded border border-border p-3 text-left hover:border-accent"
        >
          <b className="ui-body">{t("decisionProvider.typeLlm")}</b>
          <p className="mt-1 ui-micro text-text-muted">{t("decisionProvider.typeLlmHint")}</p>
        </button>
        <button
          type="button"
          data-testid="provider-type-decisions"
          onClick={() => onChoose("decisions")}
          className="rounded border border-border p-3 text-left hover:border-accent"
        >
          <b className="ui-body">{t("decisionProvider.typeDecisions")}</b>
          <p className="mt-1 ui-micro text-text-muted">{t("decisionProvider.typeDecisionsHint")}</p>
        </button>
      </div>
    </Modal>
  );
}

export function DecisionProviderDialog({
  open,
  provider,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly provider: DecisionProviderRecord | null;
  readonly busy: boolean;
  readonly error?: string | null;
  readonly onClose: () => void;
  readonly onSubmit: (input: DecisionProviderCreateInput | DecisionProviderUpdateInput) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    setProviderId(provider?.providerId ?? "");
    setName(provider?.name ?? "");
    setModel(provider?.model ?? "");
    setBaseUrl(provider?.baseUrl ?? "");
    setApiKey("");
    setEnabled(provider?.enabled ?? true);
    setSubmitError(null);
  }, [open, provider]);
  const editing = provider !== null,
    idValid = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(providerId.trim()),
    ready = idValid && name.trim() !== "" && model.trim() !== "" && (editing || apiKey.trim() !== "");
  return (
    <Modal
      open={open}
      testId="decision-provider-dialog"
      title={t(editing ? "decisionProvider.editTitle" : "decisionProvider.createTitle")}
      hint={t("decisionProvider.formHint")}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Hint>{t("decisionProvider.vendorFixed")}</Hint>
          <span className="flex-1" />
          <Button onClick={onClose}>{t("agentRuntime.cancel")}</Button>
          <Button
            variant="primary"
            testId="decision-provider-save"
            disabled={busy || !ready}
            onClick={() => {
              setSubmitError(null);
              const input = editing
                ? {
                    providerId: provider.providerId,
                    name: name.trim(),
                    model: model.trim(),
                    baseUrl,
                    enabled,
                    ...(apiKey.trim() ? { apiKey } : {}),
                  }
                : {
                    type: "decisions" as const,
                    providerId: providerId.trim(),
                    name: name.trim(),
                    model: model.trim(),
                    baseUrl,
                    apiKey,
                    enabled,
                  };
              void onSubmit(input).then(
                () => setApiKey(""),
                (cause: unknown) => setSubmitError(cause instanceof Error ? cause.message : String(cause)),
              );
            }}
          >
            {t("decisionProvider.save")}
          </Button>
        </div>
      }
    >
      <div data-testid="decision-provider-form" className="grid gap-3">
        {error || submitError ? <ActionError>{submitError ?? error}</ActionError> : null}
        {!editing ? (
          <LabeledInput
            label={t("decisionProvider.id")}
            value={providerId}
            onChange={setProviderId}
            testId="decision-provider-id"
          />
        ) : null}
        <LabeledInput
          label={t("decisionProvider.name")}
          value={name}
          onChange={setName}
          testId="decision-provider-name"
        />
        <LabeledInput
          label={t("decisionProvider.vendor")}
          value="OpenRouter"
          disabled
          testId="decision-provider-vendor"
        />
        <LabeledInput
          label={t("decisionProvider.model")}
          value={model}
          onChange={setModel}
          testId="decision-provider-model"
        />
        <LabeledInput
          label={t("decisionProvider.baseUrl")}
          value={baseUrl}
          onChange={setBaseUrl}
          placeholder={t("decisionProvider.baseUrlDefault")}
          testId="decision-provider-base-url"
        />
        <LabeledInput
          label={t("decisionProvider.apiKey")}
          value={apiKey}
          onChange={setApiKey}
          type="password"
          placeholder={t(editing ? "decisionProvider.apiKeyKeep" : "decisionProvider.apiKeyRequired")}
          testId="decision-provider-api-key"
        />
        <label className="flex items-center gap-2 ui-meta">
          <Toggle checked={enabled} onChange={setEnabled} label={t("decisionProvider.enabled")} />
          {t("decisionProvider.enabled")}
        </label>
        {!idValid && providerId.trim() ? (
          <p role="alert" className="ui-micro text-status-blocked">
            {t("decisionProvider.idInvalid")}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}

export function DecisionProviderDetail({
  provider,
  busy,
  onEdit,
  onProbe,
  onSetEnabled,
  onDelete,
}: {
  readonly provider: DecisionProviderRecord;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onProbe: () => void;
  readonly onSetEnabled: (enabled: boolean) => void;
  readonly onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const probe = provider.probe,
    probeLabel =
      probe.state === "ready"
        ? t("decisionProvider.probeReady")
        : probe.state === "failed"
          ? t("decisionProvider.probeFailed", { code: probe.code })
          : t("decisionProvider.probeUnknown");
  return (
    <>
      <section
        data-testid="decision-provider-detail"
        className="status-edge glass relative mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xs px-3.5 py-2"
      >
        <StatusTag tone="wait" label={t("decisionProvider.advisoryOnly")} />
        <strong className="ui-body">{provider.name}</strong>
        <span className="ml-auto flex items-center gap-2">
          <StatusTag
            tone={provider.enabled ? "neutral" : "cancel"}
            label={t(provider.enabled ? "decisionProvider.enabled" : "decisionProvider.disabled")}
          />
          <Toggle
            checked={provider.enabled}
            onChange={onSetEnabled}
            disabled={busy}
            label={t("decisionProvider.enabled")}
          />
        </span>
      </section>
      <Card testId="decision-provider-card">
        <CardHead>
          <CardTitle>{t("decisionProvider.detailsTitle")}</CardTitle>
          <Right>
            <Button size="sm" testId="decision-provider-probe" disabled={busy} onClick={onProbe}>
              {t("decisionProvider.probe")}
            </Button>
            <Button size="sm" testId="decision-provider-edit" disabled={busy} onClick={onEdit}>
              {t("decisionProvider.edit")}
            </Button>
            <Button
              size="sm"
              variant="danger"
              testId="decision-provider-delete"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              {t("decisionProvider.delete")}
            </Button>
          </Right>
        </CardHead>
        <CardBody>
          <FieldGrid>
            <Field label={t("decisionProvider.id")} value={provider.providerId} />
            <Field label={t("decisionProvider.type")} value={provider.providerType} mono={false} />
            <Field label={t("decisionProvider.vendor")} value={provider.vendor} mono={false} />
            <Field label={t("decisionProvider.model")} value={provider.model} mono={false} />
            <Field
              label={t("decisionProvider.baseUrl")}
              value={provider.baseUrl ?? t("decisionProvider.defaultBaseUrl")}
              mono={false}
            />
            <Field label={t("decisionProvider.probeStatus")} value={probeLabel} mono={false} />
            <Field label={t("decisionProvider.configurationRevision")} value={String(provider.configurationRevision)} />
          </FieldGrid>
          {probe.state !== "unknown" ? <p className="mt-2 ui-micro text-text-faint">{probe.checkedAt}</p> : null}
        </CardBody>
      </Card>
      <Modal
        open={confirmDelete}
        testId="decision-provider-delete-confirm"
        title={t("decisionProvider.deleteConfirmTitle")}
        onClose={() => setConfirmDelete(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)}>{t("agentRuntime.cancel")}</Button>
            <Button variant="danger" testId="decision-provider-delete-confirm-button" onClick={onDelete}>
              {t("decisionProvider.delete")}
            </Button>
          </div>
        }
      >
        <p className="ui-meta">{t("decisionProvider.deleteConfirmBody", { name: provider.name })}</p>
      </Modal>
    </>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  disabled,
  type,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange?: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly type?: "text" | "password";
  readonly testId: string;
}) {
  return (
    <label className="grid min-w-0 gap-1 ui-micro text-text-muted">
      {label}
      <TextInput
        label={label}
        value={value}
        onChange={onChange ?? (() => undefined)}
        placeholder={placeholder}
        disabled={disabled}
        type={type}
        testId={testId}
      />
    </label>
  );
}
