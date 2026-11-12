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
