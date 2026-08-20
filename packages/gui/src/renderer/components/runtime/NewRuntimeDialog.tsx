import { useState } from "react";
import { runtimeIsolationState, runtimePermissionMode } from "../../../../../daemon/src/runtime-permissions.ts";
import type { RuntimeInstallationRow, RuntimeInstanceCreateInput } from "../../runtime-instance-client.ts";
import { applyRuntimeAuthMode, applyRuntimeKind, buildRuntimeInstanceCreatePayload, runtimeInstanceFormReady, type CreateInstanceFormState } from "../../runtime-instance-form.ts";
import { planeAllowsApiKey, planeAllowsBaseUrl, planeAllowsEffort, planeAllowsPermissions, planeUsesApiOverride, runtimeProviderPlane, RUNTIME_KIND_IDS, type RuntimeKindId } from "../../runtime-provider-planes.ts";
import { t } from "../../i18n/index.tsx";
import { Badge, Btn, CfgRow, Hint, KindDot, Modal, SegCtl, TextInput, Toggle, WarnBar } from "./parts.tsx";

const KIND_LABEL: Record<RuntimeKindId, string> = { claude: "Claude Code", codex: "Codex", agy: "AGY (Gemini)" };
const emptyForm = (kindId: RuntimeKindId): CreateInstanceFormState => ({ instanceId: "", name: "", kindId, installationId: "", providerId: runtimeProviderPlane(kindId).defaultProviderId, model: "", reasoningEffort: "", baseUrl: "", authMode: "subscription", apiKey: "", wireApi: "", requiresOpenAiAuth: false, permissionMode: runtimePermissionMode(undefined, kindId), isolation: runtimeIsolationState(undefined, kindId) });

// Create dialog for the three provider planes. Which controls exist is derived from the
// plane, never from a free-form toggle: agy renders no auth choice at all, claude renders
// one instance with an optional API override, codex renders the two separate call paths.
export function NewRuntimeDialog({ installations, busy, initialKind = "claude", onCancel, onCreate }: { readonly installations: readonly RuntimeInstallationRow[]; readonly busy: boolean; readonly initialKind?: RuntimeKindId; readonly onCancel: () => void; readonly onCreate: (input: RuntimeInstanceCreateInput) => void }) {
  const [form, setForm] = useState<CreateInstanceFormState>(() => emptyForm(initialKind));
  const plane = runtimeProviderPlane(form.kindId), witnessed = installations.filter((row) => row.kindId === form.kindId);
  const installationId = witnessed.some((row) => row.installationId === form.installationId) ? form.installationId : witnessed[0]?.installationId ?? "";
  const apiOn = form.authMode === "api-key", ready = runtimeInstanceFormReady(form, installationId);
  const setKind = (kindId: RuntimeKindId) => setForm((current) => applyRuntimeKind(current, kindId, { permissionMode: runtimePermissionMode(undefined, kindId), isolation: runtimeIsolationState(undefined, kindId) }));
  const patch = (value: Partial<CreateInstanceFormState>) => setForm((current) => ({ ...current, ...value }));
  return <Modal testId="new-runtime-dialog" title={t("agentRuntime.newRuntimeTitle")} hint={t("agentRuntime.newRuntimeHint")} onClose={onCancel} footer={
    <div className="flex items-center gap-2"><Hint>{witnessed.find((row) => row.installationId === installationId)?.installationId ?? t("agentRuntime.noWitnessedInstallation", { kind: form.kindId })}</Hint><span className="flex-1" /><Btn onClick={onCancel}>{t("agentRuntime.cancel")}</Btn><Btn variant="primary" testId="new-runtime-create" disabled={busy || !ready} onClick={() => onCreate(buildRuntimeInstanceCreatePayload({ ...form, installationId }, installationId))}>{t(apiOn ? "agentRuntime.createWithApiKey" : "agentRuntime.createSubscription")}</Btn></div>}>
    <CfgRow label={t("agentRuntime.provider")}>
      <SegCtl label={t("agentRuntime.provider")} value={form.kindId} onChange={setKind} options={RUNTIME_KIND_IDS.map((kindId) => ({ value: kindId, label: KIND_LABEL[kindId] }))} />
      <KindDot kind={form.kindId} /><Hint>{t(`agentRuntime.plane_${form.kindId}` as never)}</Hint>
    </CfgRow>

    <h3 className="mt-3 mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{t("agentRuntime.witnessedInstallations")}</h3>
    {witnessed.length === 0 ? <p className="rounded border border-dashed border-status-blocked/50 px-2.5 py-2 text-[11px] text-status-blocked">{t("agentRuntime.noWitnessedInstallation", { kind: form.kindId })}</p>
      : witnessed.map((row) => <button key={row.installationId} type="button" onClick={() => patch({ installationId: row.installationId })} className={`mb-1.5 flex w-full items-center gap-2.5 rounded border px-2.5 py-1.5 text-left ${row.installationId === installationId ? "border-accent bg-accent/[0.08]" : "border-border hover:border-border-strong"}`}>
        <KindDot kind={row.kindId} /><span className="min-w-0"><span className="block text-[11.5px]">{t("agentRuntime.witnessed", { kind: row.kindId, version: row.version })}</span><span className="block truncate font-mono text-[10.5px] text-text-muted">{row.installationId}</span></span><span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">{row.observedAt.slice(0, 10)}</span>
      </button>)}

    <h3 className="mt-3 mb-1.5 font-mono text-[10px] uppercase tracking-[0.07em] text-text-faint">{t("agentRuntime.callPath")}</h3>
    {plane.authShape === "subscription-only" && <p className="text-[11px] text-text-faint">{t("agentRuntime.callPathAgy")}</p>}
    {plane.authShape === "separate" && <div className="flex flex-wrap items-center gap-2"><SegCtl label={t("agentRuntime.callPath")} value={form.authMode} onChange={(authMode) => setForm((current) => applyRuntimeAuthMode(current, authMode))} options={[{ value: "subscription" as const, label: t("agentRuntime.authModeSubscription") }, { value: "api-key" as const, label: t("agentRuntime.authModeApiKey") }]} /><Hint>{t("agentRuntime.callPathCodex")}</Hint></div>}
    {planeUsesApiOverride(form.kindId) && <div><div className="flex flex-wrap items-center gap-2"><Toggle checked={apiOn} label={t("agentRuntime.apiOverride")} onChange={(next) => setForm((current) => applyRuntimeAuthMode(current, next ? "api-key" : "subscription"))} /><b className="text-[11px]">{t("agentRuntime.apiOverride")}</b><Badge status={apiOn ? "active" : "planned"}>{t(apiOn ? "agentRuntime.apiOverrideOn" : "agentRuntime.apiOverrideOff")}</Badge></div><p className="mt-1 text-[11px] text-text-faint">{t("agentRuntime.callPathClaude")}</p></div>}

    <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(215px,1fr))] gap-x-[18px] gap-y-2">
      <Labelled label={t("agentRuntime.instanceId")}><TextInput label={t("agentRuntime.instanceId")} testId="new-runtime-id" mono value={form.instanceId} onChange={(instanceId) => patch({ instanceId })} placeholder="claude-work" /></Labelled>
      <Labelled label={t("agentRuntime.name")}><TextInput label={t("agentRuntime.name")} value={form.name} onChange={(name) => patch({ name })} placeholder={t("agentRuntime.namePlaceholder")} /></Labelled>
      <Labelled label="provider"><TextInput label="provider" mono value={form.providerId} onChange={(providerId) => patch({ providerId })} /></Labelled>
      <Labelled label={t("agentRuntime.model")} hint={t(`agentRuntime.modelHint_${form.kindId}` as never)}><TextInput label={t("agentRuntime.model")} testId="new-runtime-model" mono value={form.model} onChange={(model) => patch({ model })} placeholder={t("agentRuntime.modelPlaceholder")} /></Labelled>
      {planeAllowsBaseUrl(form.kindId, form.authMode) && <Labelled label={t("agentRuntime.baseUrl")} hint={t("agentRuntime.baseUrlHint")}><TextInput label={t("agentRuntime.baseUrl")} testId="new-runtime-base-url" mono value={form.baseUrl} onChange={(baseUrl) => patch({ baseUrl })} placeholder="https://open.bigmodel.cn/api/anthropic" /></Labelled>}
      {planeAllowsApiKey(form.kindId, form.authMode) && <Labelled label={t("agentRuntime.apiKey")} hint={t("agentRuntime.apiKeyHint")}><TextInput label={t("agentRuntime.apiKey")} testId="new-runtime-api-key" type="password" value={form.apiKey} onChange={(apiKey) => patch({ apiKey })} placeholder={t("agentRuntime.apiKeyPlaceholder")} /></Labelled>}
      {planeAllowsEffort(form.kindId) && (plane.effort === "enum"
        ? <Labelled label={t("agentRuntime.effort")}><select aria-label={t("agentRuntime.effort")} value={form.reasoningEffort} onChange={(event) => patch({ reasoningEffort: event.target.value })} className="control"><option value="">{t("agentRuntime.providerDefault")}</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></Labelled>
        : <Labelled label={t("agentRuntime.effort")}><TextInput label={t("agentRuntime.effort")} mono value={form.reasoningEffort} onChange={(reasoningEffort) => patch({ reasoningEffort })} placeholder="xhigh" /></Labelled>)}
      {form.kindId === "codex" && apiOn && <Labelled label="wire_api"><select aria-label="wire_api" value={form.wireApi} onChange={(event) => patch({ wireApi: event.target.value })} className="control"><option value="">{t("agentRuntime.providerDefault")}</option><option value="responses">responses</option><option value="chat">chat</option></select></Labelled>}
      {planeAllowsPermissions(form.kindId) && <Labelled label={t("agentRuntime.permissionMode")}><select aria-label={t("agentRuntime.permissionMode")} value={form.permissionMode} onChange={(event) => patch({ permissionMode: event.target.value as CreateInstanceFormState["permissionMode"] })} className="control"><option value="bypass">{t("agentRuntime.permissionBypass")}</option><option value="workspace-write">{t("agentRuntime.permissionWorkspaceWrite")}</option><option value="read-only">{t("agentRuntime.permissionReadOnly")}</option></select></Labelled>}
      {planeAllowsPermissions(form.kindId) && <Labelled label={t("agentRuntime.isolation")}><select aria-label={t("agentRuntime.isolation")} value={form.isolation} onChange={(event) => patch({ isolation: event.target.value as CreateInstanceFormState["isolation"] })} className="control"><option value="operator-environment">{t("agentRuntime.operatorEnvironment")}</option><option value="enforced">{t("agentRuntime.instanceStateRoot")}</option></select></Labelled>}
    </div>
    {form.kindId === "codex" && apiOn && <label className="mt-2 flex items-center gap-1.5 font-mono text-[10px] uppercase text-text-faint"><input type="checkbox" checked={form.requiresOpenAiAuth} onChange={(event) => patch({ requiresOpenAiAuth: event.target.checked })} />requires_openai_auth</label>}
    <WarnBar><span>{t(apiOn ? "agentRuntime.createApiWarn" : "agentRuntime.createSubscriptionWarn")}</span></WarnBar>
  </Modal>;
}
function Labelled({ label, hint, children }: { readonly label: string; readonly hint?: string; readonly children: React.ReactNode }) { return <div className="grid min-w-0 gap-0.5"><span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-text-faint">{label}</span>{children}{hint && <span className="text-[10px] text-text-faint">{hint}</span>}</div>; }
