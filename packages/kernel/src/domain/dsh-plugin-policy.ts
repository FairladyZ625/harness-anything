import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

export const dshBrokerPolicy = {
  id: "dsh-broker",
  ownerRef: "host",
  unit: "retained string units / milliseconds",
  bounds:
    "Retain the last 1000000 JavaScript string units of each output stream; allow 5000ms subprocess termination grace.",
  defaultValue: { outputLimit: 1_000_000, terminationGraceMs: 5_000 },
  version: 1,
  scope: "DSH Host CLI broker subprocess",
  reason: "Declare the existing output tail and termination budgets; slicing retains its original string semantics.",
  fixtures: ["packages/dsh-plugin/test/broker.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/dsh-plugin-policy.ts#dshBrokerPolicy.defaultValue.outputLimit:a7705cfeee2647952090be4a5a11d148",
      route: "dshBrokerPolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/dsh-plugin-policy.ts#dshBrokerPolicy.defaultValue.terminationGraceMs:9916d180768f7cce1c3ac218ec66fa0a",
      route: "dshBrokerPolicy",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

/** Exact renderer source contracts, following cliContractPolicy: these do not configure retries. */
export const dshPresentationPolicy = {
  id: "dsh-presentation-contract",
  ownerRef: "host",
  unit: "iframe referrer attribute / localized label",
  bounds:
    "The iframe uses no-referrer; Chinese and English retry fields are button text, with no attempt count or execution authority.",
  defaultValue: null,
  version: 1,
  scope: "DSH panel renderer and tutorial copy",
  reason:
    "Classify exact policy-shaped renderer syntax without moving localized copy into the domain or introducing a business retry policy.",
  fixtures: [
    "packages/dsh-plugin/test/panel.integration.test.ts",
    "packages/dsh-plugin/test/tutorial-content.test.ts",
    "tools/gates/test/ontology-closure.test.mjs",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/dsh-plugin:packages/dsh-plugin/src/client.ts#HarnessPanel.referrerPolicy:a8af98ed6a4dccc0279448399cb15be6",
      route: "HarnessPanel.referrerPolicy",
    },
    {
      candidateId:
        "policy:packages/dsh-plugin:packages/dsh-plugin/src/tutorial-content.ts#zh.retry:407f214996de48c8daa918b226efa94a",
      route: "zh.retry",
    },
    {
      candidateId:
        "policy:packages/dsh-plugin:packages/dsh-plugin/src/tutorial-content.ts#en.retry:25ccbba2dc25a8bf6c4eadd57e48f772",
      route: "en.retry",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
