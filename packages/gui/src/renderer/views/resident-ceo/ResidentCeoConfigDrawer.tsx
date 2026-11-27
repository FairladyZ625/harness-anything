import { useEffect, useMemo, useState } from "react";
import type { DecisionProviderRecord } from "@harness-anything/daemon/protocol";
import type {
  ResidentCeoApprovalGateMode,
  ResidentCeoConfigureInput,
  ResidentCeoExecutionPolicy,
  ResidentCeoProfileRead,
} from "../../api-client.ts";
import { t } from "../../i18n/index.tsx";
import { Button } from "../../components/primitives/Button.tsx";
import { Drawer } from "../../components/primitives/Drawer.tsx";
import { TextInput } from "../../components/primitives/TextInput.tsx";
import { ActionError } from "../../components/runtime/ActionError.tsx";

export interface ResidentCeoRuntimeInstanceOption {
  readonly instanceId: string;
  readonly providerId?: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly models: readonly string[];
  readonly defaultModel?: string;
}

export function ResidentCeoConfigDrawer({
  open,
  repoId,
  profile,
  instances,
  agentIds,
  decisionProviders,
  saving,
  savedNotice,
  error,
  onClose,
  onSave,
}: {
  readonly open: boolean;
  readonly repoId: string;
  readonly profile: ResidentCeoProfileRead | null;
  readonly instances: readonly ResidentCeoRuntimeInstanceOption[];
  readonly agentIds: readonly string[];
  readonly decisionProviders: readonly DecisionProviderRecord[];
  readonly saving: boolean;
  readonly savedNotice: boolean;
  readonly error: Error | null;
  readonly onClose: () => void;
  readonly onSave: (input: ResidentCeoConfigureInput) => void;
}) {
  const [instanceId, setInstanceId] = useState(profile?.runtimeInstanceId ?? "");
  const [model, setModel] = useState(profile?.model ?? "");
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState(String(profile?.heartbeatIntervalSec ?? 300));
  const [executionPolicy, setExecutionPolicy] = useState<ResidentCeoExecutionPolicy>(
    profile?.executionPolicy ?? "advisory-only",
  );
  const [defaultWorkId, setDefaultWorkId] = useState(profile?.defaultWorkId ?? "");
  const [defaultAgentId, setDefaultAgentId] = useState(profile?.defaultAgentId ?? "");
  const [autoApproveSendersText, setAutoApproveSendersText] = useState((profile?.autoApproveSenders ?? []).join(", "));
  const [gateMode, setGateMode] = useState<ResidentCeoApprovalGateMode>(profile?.approvalGate?.mode ?? "off");
  const [gateProviderId, setGateProviderId] = useState(profile?.approvalGate?.providerId ?? "");
  const [gateMinConfidence, setGateMinConfidence] = useState(String(profile?.approvalGate?.minConfidence ?? 0.85));

  useEffect(() => {
    if (!open) return;
    setInstanceId(profile?.runtimeInstanceId ?? "");
    setModel(profile?.model ?? "");
    setHeartbeatIntervalSec(String(profile?.heartbeatIntervalSec ?? 300));
    setExecutionPolicy(profile?.executionPolicy ?? "advisory-only");
    setDefaultWorkId(profile?.defaultWorkId ?? "");
    setDefaultAgentId(profile?.defaultAgentId ?? "");
    setAutoApproveSendersText((profile?.autoApproveSenders ?? []).join(", "));
    setGateMode(profile?.approvalGate?.mode ?? "off");
    setGateProviderId(profile?.approvalGate?.providerId ?? "");
    setGateMinConfidence(String(profile?.approvalGate?.minConfidence ?? 0.85));
  }, [open, profile]);

  const effectiveInstanceId = instanceId || profile?.runtimeInstanceId || "";
  const selectedInstance = instances.find((item) => item.instanceId === effectiveInstanceId);
  const models = useMemo(() => selectedInstance?.models ?? [], [selectedInstance?.models]);
  const selectedModel = useMemo(
    () =>
      model ||
      (profile !== null && profile.runtimeInstanceId === selectedInstance?.instanceId ? profile.model : "") ||
      selectedInstance?.defaultModel ||
      models[0] ||
      "",
    [model, profile, selectedInstance?.defaultModel, selectedInstance?.instanceId, models],
  );

  const parsedHeartbeat = Number(heartbeatIntervalSec);
  const parsedMinConfidence = Number(gateMinConfidence);
  const confidenceValid =
    gateMode === "off" || (Number.isFinite(parsedMinConfidence) && parsedMinConfidence > 0 && parsedMinConfidence <= 1);
  const canSave =
    Boolean(selectedInstance) &&
    Boolean(selectedModel) &&
    Number.isSafeInteger(parsedHeartbeat) &&
    parsedHeartbeat >= 30 &&
    parsedHeartbeat <= 86_400 &&
    confidenceValid;

  const handleSubmit = () => {
    if (!canSave || !selectedInstance) return;
    const autoApproveSenders = autoApproveSendersText
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    onSave({
      repoId,
      runtimeInstanceId: selectedInstance.instanceId,
      model: selectedModel,
      heartbeatIntervalSec: parsedHeartbeat,
      executionPolicy,
      defaultWorkId: defaultWorkId.trim() || null,
      defaultAgentId: defaultAgentId.trim() || null,
      autoApproveSenders,
      gateMode,
      gateProviderId: gateProviderId.trim() || null,
      ...(gateMode !== "off" ? { gateMinConfidence: parsedMinConfidence } : {}),
    });
  };

  const selectClass =
    "min-w-0 rounded-sm border border-border bg-surface px-2 py-1 ui-meta text-text outline-none hover:border-border-strong focus-visible:border-accent";

  return (
    <Drawer open={open} onClose={onClose} ariaLabel={t("residentCeo.configuration")}>
      <div data-testid="resident-ceo-config-drawer" className="flex flex-col gap-4">
        <div className="flex items-center justify-between border-b border-border pb-2.5">
          <h2 className="ui-title font-semibold text-text">{t("residentCeo.configuration")}</h2>
          <Button variant="ghost" size="sm" testId="resident-ceo-config-close" onClick={onClose}>
            {t("residentCeo.closeConfig")}
          </Button>
        </div>

        {error ? <ActionError>{error.message}</ActionError> : null}
        {savedNotice ? (
          <p data-testid="resident-ceo-config-saved" className="ui-meta text-status-done">
            {t("residentCeo.configSaved")}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.providerInstance")}
            <select
              data-testid="resident-ceo-config-instance"
              className={selectClass}
              value={effectiveInstanceId}
              onChange={(event) => {
                setInstanceId(event.target.value);
                setModel("");
              }}
            >
              <option value="">{t("residentCeo.chooseInstance")}</option>
              {instances.map((item) => (
                <option key={item.instanceId} value={item.instanceId}>
                  {item.providerId ? `${item.providerId} · ` : ""}
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.model")}
            <select
              data-testid="resident-ceo-config-model"
              className={selectClass}
              value={selectedModel}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="">{t("residentCeo.chooseModel")}</option>
              {models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.heartbeatInterval")}
            <TextInput
              type="number"
              label={t("residentCeo.heartbeatInterval")}
              value={heartbeatIntervalSec}
              mono
              onChange={setHeartbeatIntervalSec}
              testId="resident-ceo-config-heartbeat"
            />
          </label>

          <div className="border-t border-border pt-3">
            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("residentCeo.executionPolicy")}
              <select
                data-testid="resident-ceo-config-policy"
                className={selectClass}
                value={executionPolicy}
                onChange={(event) => setExecutionPolicy(event.target.value as ResidentCeoExecutionPolicy)}
              >
                <option value="advisory-only">{t("residentCeo.policy.advisoryOnly")}</option>
                <option value="approval-gated">{t("residentCeo.policy.approvalGated")}</option>
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.defaultWorkId")}
            <TextInput
              label={t("residentCeo.defaultWorkId")}
              placeholder={t("residentCeo.defaultWorkPlaceholder")}
              value={defaultWorkId}
              mono
              onChange={setDefaultWorkId}
              testId="resident-ceo-config-default-work"
            />
          </label>

          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.defaultAgentId")}
            {agentIds.length > 0 ? (
              <select
                data-testid="resident-ceo-config-default-agent"
                className={selectClass}
                value={defaultAgentId}
                onChange={(event) => setDefaultAgentId(event.target.value)}
              >
                <option value="">{t("residentCeo.chooseDefaultAgent")}</option>
                {agentIds.map((agentId) => (
                  <option key={agentId} value={agentId}>
                    {agentId}
                  </option>
                ))}
              </select>
            ) : (
              <TextInput
                label={t("residentCeo.defaultAgentId")}
                placeholder={t("residentCeo.chooseDefaultAgent")}
                value={defaultAgentId}
                mono
                onChange={setDefaultAgentId}
                testId="resident-ceo-config-default-agent"
              />
            )}
          </label>

          <label className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("residentCeo.autoApproveSenders")}
            <TextInput
              label={t("residentCeo.autoApproveSenders")}
              placeholder={t("residentCeo.autoApproveSendersPlaceholder")}
              value={autoApproveSendersText}
              mono
              onChange={setAutoApproveSendersText}
              testId="resident-ceo-config-allowlist"
            />
          </label>

          <div className="flex flex-col gap-3 border-t border-border pt-3">
            <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
              {t("residentCeo.gateSection")}
            </span>

            <label className="flex flex-col gap-1 ui-meta text-text-muted">
              {t("residentCeo.gateMode")}
              <select
                data-testid="resident-ceo-config-gate-mode"
                className={selectClass}
                value={gateMode}
                onChange={(event) => setGateMode(event.target.value as ResidentCeoApprovalGateMode)}
              >
                <option value="off">{t("residentCeo.gateMode.off")}</option>
                <option value="secondary-guard">{t("residentCeo.gateMode.secondaryGuard")}</option>
                <option value="auto-promote">{t("residentCeo.gateMode.autoPromote")}</option>
              </select>
            </label>

            {gateMode !== "off" ? (
              <>
                <label className="flex flex-col gap-1 ui-meta text-text-muted">
                  {t("residentCeo.gateProvider")}
                  <select
                    data-testid="resident-ceo-config-gate-provider"
                    className={selectClass}
                    value={gateProviderId}
                    onChange={(event) => setGateProviderId(event.target.value)}
                  >
                    <option value="">{t("residentCeo.gateProviderDefault")}</option>
                    {decisionProviders.map((provider) => (
                      <option key={provider.providerId} value={provider.providerId}>
                        {provider.name} ({provider.providerId})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 ui-meta text-text-muted">
                  {t("residentCeo.gateMinConfidence")}
                  <TextInput
                    type="number"
                    label={t("residentCeo.gateMinConfidence")}
                    value={gateMinConfidence}
                    mono
                    onChange={setGateMinConfidence}
                    testId="resident-ceo-config-gate-confidence"
                  />
                </label>
              </>
            ) : null}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={onClose}>
            {t("residentCeo.closeConfig")}
          </Button>
          <Button
            variant="primary"
            loading={saving}
            disabled={!canSave}
            testId="resident-ceo-config-save"
            onClick={handleSubmit}
          >
            {t("residentCeo.saveConfiguration")}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
