import type { RuntimeInstanceSummary } from "../../../daemon/src/agent-runtime-instances.ts";
import { t } from "./i18n/index.tsx";

export type RuntimeAuthProbeState =
  { readonly state: "not-started" } | { readonly state: "probing" } |
  { readonly state: "succeeded" } | { readonly state: "failed"; readonly error: string };
export type RuntimeAuthPresentationState = RuntimeAuthProbeState["state"];
export type RuntimeAuthPresentation = { readonly state: RuntimeAuthPresentationState; readonly cap: "full" | "part" | "none"; readonly badge: "done" | "planned" | "blocked"; readonly error: string | null };

// The daemon owns authentication meaning. This adapter only maps its explicit
// readiness/code pair (plus a transport error) onto the GUI's visual vocabulary.
export function runtimeAuthPresentation(instance: RuntimeInstanceSummary, probe: RuntimeAuthProbeState =
  instance.authReadiness.code === "runtime_auth_not_checked" ? { state: "not-started" } :
    { state: "succeeded" }): RuntimeAuthPresentation {
  if (probe.state === "failed") return { state: probe.state, cap: "none", badge: "blocked", error: probe.error };
  if (probe.state === "probing" || probe.state === "not-started")
    return { state: probe.state, cap: "part", badge: "planned", error: null };
  return instance.authReadiness.status === "ready"
    ? { state: probe.state, cap: "full", badge: "done", error: null }
    : { state: probe.state, cap: "none", badge: "blocked", error: null };
}
export function runtimeAuthPresentationText(
  instance: RuntimeInstanceSummary,
  presentation: RuntimeAuthPresentation
): string {
  if (presentation.state === "not-started") return t("agentRuntime.authNotChecked");
  if (presentation.state === "probing") return t("agentRuntime.authProbing");
  if (presentation.state === "failed")
    return t("agentRuntime.authProbeFailed", { error: presentation.error ?? "" });
  return instance.authReadiness.status === "ready" ? t("agentRuntime.authVerified") :
    `${instance.authReadiness.code}: ${instance.authReadiness.hint}`;
}
