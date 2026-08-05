import {
  strictArray,
  strictBoolean,
  strictEnum,
  strictLiteral,
  strictNumber,
  strictObject,
  strictString
} from "./strict-command-schema.ts";

const strings = strictArray(strictString);
const priority = strictEnum("low", "medium", "high");
const consentAction = strictEnum("approve_execution", "complete_task");
const consentActions = strictArray(consentAction);

const submission = strictObject({
  completionClaim: strictString,
  deliverables: strings,
  verificationNotes: strings,
  knownGaps: strings,
  residualRisks: strings,
  outputs: strings
});

const evidence = strictObject({
  type: strictString,
  path: strictString,
  summary: strictString
});

const closeoutReview = strictObject({
  verdict: strictEnum("approved", "changes_requested", "dismissed"),
  findings: strictString,
  evidenceChecked: strings,
  rationale: strictString,
  archiveWarningsAcknowledged: strictBoolean
}, {
  executionId: strictString,
  consentId: strictString,
  consentUtterance: strictString,
  consentStandingPolicyDecisionId: strictString,
  consentAssertedRationale: strictString,
  consentActions
});

const registerModule = strictObject({
  key: strictString,
  title: strictString,
  scope: strictString
}, {
  prefix: strictString
});

export const repoWriteTaskActionSchemas = {
  "new-task": strictObject({
    kind: strictLiteral("new-task"),
    title: strictString,
    slug: strictString,
    allowManualId: strictBoolean,
    titleProvided: strictBoolean,
    slugProvided: strictBoolean,
    longRunning: strictBoolean,
    dryRun: strictBoolean
  }, {
    taskId: strictString,
    idempotencyKey: strictString,
    parent: strictString,
    fromLegacyId: strictString,
    workKind: strictEnum("feat", "fix", "refactor", "docs", "test", "chore"),
    riskTier: priority,
    urgency: priority,
    vertical: strictString,
    preset: strictString,
    profile: strictString,
    moduleKey: strictString,
    registerModule,
    surfaces: strings,
    locale: strictEnum("zh-CN", "en-US")
  }),
  "task-claim": strictObject({
    kind: strictLiteral("task-claim"),
    taskId: strictString
  }, {
    ttlMs: strictNumber,
    execution: strictBoolean,
    executionId: strictString
  }),
  "task-start": strictObject({
    kind: strictLiteral("task-start"),
    taskId: strictString,
    dryRun: strictBoolean
  }, {
    ttlMs: strictNumber,
    executionId: strictString
  }),
  "task-release": strictObject({
    kind: strictLiteral("task-release"),
    taskId: strictString
  }),
  "task-retire-execution": strictObject({
    kind: strictLiteral("task-retire-execution"),
    taskId: strictString,
    executionId: strictString,
    reason: strictString,
    retiredAt: strictString
  }),
  "status-set": strictObject({
    kind: strictLiteral("status-set"),
    taskId: strictString,
    status: strictEnum("planned", "active", "blocked", "in_review", "done", "cancelled"),
    force: strictBoolean
  }, {
    reason: strictString
  }),
  "task-closeout": strictObject({
    kind: strictLiteral("task-closeout"),
    taskId: strictString,
    submission,
    review: closeoutReview,
    commitRef: strictString,
    paths: strings,
    forceCodeDoc: strictBoolean,
    ciGate: strictEnum("passed", "failed", "not-applicable"),
    reviewerId: strictString,
    dryRun: strictBoolean
  }, {
    executionId: strictString,
    leaseToken: strictString,
    prRef: strictString
  }),
  "progress-append": strictObject({
    kind: strictLiteral("progress-append"),
    taskId: strictString,
    text: strictString,
    dryRun: strictBoolean
  }, {
    evidence: strictArray(evidence)
  }),
  "task-amend": strictObject({
    kind: strictLiteral("task-amend"),
    taskId: strictString,
    patches: strictArray(strictObject({ field: strictString, value: strictString }))
  }),
  "task-contract-migrate": strictObject({
    kind: strictLiteral("task-contract-migrate"),
    mode: strictEnum("dry-run", "apply")
  }, {
    taskId: strictString
  }),
  "task-archive": strictObject({
    kind: strictLiteral("task-archive"),
    reason: strictString
  }, {
    taskId: strictString,
    ids: strings,
    filter: strictString,
    before: strictString,
    archivedBy: strictString,
    archiveField: strictString
  }),
  "task-supersede": strictObject({
    kind: strictLiteral("task-supersede"),
    oldTaskId: strictString,
    reason: strictString,
    allowOpenFindings: strictBoolean
  }, {
    title: strictString,
    slug: strictString,
    byTaskId: strictString,
    confirm: strictString,
    deletedBy: strictString
  }),
  "task-delete": strictObject({
    kind: strictLiteral("task-delete"),
    taskId: strictString,
    mode: strictEnum("soft", "hard"),
    reason: strictString
  }, {
    confirm: strictString,
    deletedBy: strictString
  }),
  "task-reopen": strictObject({
    kind: strictLiteral("task-reopen"),
    taskId: strictString,
    reason: strictString
  }),
  "task-code-doc-reconcile": strictObject({
    kind: strictLiteral("task-code-doc-reconcile"),
    taskId: strictString,
    sha: strictString,
    paths: strings,
    force: strictBoolean
  }, {
    prRef: strictString
  }),
  "task-review": strictObject({
    kind: strictLiteral("task-review"),
    taskId: strictString,
    reviewerId: strictString
  }),
  "task-consent-record": strictObject({
    kind: strictLiteral("task-consent-record"),
    taskId: strictString,
    executionId: strictString,
    consentActions
  }, {
    utterance: strictString,
    standingPolicyDecisionId: strictString,
    assertedRationale: strictString
  }),
  "task-review-execution": strictObject({
    kind: strictLiteral("task-review-execution"),
    taskId: strictString,
    verdict: strictEnum("approved", "changes_requested", "dismissed"),
    findings: strictString,
    evidenceChecked: strings,
    rationale: strictString,
    archiveWarningsAcknowledged: strictBoolean
  }, {
    executionId: strictString,
    executionSelectionError: strictString,
    consentId: strictString,
    generatedConsentId: strictString,
    consentUtterance: strictString,
    consentStandingPolicyDecisionId: strictString,
    consentAssertedRationale: strictString,
    consentActions
  }),
  "task-relate": strictObject({
    kind: strictLiteral("task-relate"),
    sourceTaskId: strictString,
    relationType: strictLiteral("depends-on"),
    targetTaskId: strictString,
    rationale: strictString,
    dryRun: strictBoolean
  })
} as const;
