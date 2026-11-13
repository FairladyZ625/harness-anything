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
  {
    id: "task-submission-execution-admission",
    ownerRef: "task",
    unit: "admission constraints",
    bounds:
      "Enforce declared task admission, review packet shaping, risk-tier closeout consent, runtime settlement, and WIP capacity at canonical task boundaries.",
    defaultValue: null,
    version: 1,
    scope: "task submission, review packets, doc-sync candidates, and runtime settlement",
    reason: "Keep all daemon task admission and packet-shaping policy branches declared under the task ontology.",
    fixtures: [
      "packages/daemon/test/submit-pre-write.integration.test.ts",
      "packages/daemon/test/task-respond-review-rework.integration.test.ts",
    ],
    sources: [
      "policy:packages/daemon:packages/daemon/src/doc-sync-candidate-scanner.ts#canonicalProseBytes:b2d84d2b4a75d2fc7382602739140955",
      "policy:packages/daemon:packages/daemon/src/repo-cell-action-parse.ts#decisionProposalAction:088fa772b5013ced4a1aeca07bd199d2",
      "policy:packages/daemon:packages/daemon/src/repo-cell-doctor.ts#orphanLeaseCheck.items:aa16b1884f267de8d0a26d9ac87289ff",
      "policy:packages/daemon:packages/daemon/src/repo-cell-doctor.ts#wipPressureCheck.ratio:9b6b5b5b0576f68d90d59a1ded00f034",
      "policy:packages/daemon:packages/daemon/src/repo-cell-packets.ts#reviewPacket:0a25a881aeb9a19d6795b5b3bbf10e3f",
      "policy:packages/daemon:packages/daemon/src/repo-cell-packets.ts#reviewResponsePacket:0c42a732aaaaf0102ef1e0796fc2c0d1",
      "policy:packages/daemon:packages/daemon/src/repo-cell-packets.ts#reviewWaiverLine:2e7ae01cc1c087ae8565a706aade5b43",
      "policy:packages/daemon:packages/daemon/src/repo-cell-review-lint.ts#legacyReviewLint:8e6baab2b4eb85717878a94e39926346",
      "policy:packages/daemon:packages/daemon/src/repo-cell-runtime-ingress.ts#appendAuxiliaryRuntimeIngress.blobs:1ec753ce74a9f77e25994bf96c47611c",
      "policy:packages/daemon:packages/daemon/src/repo-cell-runtime-settlement.ts#commitRuntimeSettlement:dcc7932611b6c3eed8d717c028fbdfb4",
      "policy:packages/daemon:packages/daemon/src/repo-cell-submit.ts#riskTierCloseoutGates.consent:9aaa76c67c4beb1ba16d08a5cb0fda83",
      "policy:packages/daemon:packages/daemon/src/repo-cell-submit.ts#riskTierCloseoutGates.consent:0a8f90b7b22409ed000115b2fb101145",
      "policy:packages/daemon:packages/daemon/src/repo-cell-task-command-docs.ts#runTaskCommandWithDocs.intent.executionId:aa0cc6f684939e370d5ac3d320a8ec40",
      "policy:packages/daemon:packages/daemon/src/repo-cell-task-command-docs.ts#runTaskCommandWithDocs.adjudication:99a191fc7935690958517f8e16fdcea2",
      "policy:packages/daemon:packages/daemon/src/repo-cell-task-create.ts#prepareTaskCreateAt:ccc677f351a521b1422a8d39f3e21176",
      "policy:packages/daemon:packages/daemon/src/repo-cell-task-create.ts#prepareTaskCreateAt:be478a9d7bb8fe037b15d730854afaee",
      "policy:packages/daemon:packages/daemon/src/repo-cell-task-query.ts#assertTaskWipCapacity:a36502dfe96f03ebd1a4dce6b96b8bb6",
    ].map((candidateId) => ({ candidateId, route: "taskSubmissionPolicies" })),
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

// dec_7E44897ECDCAEF2B92EC66A260/CH1: task aggregate rules declared at their existing kernel owners.
export const taskKernelPolicies = [
  {
    id: "task-review-completion",
    ownerRef: "task",
    unit: "review consent / completion override / return budgets",
    bounds:
      "Manual gates cannot be mandatory-signoff or overridable; only a declared allowOverride gate may be waived and only without a human waiver or submission-bound automated witness. Owner consent accepts a selected changes_requested review only after its disposition. A high effective risk tier requires consent. Review return and rework budgets are positive safe integers, and receipts carry only valid risk-tier advice and assessments.",
    defaultValue: { consentRequiredAt: "high", minimumReturns: 1 },
    version: 1,
    scope: "Task completion contract, closeout readiness, review consent and write receipts",
    reason: "Completion and review admission keep their existing rules under one task-owned declaration.",
    fixtures: [
      "packages/kernel/test/domain/completion-contract.test.ts",
      "packages/kernel/test/domain/review-consent-validity.test.ts",
      "packages/kernel/test/domain/task-completion-consent-reason.test.ts",
      "packages/kernel/test/domain/task-review-response-transitions.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/closeout-readiness.ts#judgeGateWitnesses.waivable:9763e9b894cb805db2cc1ed85f5102da",
      "policy:packages/kernel:packages/kernel/src/domain/closeout-readiness.ts#judgeGateWitnesses:2dfe854b2c340a4f5eae2629dcdc5d4d",
      "policy:packages/kernel:packages/kernel/src/domain/completion-contract.ts#frozenRequirement:51e8bf471d3f1a3849bb737046f71225",
      "policy:packages/kernel:packages/kernel/src/domain/completion-contract.ts#resolveCompletionContract:959520ff2d88fdf1a286f08f7941aef6",
      "policy:packages/kernel:packages/kernel/src/domain/completion-contract.ts#resolveCompletionContract.allowOverride:0307849d69caa87c2ee562f1caed0b74",
      "policy:packages/kernel:packages/kernel/src/domain/completion-readiness.ts#consentRequirementReason:f5a3bbe33ef78f3f1f178a954ff55a71",
      "policy:packages/kernel:packages/kernel/src/domain/receipt-domain-registry.ts#validateWriteReceipt:94c47af45c68062c1cb5bb10c32858d5",
      "policy:packages/kernel:packages/kernel/src/domain/receipt-domain-registry.ts#validateWriteReceipt:7c2363e466cf91526ca5da57e4640d5f",
      "policy:packages/kernel:packages/kernel/src/domain/review-consent-validity.ts#reviewConsentConflicts:424b0c5db7b0f8ea9c56368eda72d159",
      "policy:packages/kernel:packages/kernel/src/domain/review.ts#consentedApprovedReviewForExecution:cdb7b219afb311fb3f3d84bc68945810",
      "policy:packages/kernel:packages/kernel/src/domain/review.ts#consentedApprovedReviewForExecution.allowSelectedChangesRequested:f9f6564242ed8c8938724d1e0e3af0f3",
      "policy:packages/kernel:packages/kernel/src/domain/settings.ts#gateSettingsSchema.items.properties.allowOverride:c468b7690a370b7628b20578c485512d",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-review-transitions.ts#reviewIssues:251cf8523701cd132b73931063fecda0",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-review-transitions.ts#consent.validate.conflicts.allowSelectedChangesRequested:f9f6564242ed8c8938724d1e0e3af0f3",
      "policy:packages/kernel:packages/kernel/src/domain/task.ts#validateTaskV2:33b6554c913b9aef09af1b983d538dd5",
    ].map((candidateId) => ({ candidateId, route: "task review and completion" })),
  },
  {
    id: "task-status-transition",
    ownerRef: "task",
    unit: "domain status transition",
    bounds:
      "A status may stay unchanged or move only along allowedStatusTransitions; terminal statuses explain terminal_status and other refusals unsupported_transition. Block, unblock and cancel additionally require no live lease and a different target status; block also requires the implementation node.",
    defaultValue: null,
    version: 1,
    scope: "explainStatusTransition and the task block/unblock/cancel commands",
    reason: "Status moves are explained by one table; the commands reuse it without a second transition rule.",
    fixtures: [
      "packages/kernel/test/domain/domain-status.test.ts",
      "packages/kernel/test/contracts/task-lifecycle-initialization.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/lifecycle-status.ts#explainStatusTransition.allowed:d3583fbbe4fa23918ff42c68ae84c60d",
      "policy:packages/kernel:packages/kernel/src/domain/lifecycle-status.ts#explainStatusTransition.allowed:d3583fbbe4fa23918ff42c68ae84c60d:2",
      "policy:packages/kernel:packages/kernel/src/domain/lifecycle-status.ts#explainStatusTransition.allowed:f0ce3ef598574b1ebe708af042563f87",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#block.validate:0d2653ace56ef051d0e46cb12990af45",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#unblock.validate:2a003ff1b0c7caf9d44f0e6d19a5ae05",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-command-transitions.ts#cancel.validate:914f6222d9e61c4faca6f533cc2e353d",
    ].map((candidateId) => ({ candidateId, route: "explainStatusTransition" })),
  },
  {
    id: "completion-gate-run",
    ownerRef: "task/witness",
    unit: "gate run fence / pass ratio / CI run attempt",
    bounds:
      "Only the holder of the current submission run and fence may publish a gate run, before it expires; a renewed source run retires only an expired GitHub Actions claim. Skill evaluations start at fence 1 and pass when passed/total meets a threshold in (0, 1]. GitHub and GitLab observations bind runId to databaseRunId.runAttempt and require positive verification attempts.",
    defaultValue: { initialFence: 1, passRatioMaximum: 1 },
    version: 1,
    scope: "Completion gate runs, skill evaluation gates and CI run observations",
    reason: "Gate witnesses keep their existing fencing and pass rules under the task completion owner.",
    fixtures: [
      "packages/kernel/test/completion-source.test.ts",
      "packages/kernel/test/skill-eval-gate.test.ts",
      "packages/kernel/test/contracts/ci-run-observation-event.test.ts",
      "packages/kernel/test/contracts/task-lifecycle-replay.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/ci-run-observation-v4.ts#validateCiRunObservationEventV4:1e8f75d71d8d6f3750ab7cf35244e123",
      "policy:packages/kernel:packages/kernel/src/domain/ci-run-observation-v4.ts#validateCiRunObservationEventV4:d5e1b9c24e2b268c9290e9362955417c",
      "policy:packages/kernel:packages/kernel/src/domain/gate-run-publication.ts#replaceClaimedRun:8d9bee6ae5bb0fabb7e16fde1c4443ef",
      "policy:packages/kernel:packages/kernel/src/domain/gate-run.ts#settleGateRun:a7c50f9c787678735f5d423db50ba677",
      "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#assertReplay:7313f9e102e78c1bb95ae1504c19750b",
      "policy:packages/kernel:packages/kernel/src/skill-eval-gate.ts#declaration.sources.resultSchema.properties.threshold:886d706450fc9d9e0b62e8b8ec383400",
      "policy:packages/kernel:packages/kernel/src/skill-eval-gate.ts#judgeSkillEvaluation.run.claimFence:be29b81881629307de842e8efbde4fb8",
      "policy:packages/kernel:packages/kernel/src/skill-eval-gate.ts#validateOutcome:75c0c9685011761e76f3c4d9437401cf",
    ].map((candidateId) => ({ candidateId, route: "completion gate run" })),
  },
] as const satisfies readonly OntologyPolicyDeclaration[];

export const executionDelegationPolicy = {
  id: "execution-delegation",
  ownerRef: "execution",
  unit: "delegated actions / executor declaration",
  bounds:
    "A delegated execution token lists at least one valid action name; an executor declaration names an eligible agent executor on the current execution with a reason and a workspace revision newer than the snapshot.",
  defaultValue: null,
  version: 1,
  scope: "Delegated execution tokens and execution executor declarations",
  reason: "Delegation admission is declared once; token and replay validation keep their existing checks.",
  fixtures: [
    "packages/kernel/test/contracts/delegated-execution-token.test.ts",
    "packages/kernel/test/contracts/task-lifecycle-replay.test.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/delegated-execution-token.ts#validateDelegatedExecutionToken:b269eb7a26a1eb6e4cbd1c8c88f896bd",
    "policy:packages/kernel:packages/kernel/src/domain/task-lifecycle-replay.ts#compileExecutionExecutorDeclaration:3f38832e263dbb1a4535c6c3df71c0c3",
  ].map((candidateId) => ({ candidateId, route: "execution delegation" })),
} as const satisfies OntologyPolicyDeclaration;
