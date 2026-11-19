import { sha256Text } from "@harness-anything/kernel/internal/integrity/stable-hash.ts";
import type { AgentDefinitionSnapshot } from "@harness-anything/kernel";

type AgentDefinitionSnapshotEndpoint = {
  readonly endpointKind: "official" | "custom";
  readonly baseUrlHash: string | null;
};

export function agentDefinitionSnapshotEndpoint(baseUrl: string | null | undefined): AgentDefinitionSnapshotEndpoint {
  if (baseUrl === null || baseUrl === undefined || baseUrl === "")
    return { endpointKind: "official", baseUrlHash: null };
  const normalizedBaseUrl = URL.canParse(baseUrl) ? new URL(baseUrl).toString() : baseUrl,
    digest = sha256Text(normalizedBaseUrl).slice(0, 16);
  return { endpointKind: "custom", baseUrlHash: `sha256:${digest}` };
}

export function redactAgentDefinitionSnapshot(snapshot: AgentDefinitionSnapshot): AgentDefinitionSnapshot {
  const { baseUrl, ...safeSnapshot } = snapshot;
  return !Object.hasOwn(snapshot, "endpointKind")
    ? ({ ...safeSnapshot, ...agentDefinitionSnapshotEndpoint(baseUrl) } as unknown as AgentDefinitionSnapshot)
    : (safeSnapshot as unknown as AgentDefinitionSnapshot);
}
