import type { RuntimeInstanceSummary } from "../../../daemon/src/agent-runtime-instances.ts";

export type RuntimeAuthPresentationState = "ready" | "not-checked" | "not-ready" | "probe-error";
export type RuntimeAuthPresentation = { readonly state: RuntimeAuthPresentationState; readonly cap: "full" | "part" | "none"; readonly badge: "done" | "planned" | "blocked"; readonly error: string | null };

// The daemon owns authentication meaning. This adapter only maps its explicit
// readiness/code pair (plus a transport error) onto the GUI's visual vocabulary.
export function runtimeAuthPresentation(instance: RuntimeInstanceSummary, probeError: string | null = null): RuntimeAuthPresentation {
  if (probeError !== null) return { state: "probe-error", cap: "none", badge: "blocked", error: probeError };
  if (instance.authReadiness.status === "ready") return { state: "ready", cap: "full", badge: "done", error: null };
  if (instance.authReadiness.code === "runtime_auth_not_checked") return { state: "not-checked", cap: "part", badge: "planned", error: null };
  return { state: "not-ready", cap: "none", badge: "blocked", error: null };
}
