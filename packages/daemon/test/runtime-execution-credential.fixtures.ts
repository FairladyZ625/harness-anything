import { KeycloakPolicyAdapter } from "@harness-anything/authorization-keycloak";
import { runtimeExecutionLifetimeMs } from "../src/runtime-execution-credential.ts";
import { dispatchLifecycleReadOf, lifecycleEvent } from "./dispatch-lifecycle-read.fixtures.ts";

export const center = {
  provider: new KeycloakPolicyAdapter({
    url: "http://realm.invalid",
    realm: "harness",
    resourceServerClientId: "harness-center",
  }),
  url: "http://realm.invalid",
  realm: "harness",
  clientId: "harness-center",
  accessToken: "center-token",
};
export const principal = () => ({
  personId: "person-worker",
  repoId: "repo",
  runtimeSessionId: "runtime-worker",
  dispatchId: "dispatch-worker",
  taskId: "task-worker",
  executionId: "execution-worker",
  role: "implementation" as const,
  source: "local" as const,
  expiresAt: new Date(Date.now() + runtimeExecutionLifetimeMs - 1000).toISOString(),
});

export function executionLifecycle(
  projection: { readRuntimeSession: (id: string) => any; readRuntimeDispatch: (id: string) => any },
  query: any,
) {
  const session = projection.readRuntimeSession(query.runtimeSessionId);
  if (!session) return { status: "ready", watermark: 0, sourceRevision: 0, rows: [], nextCursor: null };
  const dispatch = projection.readRuntimeDispatch(query.runtimeSessionId),
    options = {
      source: dispatch?.source ?? "local",
      instanceId: "fixture",
      dispatchId: dispatch?.payload.dispatchId ?? "missing",
    },
    events = [
      lifecycleEvent("R", query.runtimeSessionId, options),
      lifecycleEvent("S", query.runtimeSessionId, options),
    ];
  if (session.liveness === "exited") events.push(lifecycleEvent("X", query.runtimeSessionId, options));
  if (session.outcome !== null && session.outcome !== undefined) {
    const event = lifecycleEvent("O", query.runtimeSessionId, options);
    events.push({ ...event, payload: { ...event.payload, outcome: session.outcome } } as never);
  }
  return dispatchLifecycleReadOf(() => events)(query);
}
