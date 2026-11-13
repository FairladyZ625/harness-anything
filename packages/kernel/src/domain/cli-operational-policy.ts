import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Existing CLI budgets and admission defaults, shared without changing their effective values. */
export const cliOperationalPolicy = {
  id: "cli-operational",
  ownerRef: "host",
  unit: "attempts / milliseconds / rows / display columns / days",
  bounds:
    "Reconnect at most five consecutive unreachable reads; batches default to two and cap at 32; explicit waits cap at 60000ms; auto-claim requires an agent and caps concurrency at 64. Diagnostic and presentation budgets retain their existing values.",
  defaultValue: {
    taskCreateHelpRows: 20,
    reconnect: {
      unreachableAttempts: 5,
      initialOrdinal: 0,
      backoffMs: 250,
      exponentCeiling: 5,
      maximumBackoffMs: 5000,
    },
    batch: { defaultConcurrency: 2, maximumConcurrency: 32 },
    guidance: { factColumns: 74, titleColumns: 56 },
    backupDays: 30,
    waitMaximumMs: 60000,
    daemon: {
      warmingAttempts: 240,
      warmingPollMs: 250,
      streamTimeoutMs: 2000,
      stopAttempts: 500,
      stopPollMs: 10,
      unattempted: 0,
    },
    autoClaim: { minimumAgents: 1, defaultConcurrency: 1, maximumConcurrency: 64 },
    probe: {
      intervalMs: 5000,
      timeoutMs: 2000,
      slowMs: 1000,
      unresponsiveMs: 30000,
      cpuPercent: 90,
      cpuSustainMs: 60000,
      rssBytes: 8 * 1024 * 1024 * 1024,
      cooldownMs: 10 * 60000,
      keptDays: 7,
      sampleSeconds: 5,
      jsStackMethod: "daemon.diagnostics.stack",
    },
    probeMinimumIntervalMs: 250,
    probeMaximumTimeoutMs: 120000,
    slo: { defaultRows: 200, maximumRows: 10000, minimumRows: 1, exactHistogramMs: 5000, initialOverThresholdCount: 0 },
  },
  version: 1,
  scope: "CLI runtime subscriptions, batch invocation, daemon diagnostics and user guidance",
  reason:
    "Consumers read one authoritative declaration of the existing operating budgets; no new retry, timeout or quota is introduced.",
  fixtures: [
    "packages/cli/test/runtime-wait-reconnect.integration.test.ts",
    "packages/cli/test/runtime-batch-input.test.ts",
    "packages/cli/test/daemon-node-auto-claim.test.ts",
    "packages/cli/test/daemon-probe.test.ts",
    "packages/cli/test/daemon-slo.test.ts",
    "packages/cli/test/backup-retention.test.ts",
    "packages/cli/test/guidance-plane.test.ts",
  ],
  sources: [
    "policy:packages/cli:packages/cli/src/daemon/client.ts#settleRepoWarming.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "policy:packages/cli:packages/cli/src/daemon/control.ts#waitProcessExit.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "policy:packages/cli:packages/cli/src/daemon/control.ts#waitForDaemonStop.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.reconnect.unreachableAttempts:93fc8cd68bcb040fef15e6f844f86bfe",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.reconnect.backoffMs:1402e3a9db366642c9dc4eed20544900",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.reconnect.maximumBackoffMs:28a96fe4f9d6dcc1706bfdae80a151b1",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.batch.defaultConcurrency:ffa507c0146c322f150ed794f7b88053",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.batch.maximumConcurrency:609031f5e815e6e2754e6b70e0bc56d6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.daemon.warmingAttempts:a713c5567665b0f6732dc73b12646df6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.daemon.streamTimeoutMs:7c55d3f3455ee6034633d9e43c4d2c11",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.daemon.stopAttempts:81d4731c6892f78c265e560ef2438024",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.daemon.unattempted:daf6249eba700106f33c7091b5dae6aa",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.autoClaim.defaultConcurrency:97fc8713dfd2af3e14483caa90155e24",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.autoClaim.maximumConcurrency:0b79b51ba1434b3fd0cdd197e3819c13",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.autoClaim:a77ea46872363c64324066676cce84db",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.probe.timeoutMs:a883cef9fc71b79b83aa77c3644939a5",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.probeMaximumTimeoutMs:8061f5b2017d62000611cec850f7de46",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliOperationalPolicy.defaultValue.slo.initialOverThresholdCount:828a80fa895094734c3977a6f608ee01",
  ].map((candidateId) => ({ candidateId, route: "cliOperationalPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** DSH subprocess budgets retain their existing string-tail and millisecond semantics. */
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
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#dshBrokerPolicy.defaultValue.outputLimit:a7705cfeee2647952090be4a5a11d148",
      route: "dshBrokerPolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#dshBrokerPolicy.defaultValue.terminationGraceMs:9916d180768f7cce1c3ac218ec66fa0a",
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

/** CLI protocol switches and receipt shapes are exact contracts, with no tunable numeric budget. */
export const cliContractPolicy = {
  id: "cli-contract",
  ownerRef: "host",
  unit: "CLI flag / protocol discriminator / receipt shape",
  bounds:
    "Claim-next requires explicit true; the --claim alias selects the statement field; local runtime-instance creation explicitly permits HTTP. Artifact-run requires --. Return budgets are rendered only when numeric; retry diagnostics require their recorded shape; fleet serializers and redacted leases follow their declared codecs.",
  defaultValue: {
    claimNext: true,
    allowInsecureHttp: true,
    desktopReleasesUrl: "https://github.com/FairladyZ625/harness-anything/releases",
  },
  version: 1,
  scope: "CLI command projection and receipt presentation",
  reason:
    "Declare the existing input and presentation contracts separately from operational budgets; these switches do not grant server-side authority.",
  fixtures: ["packages/cli/test/thin-command-routing-parity.test.ts", "packages/cli/test/daemon-fleet-cli.test.ts"],
  sources: [
    "policy:packages/cli:packages/cli/src/cli-task-artifact-run.ts#parseTaskArtifactRunInvocation:acb5515436575da8cf8e63b4836bf01b",
    "policy:packages/cli:packages/cli/src/cli/receipt-render-task-show.ts#renderTaskShow:bdb3057e521c111059b83ad8d05b0a9b",
    "policy:packages/cli:packages/cli/src/cli/thin-command-projection.ts#projectedAliases.distill-promote.--claim:d4f6f96bdbb9916a86cbb0237a7309d4",
    "policy:packages/cli:packages/cli/src/daemon/client.ts#runCommandThroughDaemon:478b0693e9f67af270738a31196bcb7c",
    "policy:packages/cli:packages/cli/src/daemon/control-status.ts#assessDaemonStatus.retryingRows:93cd80e0aa19a932b1cc65753fcf9158",
    "policy:packages/cli:packages/cli/src/daemon/control-status.ts#assessDaemonStatus.assessedResult:7f56281694c256b618572a4901381955",
    "policy:packages/cli:packages/cli/src/daemon/fleet-payload-serializer.ts#validationFieldFromInput:c3c58eb5a6967991e4b439a064bd927d",
    "policy:packages/cli:packages/cli/src/daemon/fleet-status.ts#renderLeaseLines:c7f923f7f19edb31163e580291898e50",
    "policy:packages/cli:packages/cli/src/daemon/fleet-status.ts#renderLeaseLines:d80549067ac09d883baf8b4c0fd33f8d",
    "policy:packages/cli:packages/cli/src/daemon/node-auto-claim.ts#parseNodeAutoClaimControl.allowedSources:b24d150538a89242bc45049e9eee4801",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliContractPolicy.defaultValue.claimNext:9ec940e948571ceb7ef9f7873c0d3755",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliContractPolicy.defaultValue.allowInsecureHttp:6d4838a797f90fb393209b5f7e3d93ea",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#cliContractPolicy.defaultValue.desktopReleasesUrl:bc6cbfd04b4245e64edaa9110dd83e22",
  ].map((candidateId) => ({ candidateId, route: "cliContractPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

// dec_7E44897ECDCAEF2B92EC66A260/CH1: host-wide action catalog vocabulary and read budgets declared by the kernel.
export const hostKernelPolicies = [
  {
    id: "action-presentation",
    ownerRef: "host",
    unit: "action display name / policy tier",
    bounds:
      "Each declared action keeps its domain, Chinese display name and description; runtime-incident-dismiss keeps the maintainer policy tier so reclassification cannot widen who may dismiss.",
    defaultValue: null,
    version: 1,
    scope: "ActionDeclaration presentation and policy tier",
    reason: "Presentation text and tiers are exact catalog contracts, not tunable budgets.",
    fixtures: [
      "packages/kernel/test/contracts/policy-groups.test.ts",
      "packages/kernel/test/contracts/entity-action-execution.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.assignment-migrate:6d4902b6d7513f6ae14a12f1b9e19e23",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.daemon-node-auto-claim:e55f9588f91c339b2fcc87f975b9fb9a",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.decision-claim-add:0ee6d8995b45d8c03f11e29b228718e8",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.decision-claim-fulfill:a23aa913be507c022b96f0ff8bb2d3e2",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.migrate-storage:441fa7b88a51f526740a39454eb833b8",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.migrate-import:0cf77847647ac30ef63bc0b90c1896f2",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.runtime-handoff-claim:40d3b6b6c6637ec9a6caf6d7203938ca",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.schedule-claim:10ef4327d68fd287664eeae9177b1cb8",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.task-witness-claim:ded77a3a8cf798025362e8698bf752f2",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.task-contract-migrate:0b902fded32a7b6894e0453682736e8c",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.task-release:a7dabca95ecdba27ff06e8afb01ed5a7",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionPresentation.vertical-declaration-migrate:641834e35222c022084a4a2b1fac1fd0",
      "policy:packages/kernel:packages/kernel/src/domain/action-declaration.ts#actionDeclarations.policyTier:8a6387ae49c878241a3c643c1e1a5480",
    ].map((candidateId) => ({ candidateId, route: "actionPresentation" })),
  },
  {
    id: "action-concurrency-vocabulary",
    ownerRef: "host",
    unit: "idempotency retry mode / artifact ownership / occurrence fence",
    bounds:
      "Action catalogs choose retry from canonical-event-replay, private-operation-replay, state-transition and closeout-stage-resume; artifact ownership from typed-entity/v1, settings-facet/v1, runtime-local-no-canonical-event and per-dispatch-no-shared-overwrite; occurrence claims fence on the declared run or execution lease generation; same-actor active leases are idempotent-reuse on start and applied-no-op otherwise.",
    defaultValue: { replay: "canonical-event-replay", ownership: "typed-entity/v1" },
    version: 1,
    scope: "Entity action catalog concurrency declarations",
    reason: "The catalogs keep one shared concurrency vocabulary; no action changes its retry or ownership mode.",
    fixtures: [
      "packages/kernel/test/contracts/task-action-contract.test.ts",
      "packages/kernel/test/contracts/settings-action.test.ts",
      "packages/kernel/test/contracts/squad-action.test.ts",
      "packages/kernel/test/contracts/runtime-session-action.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/agent-action-contract.ts#createAgentActionCatalog.actions.concurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/agent-action-contract.ts#createAgentActionCatalog.actions.concurrency.artifactOwnership.policy:20645fb96fa39ee38211b2808a0eb831",
      "policy:packages/kernel:packages/kernel/src/domain/agent-action-contract.ts#createAgentActionCatalog.actions.concurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff:2",
      "policy:packages/kernel:packages/kernel/src/domain/agent-action-contract.ts#createAgentActionCatalog.actions.concurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff:3",
      "policy:packages/kernel:packages/kernel/src/domain/person-action-contract.ts#personConcurrency.idempotency.retry:a65042f17fee2b0b045db9c29cb224ed",
      "policy:packages/kernel:packages/kernel/src/domain/runtime-session-action-contract.ts#concurrency.idempotency.retry:0cc2df45fcafed5e46eb80318ab3504d",
      "policy:packages/kernel:packages/kernel/src/domain/runtime-session-action-contract.ts#concurrency.artifactOwnership.policy:fdf3c2cc24ee85f50e1be0801ffc55c4",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#scheduleConcurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#definitionConcurrency.artifactOwnership.policy:20645fb96fa39ee38211b2808a0eb831",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#occurrenceConcurrency.occurrenceClaim:0c33ce9e30ea527ab1fe82cd3e09318a",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#occurrenceConcurrency.occurrenceClaim.claimFence:380a4ea7f420b03c43662e1882609114",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#claimFenceConcurrency.occurrenceClaim:1b7a501444171dcdcad733adbae5a396",
      "policy:packages/kernel:packages/kernel/src/domain/schedule-action-contract.ts#declarations.concurrency.artifactOwnership.policy:20645fb96fa39ee38211b2808a0eb831",
      "policy:packages/kernel:packages/kernel/src/domain/settings-action-contract.ts#settingsConcurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/settings-action-contract.ts#settingsConcurrency.artifactOwnership.repositoryPolicy:5bdf3f9fbb5f39eb94fcb43e76d5f4f3",
      "policy:packages/kernel:packages/kernel/src/domain/settings-action-contract.ts#settingsConcurrency.artifactOwnership.localPolicy:84fc317eec4f0e107fef8af7d27299d4",
      "policy:packages/kernel:packages/kernel/src/domain/squad-action-contract.ts#installConcurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/squad-action-contract.ts#installConcurrency.artifactOwnership.policy:20645fb96fa39ee38211b2808a0eb831",
      "policy:packages/kernel:packages/kernel/src/domain/squad-action-contract.ts#runConcurrency.occurrenceClaim.claimFence:baa4a6d657dc2230ef263283a30720fd",
      "policy:packages/kernel:packages/kernel/src/domain/squad-action-contract.ts#declarations.concurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/task-action-contract.ts#mutationConcurrency.idempotency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/task-action-contract.ts#declarations.concurrency.sameActorActiveLease:290494bac87dc8de0668844666a70f1d",
      "policy:packages/kernel:packages/kernel/src/domain/task-action-contract.ts#declarations.concurrency.sameActorActiveLease:76cb3900f1629f52c0768fc47159dc47",
      "policy:packages/kernel:packages/kernel/src/domain/task-action-contract.ts#declarations.concurrency.retry:07cfb06bbdf2ce5bc3d4540d00cee5ff",
      "policy:packages/kernel:packages/kernel/src/domain/task-action-contract.ts#declarations.concurrency.retry:9eedeb81e5b492c9a976b953d20af19a",
      "policy:packages/kernel:packages/kernel/src/domain/todo-action-contract.ts#createTodoActionCatalog.actions.concurrency:192c1ff349a9ababf553d185adcb6094",
      "policy:packages/kernel:packages/kernel/src/domain/todo-action-contract.ts#createTodoActionCatalog.actions.concurrency.leasePolicy:55c37a1b3c234b85f69395d263e99417",
      "policy:packages/kernel:packages/kernel/src/domain/todo-action-contract.ts#createTodoActionCatalog.actions.concurrency.occurrenceClaim:f944f853338fd2ae894d521fa857e43e",
    ].map((candidateId) => ({ candidateId, route: "entity action concurrency" })),
  },
  {
    id: "host-read-budgets",
    ownerRef: "host",
    unit: "characters / rows / milliseconds / graph depth",
    bounds:
      "Canonical event summaries clip text to 280 characters; query payload limits are integers from 1 to 500; receipt waits default to 5000ms and accept 0 to 60000ms, polling until the deadline unless rejected or settled without a write; causal graph nodes at the depth limit report truncation instead of expanding.",
    defaultValue: {
      summaryCharacters: 280,
      queryRowsMaximum: 500,
      receiptWaitDefaultMs: 5000,
      receiptWaitMaximumMs: 60000,
    },
    version: 1,
    scope: "Kernel read, summary and receipt-wait helpers",
    reason: "Existing read bounds are declared once; callers keep paging and waiting with the same values.",
    fixtures: [
      "packages/kernel/test/domain/canonical-event-summary.test.ts",
      "packages/kernel/test/query-payload-validation.test.ts",
      "packages/kernel/test/contracts/receipt-acceptance.test.ts",
      "packages/kernel/test/domain/causal-graph-view.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/composition/receipt-acceptance.ts#waitForReceiptAcceptance:a20b052b996d32f3f8c7a9d2b534ec83",
      "policy:packages/kernel:packages/kernel/src/composition/receipt-acceptance.ts#waitForReceiptAcceptance:5d871efc30078e9c0e35ee79a2f30f70",
      "policy:packages/kernel:packages/kernel/src/domain/canonical-event-summary.ts#SUMMARY_TEXT_LIMIT:024dc36d3ea5d6062f003aeae92edf20",
      "policy:packages/kernel:packages/kernel/src/domain/causal-graph-view.ts#buildCausalGraphView.expand:afa116a1a29de7015717c42b3e994357",
      "policy:packages/kernel:packages/kernel/src/domain/query-payload-validation.ts#queryPayloadValidation:678fd416b948aa376419253e96fc6ad0",
    ].map((candidateId) => ({ candidateId, route: "kernel read budgets" })),
  },
  {
    id: "authorization-decision-binding",
    ownerRef: "host",
    unit: "policy reference / role tier",
    bounds:
      "An authorization decision applies only when its policyRef equals the action authorizationRef and its subject, actor, evaluation cut and a binding scope match the action; only the contributor tier also receives base entity and extra contributor scopes.",
    defaultValue: null,
    version: 1,
    scope: "Authorization port and derived base policy groups",
    reason: "Provider decisions stay bound to the exact evaluated action; tier composition is unchanged.",
    fixtures: [
      "packages/kernel/test/contracts/authorization-port.test.ts",
      "packages/kernel/test/contracts/policy-groups.test.ts",
    ],
    sources: [
      "policy:packages/kernel:packages/kernel/src/domain/policy-groups.ts#deriveBasePolicyGroups.exactScopes:5aa69633d4ef2479a73b84a61594c890",
      "policy:packages/kernel:packages/kernel/src/ports/authorization-port.ts#authorizationPort.authorize:d0b504cdaa1a58183f0910813eb14c1b",
    ].map((candidateId) => ({ candidateId, route: "authorizationPort.authorize" })),
  },
] as const satisfies readonly OntologyPolicyDeclaration[];
