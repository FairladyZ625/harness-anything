import { useEffect, useState } from "react";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import { runtimeIsolationState, runtimePermissionMode } from "../../../../../daemon/src/runtime-permissions.ts";
import { runtimeTypeMatchesKind } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { AgentEntityRow } from "../../agent-entity-client.ts";
import type { RuntimeInstallationRow, RuntimeInstanceUpdateInput } from "../../runtime-instance-client.ts";
import {
  runtimeAuthPresentation, runtimeAuthPresentationText, type RuntimeAuthProbeState,
} from "../../runtime-auth-presentation.ts";
import { buildRuntimeInstanceUpdatePayload, runtimeDefaultModel, runtimeInstanceEditForm, runtimeInstanceEditModels, runtimeInstanceEditReady, toggleRuntimeModel, type RuntimeInstanceEditFormState } from "../../runtime-instance-form.ts";
import { planeAllowsPermissions, planeUsesApiOverride, runtimeProviderPlane } from "../../runtime-provider-planes.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Avatar, Badge, Btn, CapDot, Card, CardBody, CardHead, CardTitle, Chip, ChipZone, CfgRow, Crumbs, CrumbSep, Empty, Field, FieldGrid, Hint, KindDot, KV, KVRow, Right, TextInput, Toggle } from "./parts.tsx";
import { RuntimeModelEditor } from "./RuntimeModelEditor.tsx";

type Props = {
  readonly instance: RuntimeInstanceSummary; readonly installations: readonly RuntimeInstallationRow[]; readonly agents: readonly AgentEntityRow[]; readonly liveSessions: number; readonly busy: boolean;
  readonly authProbeState?: RuntimeAuthProbeState;
  readonly onSelectAgent: (agentId: string) => void; readonly onAuth: (action: "login" | "logout") => void; readonly onValidate: () => void;
  readonly onSelectRuntime: (instanceId: string) => void;
  readonly onSetEnabled: (enabled: boolean) => void; readonly onUpdate: (input: RuntimeInstanceUpdateInput) => void; readonly onDelete: () => void; readonly onSelfTest: (model: string) => Promise<string | null>;
};
// The carrier card. Provider plane decides which sections exist at all: agy has no API
// section because agy has no API mode; claude shows the single-instance API override;
// codex shows the call path it was created with, because those are separate instances.
export function RuntimeCard({
  instance, installations, agents, liveSessions, busy, authProbeState,
  onSelectAgent, onSelectRuntime, onAuth, onValidate, onSetEnabled, onUpdate, onDelete, onSelfTest,
}: Props) {
  const [confirm, setConfirm] = useState(false), [editing, setEditing] = useState(false), [selfTestModel, setSelfTestModel] = useState(instance.defaultModel), [selfTestResult, setSelfTestResult] = useState<string | null>(null), [selfTestBusy, setSelfTestBusy] = useState(false);
  useEffect(() => { setSelfTestModel(instance.defaultModel); setSelfTestResult(null); }, [instance.instanceId, instance.defaultModel]);
  useEffect(() => { setEditing(false); }, [instance.instanceId]);
  const plane = runtimeProviderPlane(instance.kindId), compatible = agents.filter((agent) => runtimeTypeMatchesKind(agent.runtimeType, instance.kindId));
  const apiMode = instance.authMode === "api-key",
    auth = runtimeAuthPresentation(instance, authProbeState),
    authText = runtimeAuthPresentationText(instance, auth);
  const nativeAuthActions = !apiMode && instance.kindId !== "agy", agyLoginPath = instance.kindId === "agy" && instance.authState === "unauthenticated";
  return <div data-testid={`runtime-card-${instance.instanceId}`}>
    <Crumbs>
      <span>{t("agentRuntime.segRuntimes")}</span>
      <CrumbSep />
      <b className="font-semibold text-text-muted">{instance.name}</b>
      <CrumbSep />
      <EntityRefLink
        entityRef={`provider/${instance.instanceId}`}
        onNavigate={() => onSelectRuntime(instance.instanceId)}
        title={instance.instanceId}
        className="font-mono text-text-muted hover:text-accent hover:underline"
      />
    </Crumbs>
    <Card testId="runtime-card-provider">
      <CardHead>
        <KindDot
          kind={instance.kindId}
        />
        {liveSessions > 0 ? <Badge status="active">{t("agentRuntime.liveSessions", { count: liveSessions })}</Badge> : <Badge status="planned">{t("agentRuntime.idle")}</Badge>}
        <Right>{!editing && <Btn size="sm" testId="runtime-provider-edit" disabled={busy} onClick={() => setEditing(true)}>{t("agentRuntime.editProvider")}</Btn>}<Hint>{t("agentRuntime.enabled")}</Hint><Toggle checked={instance.enabled} label={t("agentRuntime.enabled")} onChange={onSetEnabled} /></Right>
      </CardHead>
      <CardBody>{editing ? <ProviderEditor key={instance.instanceId} instance={instance} installations={installations} busy={busy} onUpdate={onUpdate} onCancel={() => setEditing(false)} /> : <FieldGrid>
        <Field label="provider" value={instance.providerId} mono={false} />
        <Field label="default model" value={instance.defaultModel} />
        <Field label="models" value={instance.models.join(", ")} />
        <Field label="installation" value={instance.installationId} />
        {instance.kindId === "codex" && <Field label="codex.reasoningEffort" value={instance.codex.reasoningEffort ?? t("agentRuntime.providerDefault")} faint={instance.codex.reasoningEffort === null} />}
        {instance.kindId === "agy" && <Field label="agy.effort" value={instance.agy.effort ?? t("agentRuntime.providerDefault")} faint={instance.agy.effort === null} />}
        {instance.kindId === "claude" && <Field label="claude.baseUrl" value={instance.claude.baseUrl ?? t("agentRuntime.officialEndpoint")} faint={!instance.claude.baseUrlConfigured} />}
        {instance.kindId === "codex" && <><Field label="codex.baseUrl" value={instance.codex.baseUrl ?? t("agentRuntime.officialEndpoint")} faint={!instance.codex.baseUrlConfigured} /><Field label="codex.wire_api" value={instance.codex.wire_api ?? t("agentRuntime.providerDefault")} faint={instance.codex.wire_api === null} /><Field label="codex.requires_openai_auth" value={instance.codex.requires_openai_auth === null ? t("agentRuntime.providerDefault") : String(instance.codex.requires_openai_auth)} faint={instance.codex.requires_openai_auth === null} /><Field label="codex.http_headers" value={instance.codex.http_headers ? Object.entries(instance.codex.http_headers).map(([name, value]) => `${name}=${value}`).join(", ") : t("agentRuntime.providerDefault")} faint={instance.codex.http_headers === null} /></>}
      </FieldGrid>}</CardBody>
    </Card>

    <Card testId="runtime-card-auth">
      <CardHead><CardTitle>{t("agentRuntime.authTitle")}</CardTitle><Hint>{t(planeUsesApiOverride(instance.kindId) ? "agentRuntime.authClaudePlane" : plane.authShape === "separate" ? "agentRuntime.authCodexPlane" : "agentRuntime.authAgyPlane")}</Hint><Right><CapDot state={auth.cap} tip={authText} /></Right></CardHead>
      <CardBody><div data-auth-status={auth.state}>
        <div className="flex flex-wrap items-center gap-3">
          <Badge status={auth.badge}>{apiMode ? t("agentRuntime.authModeApiKey") : t("agentRuntime.authModeSubscription")} · {instance.authState}</Badge>
          <Hint>{authText}</Hint>
          <span className="flex-1" />
          <Btn size="sm" disabled={busy} onClick={onValidate}>{t("agentRuntime.checkAuth")}</Btn>
          {nativeAuthActions && <><Btn size="sm" disabled={busy} onClick={() => onAuth("login")}>{t("agentRuntime.signIn")}</Btn><Btn size="sm" variant="ghost" disabled={busy} onClick={() => onAuth("logout")}>{t("agentRuntime.signOut")}</Btn></>}
          {agyLoginPath && <Btn size="sm" disabled={busy} onClick={() => onAuth("login")}>{t("agentRuntime.signIn")}</Btn>}
        </div>
        {apiMode && <p className="mt-2 text-[11px] text-text-faint">{t("agentRuntime.apiKeySealed")}</p>}
        {planeUsesApiOverride(instance.kindId) && <p className="mt-2 text-[11px] text-text-faint">{t(apiMode ? "agentRuntime.claudeApiOverrideOn" : "agentRuntime.claudeApiOverrideOff")}</p>}
      </div></CardBody>
    </Card>

    <Card testId="runtime-card-self-test">
      <CardHead><CardTitle>{t("agentRuntime.selfTestTitle")}</CardTitle><Hint>{t("agentRuntime.selfTestHint")}</Hint></CardHead>
      <CardBody><div className="flex flex-wrap items-center gap-2"><select aria-label={t("agentRuntime.selfTestModel")} value={selfTestModel} onChange={(event) => setSelfTestModel(event.target.value)} className="control min-w-[180px]">{instance.models.map((model) => <option key={model} value={model}>{model}</option>)}</select><Btn size="sm" disabled={busy || selfTestBusy} onClick={() => { setSelfTestBusy(true); setSelfTestResult(null); void onSelfTest(selfTestModel).then(setSelfTestResult).finally(() => setSelfTestBusy(false)); }}>{t(selfTestBusy ? "agentRuntime.selfTestRunning" : "agentRuntime.selfTestRun")}</Btn></div>{selfTestResult !== null && <pre data-testid="runtime-self-test-result" className="rt-pre mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{selfTestResult}</pre>}</CardBody>
    </Card>

    {planeAllowsPermissions(instance.kindId) && <Card testId="runtime-card-isolation">
      <CardHead><CardTitle>{t("agentRuntime.isolationTitle")}</CardTitle><Hint>{t("agentRuntime.isolationHint")}</Hint></CardHead>
      <CardBody><PermissionsEditor instance={instance} busy={busy} onUpdate={onUpdate} /></CardBody>
    </Card>}

    <Card>
      <CardHead><CardTitle>{t("agentRuntime.compatibleAgents")}</CardTitle><Hint>{t("agentRuntime.compatibleAgentsHint", { kind: instance.kindId })}</Hint></CardHead>
      <CardBody><ChipZone>{compatible.length ? compatible.map((agent) => <Chip key={agent.id} tone="link" onClick={() => onSelectAgent(agent.id)}><Avatar id={agent.id} />{agent.name}</Chip>) : <Empty>{t("agentRuntime.noCompatibleAgent")}</Empty>}</ChipZone></CardBody>
    </Card>

    <Card dashed>
      <CardHead><CardTitle>{t("agentRuntime.dangerTitle")}</CardTitle><Hint>{t("agentRuntime.dangerHint")}</Hint></CardHead>
      <CardBody>
        <KV><KVRow name="state root">{instance.isolationState === "enforced" ? t("agentRuntime.instanceStateRoot") : t("agentRuntime.operatorEnvironment")}</KVRow><KVRow name="permission">{instance.permissionMode ?? t("agentRuntime.providerDefault")}</KVRow></KV>
        <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
          <Btn variant="danger" size="sm" disabled={busy} onClick={() => { if (confirm) { setConfirm(false); onDelete(); } else setConfirm(true); }}>{confirm ? t("agentRuntime.confirmDelete") : t("agentRuntime.deleteInstance")}</Btn>
          <Hint>
            ha runtime instance delete{" "}
            <EntityRefLink
              entityRef={`provider/${instance.instanceId}`}
              onNavigate={() => onSelectRuntime(instance.instanceId)}
              title={instance.instanceId}
              className="text-text-muted hover:text-accent hover:underline"
            />
          </Hint>
        </div>
      </CardBody>
    </Card>
  </div>;
}

function ProviderEditor({ instance, installations, busy, onUpdate, onCancel }: { readonly instance: RuntimeInstanceSummary; readonly installations: readonly RuntimeInstallationRow[]; readonly busy: boolean; readonly onUpdate: (input: RuntimeInstanceUpdateInput) => void; readonly onCancel: () => void }) {
  const [draft, setDraft] = useState<RuntimeInstanceEditFormState>(() => runtimeInstanceEditForm(instance)), [customModelOpen, setCustomModelOpen] = useState(false);
  const witnessed = installations.filter((installation) => installation.kindId === instance.kindId), installation = witnessed.find((entry) => entry.installationId === draft.installationId), ready = runtimeInstanceEditReady(draft);
  const patch = (value: Partial<RuntimeInstanceEditFormState>) => setDraft((current) => ({ ...current, ...value }));
  const setModels = (models: readonly string[]) => setDraft((current) => ({ ...current, models, defaultModel: runtimeDefaultModel(models, current.defaultModel) }));
  return <form data-testid="runtime-provider-editor" onSubmit={(event) => { event.preventDefault(); onUpdate(buildRuntimeInstanceUpdatePayload(instance.instanceId, draft)); onCancel(); }}>
    <div className="grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-2">
      <label className="grid gap-0.5"><span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-faint">{t("agentRuntime.name")}</span><TextInput label={t("agentRuntime.name")} testId="runtime-provider-name" value={draft.name} onChange={(name) => patch({ name })} /></label>
      <label className="grid gap-0.5"><span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-faint">{t("agentRuntime.installation")}</span><select data-testid="runtime-provider-installation" aria-label={t("agentRuntime.installation")} value={draft.installationId} onChange={(event) => patch({ installationId: event.target.value })} className="control">{witnessed.map((entry) => <option key={entry.installationId} value={entry.installationId}>{entry.installationId} · {entry.version}</option>)}</select></label>
      <label className="grid gap-0.5"><span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-faint">{t("agentRuntime.model")}</span><RuntimeModelEditor availableModels={installation?.models ?? []} selectedModels={draft.models} customModel={draft.customModel} customModelOpen={customModelOpen} onToggleModel={(model) => setModels(toggleRuntimeModel(draft.models, undefined, model))} onCustomModelChange={(customModel) => setDraft((current) => { const next = { ...current, customModel }, models = runtimeInstanceEditModels(next); return { ...next, defaultModel: runtimeDefaultModel(models, current.defaultModel) }; })} onCustomModelOpenChange={setCustomModelOpen} defaultModel={draft.defaultModel} onDefaultModelChange={(defaultModel) => patch({ defaultModel })} testIdPrefix="runtime-provider" keepOneModel /></label>
    </div>
    <div className="mt-2 flex items-center gap-2"><Hint>{t("agentRuntime.providerEditHint")}</Hint><span className="flex-1" /><Btn testId="runtime-provider-cancel" onClick={onCancel}>{t("agentRuntime.cancel")}</Btn><Btn type="submit" variant="primary" testId="runtime-provider-save" disabled={busy || !ready}>{t("agentRuntime.saveProvider")}</Btn></div>
  </form>;
}

function PermissionsEditor({ instance, busy, onUpdate }: { readonly instance: RuntimeInstanceSummary; readonly busy: boolean; readonly onUpdate: (input: RuntimeInstanceUpdateInput) => void }) {
  const [permissionMode, setPermissionMode] = useState(() => runtimePermissionMode(instance.permissionMode ?? undefined, instance.kindId));
  const [isolationState, setIsolationState] = useState(() => runtimeIsolationState(instance.isolationState, instance.kindId));
  if (!permissionMode) return <Empty>{t("agentRuntime.permissionsUnsupported")}</Empty>;
  return <form data-testid="runtime-instance-permissions" onSubmit={(event) => { event.preventDefault(); onUpdate({ instanceId: instance.instanceId, permissionMode, ...(instance.kindId === "claude" ? { isolationState } : {}) }); }}>
    <CfgRow label={t("agentRuntime.permissionMode")}><select data-testid="runtime-instance-permission-mode" aria-label={t("agentRuntime.permissionMode")} value={permissionMode} onChange={(event) => setPermissionMode(event.target.value as typeof permissionMode)} className="control"><option value="bypass">{t("agentRuntime.permissionBypass")}</option><option value="workspace-write">{t("agentRuntime.permissionWorkspaceWrite")}</option><option value="read-only">{t("agentRuntime.permissionReadOnly")}</option></select></CfgRow>
    {instance.kindId === "claude" && <CfgRow label={t("agentRuntime.isolation")}><select data-testid="runtime-instance-isolation" aria-label={t("agentRuntime.isolation")} value={isolationState} onChange={(event) => setIsolationState(event.target.value as typeof isolationState)} className="control"><option value="operator-environment">{t("agentRuntime.operatorEnvironment")}</option><option value="enforced">{t("agentRuntime.instanceStateRoot")}</option></select></CfgRow>}
    <Btn type="submit" size="sm" disabled={busy}>{t("agentRuntime.savePermissions")}</Btn>
  </form>;
}
