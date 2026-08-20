import { useState } from "react";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import { runtimeIsolationState, runtimePermissionMode } from "../../../../../daemon/src/runtime-permissions.ts";
import { runtimeTypeMatchesKind } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { AgentEntityRow } from "../../agent-entity-client.ts";
import type { RuntimeInstanceUpdateInput } from "../../runtime-instance-client.ts";
import { planeAllowsPermissions, planeUsesApiOverride, runtimeProviderPlane } from "../../runtime-provider-planes.ts";
import { t } from "../../i18n/index.tsx";
import { Avatar, Badge, Btn, CapDot, Card, CardBody, CardHead, CardTitle, Chip, ChipZone, CfgRow, Crumbs, CrumbSep, Empty, Field, FieldGrid, Hint, KindDot, KV, KVRow, Right, Toggle } from "./parts.tsx";

type Props = {
  readonly instance: RuntimeInstanceSummary; readonly agents: readonly AgentEntityRow[]; readonly liveSessions: number; readonly busy: boolean;
  readonly onSelectAgent: (agentId: string) => void; readonly onAuth: (action: "login" | "reauth" | "logout") => void; readonly onValidate: () => void;
  readonly onSetEnabled: (enabled: boolean) => void; readonly onUpdate: (input: RuntimeInstanceUpdateInput) => void; readonly onDelete: () => void;
};
// The carrier card. Provider plane decides which sections exist at all: agy has no API
// section because agy has no API mode; claude shows the single-instance API override;
// codex shows the call path it was created with, because those are separate instances.
export function RuntimeCard({ instance, agents, liveSessions, busy, onSelectAgent, onAuth, onValidate, onSetEnabled, onUpdate, onDelete }: Props) {
  const [confirm, setConfirm] = useState(false);
  const plane = runtimeProviderPlane(instance.kindId), compatible = agents.filter((agent) => runtimeTypeMatchesKind(agent.runtimeType, instance.kindId));
  const apiMode = instance.authMode === "api-key", ready = instance.authReadiness.status === "ready";
  return <div data-testid={`runtime-card-${instance.instanceId}`}>
    <Crumbs><span>{t("agentRuntime.segRuntimes")}</span><CrumbSep /><b className="font-semibold text-text-muted">{instance.name}</b><CrumbSep /><span className="font-mono">{instance.instanceId}</span></Crumbs>
    <Card>
      <CardHead>
        <KindDot kind={instance.kindId} /><CardTitle>{instance.name}</CardTitle><Badge>{instance.kindId}</Badge><Badge>{instance.instanceId}</Badge>
        {liveSessions > 0 ? <Badge status="active">{t("agentRuntime.liveSessions", { count: liveSessions })}</Badge> : <Badge status="planned">{t("agentRuntime.idle")}</Badge>}
        <Right><Hint>{t("agentRuntime.enabled")}</Hint><Toggle checked={instance.enabled} label={t("agentRuntime.enabled")} onChange={onSetEnabled} /></Right>
      </CardHead>
      <CardBody><FieldGrid>
        <Field label="provider" value={instance.providerId} mono={false} />
        <Field label="default model" value={instance.defaultModel} />
        <Field label="models" value={instance.models.join(", ")} />
        <Field label="installation" value={instance.installationId} />
        {instance.kindId === "codex" && <Field label="codex.reasoningEffort" value={instance.codex.reasoningEffort ?? t("agentRuntime.providerDefault")} faint={instance.codex.reasoningEffort === null} />}
        {instance.kindId === "agy" && <Field label="agy.effort" value={instance.agy.effort ?? t("agentRuntime.providerDefault")} faint={instance.agy.effort === null} />}
        {instance.kindId === "claude" && <Field label="claude.baseUrl" value={instance.claude.baseUrl ?? t("agentRuntime.officialEndpoint")} faint={!instance.claude.baseUrlConfigured} />}
        {instance.kindId === "codex" && <><Field label="codex.baseUrl" value={instance.codex.baseUrl ?? t("agentRuntime.officialEndpoint")} faint={!instance.codex.baseUrlConfigured} /><Field label="codex.wire_api" value={instance.codex.wire_api ?? t("agentRuntime.providerDefault")} faint={instance.codex.wire_api === null} /><Field label="codex.requires_openai_auth" value={instance.codex.requires_openai_auth === null ? t("agentRuntime.providerDefault") : String(instance.codex.requires_openai_auth)} faint={instance.codex.requires_openai_auth === null} /><Field label="codex.http_headers" value={instance.codex.http_headers ? Object.entries(instance.codex.http_headers).map(([name, value]) => `${name}=${value}`).join(", ") : t("agentRuntime.providerDefault")} faint={instance.codex.http_headers === null} /></>}
      </FieldGrid></CardBody>
    </Card>

    <Card testId="runtime-card-auth">
      <CardHead><CardTitle>{t("agentRuntime.authTitle")}</CardTitle><Hint>{t(planeUsesApiOverride(instance.kindId) ? "agentRuntime.authClaudePlane" : plane.authShape === "separate" ? "agentRuntime.authCodexPlane" : "agentRuntime.authAgyPlane")}</Hint><Right><CapDot state={ready ? "full" : "none"} tip={instance.authReadiness.hint ?? t("agentRuntime.authVerified")} /></Right></CardHead>
      <CardBody>
        <div className="flex flex-wrap items-center gap-3">
          <Badge status={ready ? "done" : "blocked"}>{apiMode ? t("agentRuntime.authModeApiKey") : t("agentRuntime.authModeSubscription")} · {instance.authState}</Badge>
          <Hint>{instance.authReadiness.code ? `${instance.authReadiness.code}: ${instance.authReadiness.hint ?? ""}` : t("agentRuntime.authVerified")}</Hint>
          <span className="flex-1" />
          <Btn size="sm" disabled={busy} onClick={onValidate}>{t("agentRuntime.checkAuth")}</Btn>
          {!apiMode && <><Btn size="sm" disabled={busy} onClick={() => onAuth("login")}>{t("agentRuntime.signIn")}</Btn><Btn size="sm" disabled={busy} onClick={() => onAuth("reauth")}>{t("agentRuntime.reauth")}</Btn><Btn size="sm" variant="ghost" disabled={busy} onClick={() => onAuth("logout")}>{t("agentRuntime.signOut")}</Btn></>}
        </div>
        {apiMode && <p className="mt-2 text-[11px] text-text-faint">{t("agentRuntime.apiKeySealed")}</p>}
        {planeUsesApiOverride(instance.kindId) && <p className="mt-2 text-[11px] text-text-faint">{t(apiMode ? "agentRuntime.claudeApiOverrideOn" : "agentRuntime.claudeApiOverrideOff")}</p>}
      </CardBody>
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
          <Hint>ha runtime instance delete {instance.instanceId}</Hint>
        </div>
      </CardBody>
    </Card>
  </div>;
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
