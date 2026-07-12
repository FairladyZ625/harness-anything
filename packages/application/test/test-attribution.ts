import type { WriteAttribution } from "../../kernel/src/index.ts";

export function writeAttribution(personId: string, executorId: string): WriteAttribution {
  return {
    actor: {
      principal: { kind: "person", personId },
      executor: { kind: "agent", id: executorId }
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: "sha256:test"
    },
    executorSource: "client-asserted"
  };
}
