import type { SettingsV1 } from "@harness-anything/kernel";
import type { RuntimeInstanceSummary } from "./agent-runtime-instances.ts";
import { applyLocalAgentBinding } from "./runtime-spawn-agent.ts";
import type { RuntimeAgent } from "./runtime-spawn-types.ts";
import { transitionDocumentReadinessContract } from "./transition-document-access.ts";

/**
 * The mirrored task contract carries the plan's readiness contract in its descriptor; packages
 * materialized before descriptors carried it resolve through the bundled catalog their
 * templateRef names. An unresolvable contract fails closed here.
 */
export function mirroredPlanContract(
  contractBody: string | null,
  taskId: string,
  createError: (code: string, message: string) => Error,
) {
  let contractJson: unknown;
  try {
    if (contractBody === null) throw new Error("task contract unavailable");
    contractJson = JSON.parse(contractBody);
  } catch {
    throw createError(
      "runtime_task_package_unavailable",
      `Task ${taskId} has no readable mirrored task contract; run ha daemon fleet edge sync, then retry.`,
    );
  }
  const descriptor =
      contractJson && typeof contractJson === "object" && !Array.isArray(contractJson)
        ? (contractJson as { readonly documents?: unknown }).documents
        : undefined,
    planDescriptor = Array.isArray(descriptor)
      ? descriptor.find(
          (row): row is { readonly slot: string; readonly path: string } =>
            !!row &&
            typeof row === "object" &&
            (row as { readonly slot?: unknown }).slot === "task.plan" &&
            typeof (row as { readonly path?: unknown }).path === "string",
        )
      : undefined,
    contract = planDescriptor
      ? transitionDocumentReadinessContract({ contract: contractJson, descriptor: planDescriptor })
      : null;
  if (contract === null)
    throw createError(
      "runtime_task_package_unavailable",
      `Task ${taskId} plan scaffold is not resolvable from the mirrored package; run ha daemon fleet edge sync, then retry.`,
    );
  return { planContract: contract };
}

export function resolveReviewPublicationInstanceCandidates(input: {
  readonly implementationInstanceId: unknown;
  readonly selectedInstanceId: string | undefined;
  readonly intentInstanceId: string | undefined;
  readonly preferredInstanceId: string | undefined;
  readonly agentId: string | undefined;
  readonly readSettings: () => SettingsV1;
  readonly findAgent: (agentId: string) => RuntimeAgent | undefined;
  readonly localInstances: readonly RuntimeInstanceSummary[];
}): readonly string[] {
  const declaration = input.agentId ? input.findAgent(input.agentId) : undefined,
    agent = declaration ? applyLocalAgentBinding({ readSettings: input.readSettings }, declaration) : undefined;
  const localIds = new Set(input.localInstances.map((instance) => instance.instanceId));
  const enabledLocal = input.localInstances.filter((instance) => instance.enabled);
  const configuredLocal = enabledLocal.filter((instance) => instance.hostingCredentialState === "configured");
  const candidates = [
    typeof input.implementationInstanceId === "string" ? input.implementationInstanceId : undefined,
    input.selectedInstanceId,
    input.intentInstanceId,
    input.preferredInstanceId,
    agent?.instance,
    ...(agent?.preferredInstances ?? []),
    ...configuredLocal.map((instance) => instance.instanceId),
    ...enabledLocal.map((instance) => instance.instanceId),
  ];
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const id of candidates) {
    if (typeof id !== "string" || !id || seen.has(id) || !localIds.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}
