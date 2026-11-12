import type { OntologyPolicyDeclaration } from "./ontology-source.ts";
import { artifactLocatorKinds } from "./vertical-definition.ts";

/** The locator vocabulary is shared; a snapshot still obeys its kind's declared admission set. */
export const artifactLocatorPolicy = {
  id: "artifact-locator-admission",
  ownerRef: "artifact",
  unit: "locator kind / import mode",
  bounds:
    "Snapshots admit declared locator kinds and infer repository-path only when declared; references require an explicit kind or URL and admit the shared locator vocabulary.",
  defaultValue: {
    snapshotAdmissionKind: "repository-path",
    referenceKinds: artifactLocatorKinds,
  },
  version: 1,
  scope: "Artifact import locator admission",
  reason: "Keep reference and snapshot admission at one declared boundary without changing accepted locators.",
  fixtures: ["packages/application/test/artifact-entity-service.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/application-policy.ts#artifactLocatorPolicy.defaultValue.snapshotAdmissionKind:1877ba4ae95d218f0fe17f1488b31945",
      route: "artifactLocatorPolicy",
    },
    {
      candidateId:
        "policy:packages/application:packages/application/src/artifact-entity-service.ts#resolveArtifactLocator:c650475a51c17b5620d7d147ad428c83",
      route: "resolveArtifactLocator",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

export const taskReviewAttributionPolicy = {
  id: "task-review-attribution",
  ownerRef: "task",
  unit: "indexed event descriptors",
  bounds: "Read at most 100 event descriptors at the requested revision; event payloads remain unread.",
  defaultValue: { pageLimit: 100 },
  version: 1,
  scope: "Task review attribution read model",
  reason: "Preserve the existing bounded evidence page shared by center and replica readers.",
  fixtures: ["packages/application/test/task-review-attribution.test.ts"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/application-policy.ts#taskReviewAttributionPolicy.defaultValue.pageLimit:ca2856de4bc95158a6c363a63fee2f5e",
      route: "taskReviewAttributionPolicy",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
