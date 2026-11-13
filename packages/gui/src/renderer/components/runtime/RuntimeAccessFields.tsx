import { runtimeKindForId } from "@harness-anything/daemon/protocol";
import type { CreateInstanceFormState } from "../../runtime-instance-form.ts";
import { runtimeProviderPlane, runtimeWebSearchRestriction } from "../../runtime-provider-planes.ts";
import { t } from "../../i18n/index.tsx";

type AccessValues = Pick<CreateInstanceFormState, "permissionMode" | "mcpPolicy" | "isolation" | "webSearch">;
/** One set of controls for new and existing providers; the daemon remains the write authority. */
export function RuntimeAccessFields({
  value,
  onChange,
  testIdPrefix,
  busy = false,
}: {
  readonly value: AccessValues & {
    readonly kindId: string;
    readonly authMode: "subscription" | "api-key";
    readonly providerId: string;
    readonly baseUrl: string;
    readonly wireApi: string;
  };
  readonly onChange: (patch: Partial<AccessValues>) => void;
  readonly testIdPrefix: string;
  readonly busy?: boolean;
}) {
  const declaration = runtimeKindForId(value.kindId),
    plane = runtimeProviderPlane(value.kindId),
    lockedIsolation = value.authMode === "api-key" ? plane.apiKeyIsolation : plane.subscriptionIsolation,
    search = declaration.configuration.webSearch,
    restriction = runtimeWebSearchRestriction(value);
  return (
    <>
      {declaration.permissions.available && (
        <label className="grid min-w-0 gap-0.5">
          <span className="font-mono ui-micro text-text-faint">{t("agentRuntime.permissionMode")}</span>
          <select
            className="control"
            aria-label={t("agentRuntime.permissionMode")}
            data-testid={`${testIdPrefix}-permission-mode`}
            value={value.permissionMode}
            disabled={busy}
            onChange={(event) => onChange({ permissionMode: event.target.value as AccessValues["permissionMode"] })}
          >
            <option value="bypass">{t("agentRuntime.permissionBypass")}</option>
            <option value="workspace-write">{t("agentRuntime.permissionWorkspaceWrite")}</option>
            <option value="read-only">{t("agentRuntime.permissionReadOnly")}</option>
          </select>
        </label>
      )}
      {declaration.capabilities.mcp === "supported" && (
        <label className="grid min-w-0 gap-0.5">
          <span className="font-mono ui-micro text-text-faint">{t("agentRuntime.mcpPolicy")}</span>
          <select
            className="control"
            aria-label={t("agentRuntime.mcpPolicy")}
            data-testid={`${testIdPrefix}-mcp-policy`}
            value={value.mcpPolicy ?? "disabled"}
            disabled={busy}
            onChange={(event) => onChange({ mcpPolicy: event.target.value as AccessValues["mcpPolicy"] })}
          >
            <option value="disabled">{t("agentRuntime.mcpPolicyDisabled")}</option>
            <option value="inherit">{t("agentRuntime.mcpPolicyInherit")}</option>
          </select>
        </label>
      )}
      {declaration.isolation.states.length > 1 && (
        <label className="grid min-w-0 gap-0.5">
          <span className="font-mono ui-micro text-text-faint">
            {t(lockedIsolation === "enforced" ? "agentRuntime.apiKeyIsolation" : "agentRuntime.isolation")}
          </span>
          <select
            className="control"
            aria-label={t("agentRuntime.isolation")}
            data-testid={`${testIdPrefix}-isolation`}
            value={value.isolation}
            disabled={busy || lockedIsolation !== undefined}
            onChange={(event) => onChange({ isolation: event.target.value as AccessValues["isolation"] })}
          >
            {declaration.isolation.states.map((state) => (
              <option key={state} value={state} disabled={lockedIsolation !== undefined && lockedIsolation !== state}>
                {t(state === "enforced" ? "agentRuntime.instanceStateRoot" : "agentRuntime.operatorEnvironment")}
              </option>
            ))}
          </select>
        </label>
      )}
      {search && (
        <div className="grid min-w-0 gap-0.5">
          <label className="grid gap-0.5">
            <span className="font-mono ui-micro text-text-faint">{t("agentRuntime.webSearch")}</span>
            <select
              className="control"
              aria-label={t("agentRuntime.webSearch")}
              data-testid={`${testIdPrefix}-web-search`}
              value={value.webSearch ?? search.defaultMode}
              disabled={busy}
              onChange={(event) => onChange({ webSearch: event.target.value as AccessValues["webSearch"] })}
            >
              {search.modes.map((mode) => (
                <option key={mode} value={mode} disabled={mode !== search.defaultMode && restriction !== undefined}>
                  {t(`agentRuntime.webSearch_${mode}`)}
                </option>
              ))}
            </select>
          </label>
          {(restriction || value.baseUrl.trim()) && (
            <details className="ui-micro text-text-muted">
              <summary>{t("agentRuntime.webSearchAvailability")}</summary>
              {t(`agentRuntime.${restriction ?? "webSearchGatewayVerification"}`)}
            </details>
          )}
        </div>
      )}
    </>
  );
}
