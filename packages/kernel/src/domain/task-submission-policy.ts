import { artifactLocatorKinds } from "./vertical-definition.ts";
import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Existing submission budgets and admission now run at the external-read boundary. */
export const taskSubmissionPolicies = [
  {
    id: "delivery-git-timeout",
    ownerRef: "task/submit",
    unit: "milliseconds",
    bounds:
      "Delivery fetch, ref checks and risk patches have a 30,000 ms process deadline; preparation never owns the repository write queue.",
    defaultValue: 30_000,
    version: 1,
    scope: "task-submit and task-settle delivery preparation",
    reason: "Preserve the existing fetch and risk-diff deadline at their single asynchronous implementation.",
    fixtures: ["packages/daemon/test/submit-pre-write.integration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/submission-delivery.ts#deliveryGitTimeoutMs:10e837f4984b76c17de7d7b40249e15b",
        route: "readBeforeWriteQueue → prepareTaskSubmission → prepareSubmissionDelivery",
      },
    ],
  },
  {
    id: "submission-preparation-admission",
    ownerRef: "task/submit",
    unit: "authenticated task execution",
    bounds:
      "Verify submit/settle executor claims before external reads and again at publication. Settlement rejoins through task-start only without a held lease or submitted cut; snapshot-only refusals precede all delivery processes.",
    defaultValue: null,
    version: 1,
    scope: "task submission preparation and optional settlement lease turn",
    reason: "Moving external reads does not grant a new lease or submission authority.",
    fixtures: [
      "packages/daemon/test/submit-pre-write.integration.test.ts",
      "packages/daemon/test/task-respond-review-rework.integration.test.ts",
      "packages/daemon/test/settle-lifecycle.contract.test.ts",
    ],
    sources: [
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/repo-cell-command-run.ts#makeRepoCellCommandRunner.run:dd1e7be352a8c7c2d5bb3db3f558bf69",
        route: "makeRepoCellCommandRunner → bindVerifiedExecutorClaim → readBeforeWriteQueue",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/submission-preparation.ts#prepareTaskSubmission:a06bab269fcde70f48a94f6dfa8c74f5",
        route: "readBeforeWriteQueue → optional task-start publication → prepareTaskSubmission",
      },
    ],
  },
] as const satisfies readonly OntologyPolicyDeclaration[];

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
        "policy:packages/kernel:packages/kernel/src/domain/task-submission-policy.ts#artifactLocatorPolicy.defaultValue.snapshotAdmissionKind:1877ba4ae95d218f0fe17f1488b31945",
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
        "policy:packages/kernel:packages/kernel/src/domain/task-submission-policy.ts#taskReviewAttributionPolicy.defaultValue.pageLimit:ca2856de4bc95158a6c363a63fee2f5e",
      route: "taskReviewAttributionPolicy",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
