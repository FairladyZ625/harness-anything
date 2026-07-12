import type { WriteAttribution } from "../src/index.ts";

export function testWriteAttribution(
  actor: { readonly kind: "agent" | "human"; readonly id: string } = { kind: "agent", id: "test" }
): WriteAttribution {
  const principalId = actor.kind === "human" ? actor.id : "person_test";
  return {
    actor: {
      principal: { kind: "person", personId: principalId },
      executor: actor.kind === "agent" ? { kind: "agent", id: actor.id } : null
    },
    principalSource: {
      kind: "local-configured",
      authority: "harness.yaml",
      authoritySha256: "sha256:test"
    },
    executorSource: actor.kind === "agent" ? "client-asserted" : "none"
  };
}
