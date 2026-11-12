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
