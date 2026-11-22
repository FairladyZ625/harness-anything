import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Physical execution location. The dispatch owner and execution lease remain independent of it. */
export type RuntimeExecutionTarget = { readonly kind: "local" } | { readonly kind: "cloud"; readonly hostId: string };

export type CloudRuntimeExecutionTarget = Extract<RuntimeExecutionTarget, { readonly kind: "cloud" }>;

export function isCloudRuntimeExecutionTarget(value: unknown): value is CloudRuntimeExecutionTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    "kind" in value &&
    value.kind === "cloud" &&
    "hostId" in value &&
    typeof value.hostId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(value.hostId)
  );
}

/** Cloud control budget is scoped to the registered transport. */
export const cloudSandboxPolicy = {
  id: "cloud-sandbox",
  ownerRef: "runtime-session/run",
  unit: "frames / bytes / milliseconds / attempts",
  bounds:
    "Read up to 32 frames of 65536 bytes and hold up to 64 pending steers. Calls allow up to three 1500ms tries in a 5000ms budget. Reconciliation starts at 500ms, with backoff capped at five doublings.",
  defaultValue: {
    pageSize: 32,
    frameLimitBytes: 64 * 1024,
    pollMs: 500,
    operationBudgetMs: 5_000,
    transportTimeoutMs: 1_500,
    retryLimit: 3,
    retryBaseMs: 100,
    pollFailureExponentLimit: 5,
    pendingSteerLimit: 64,
  },
  version: 1,
  scope: "cloud sandbox host transport",
  reason: "Bound each operation and avoid synchronized retries after shared host failures.",
  fixtures: ["packages/daemon/test/runtime-execution-target.integration.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.operationBudgetMs:5b2829e6d49a7523951fbdb4f38c6a24",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.transportTimeoutMs:bd1a1de1544267a364b80be48cc8a60d",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.retryLimit:51f09d4a96bae096c0e4e4270e727117",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.retryBaseMs:4e0fd93e202622f22c4fb86301d0a6bb",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.pollFailureExponentLimit:f9fb94c809b67411bc1172a8ada71faa",
    "policy:packages/kernel:packages/kernel/src/domain/runtime-execution-target.ts#cloudSandboxPolicy.defaultValue.pendingSteerLimit:a6e34ebfd687ffad1813514d16d01439",
    "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-cloud-target.ts#openCloudRuntime:0f53490a66646ec788314f2f2f1c9076",
    "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-cloud-target.ts#openCloudRuntime.invoke:dab44a06ad449e71f31cb9cba2df6419",
    "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-cloud-target.ts#openCloudRuntime.accept:58a9f0747caa93ac82878cc461d1d825",
    "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-cloud-target.ts#openCloudRuntime.accept:0deb55d338aad3702491879b1574b33e",
    "policy:packages/daemon:packages/daemon/src/daemon-host/runtime-cloud-target.ts#openCloudRuntime.observe:81d9fa821d20e4f1c223e18ac26cfc7e",
  ].map((candidateId) => ({ candidateId, route: "cloud sandbox host transport" })),
} as const satisfies OntologyPolicyDeclaration;
