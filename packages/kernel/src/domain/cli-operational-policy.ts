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

/**
 * dec_7E44897ECDCAEF2B92EC66A260/CH1: daemon runtime, terminal and evaluation
 * boundaries share the existing host Policy registry. These are the unchanged
 * operating defaults; daemon consumers derive their values from this declaration.
 */
export const daemonRuntimePolicy = {
  id: "daemon-runtime",
  ownerRef: "host",
  unit: "concurrency / bytes / milliseconds / seconds / characters / cases / pass ratio",
  bounds:
    "Runtime batches default to two and cap at 32; provider diagnostics cap at 65536 bytes; resume admission and exit notification each wait at most 30000ms; process-table probes wait 10000ms; ACP cancellation waits 2000ms before SIGTERM. Health fallback cooldowns are 30/300 seconds with freezing after five failures for 1800 seconds. Runtime model slots cap at 64 globally and per owner; worktree-head probes wait 5000ms, GitHub credential probes 10000ms, handoff Git calls 30000ms, task publication 30000ms, worker pushes 60000ms and Windows process-group probes 15000ms. Outcome waiters recheck every 5000ms. The cloud dispatch relay caps bodies at 2097152/8388608 bytes, output at 32768 tokens, generations at 16 by default and 10000 maximum, reserves 2000000 micros for code runs, limits upstream concurrency to two and applies 600000/125000/10000ms upstream/request/header timeouts. Continuation summaries cap at 8192 characters. Terminal snapshots wait 4000ms, buffers retain 1048576/262144/262144 bytes, exit drain waits 5000ms, and activity persists every 10000ms. Skill evaluations default to a full-pass threshold, allow 20 cases with 64-character ids and 20000-character inputs, and admit two model runs.",
  defaultValue: {
    batch: { defaultConcurrency: 2, maximumConcurrency: 32 },
    process: {
      providerErrorLimit: 64 * 1024,
      resumeAdmissionTimeoutMs: 30_000,
      exitNotificationTimeoutMs: 30_000,
      processTableTimeoutMs: 10_000,
    },
    acp: { cancelGraceMs: 2_000 },
    health: {
      cooldownBaseSeconds: 30,
      cooldownMaxSeconds: 300,
      freezeAfter: 5,
      freezeDurationSeconds: 1_800,
    },
    runtime: {
      modelSlots: { globalCapacity: 64, perOwnerCapacity: 64 },
      currentWorktreeHeadTimeoutMs: 5_000,
      githubCredentialProbeTimeoutMs: 10_000,
      handoffGitTimeoutMs: 30_000,
      taskPublicationTimeoutMs: 30_000,
      workerPushTimeoutMs: 60_000,
      windowsProcessGroupTimeoutMs: 15_000,
      continuationConclusionLimit: 8_192,
      outcomeRecheckMs: 5_000,
      cloudDispatchRelay: {
        maxBodyBytes: 2 * 1024 * 1024,
        maxResponseBytes: 8 * 1024 * 1024,
        outputCapTokens: 32_768,
        requestOverheadTokens: 20_000,
        codeReserveMicros: 2_000_000,
        defaultMaxGenerations: 16,
        maximumGenerations: 10_000,
        upstreamTimeoutMs: 600_000,
        requestTimeoutMs: 125_000,
        headersTimeoutMs: 10_000,
        defaultMaxUpstreamConcurrency: 2,
      },
    },
    terminal: {
      loginShellSnapshotTimeoutMs: 4_000,
      scrollbackLimit: 1024 * 1024,
      replayLimit: 256 * 1024,
      subscriberLimit: 256 * 1024,
      ptyExitDrainMs: 5_000,
      activityPersistIntervalMs: 10_000,
    },
    skillEvaluation: {
      defaultThreshold: 1,
      maxCases: 20,
      maxCaseIdLength: 64,
      maxInputLength: 20_000,
      modelSlots: 2,
    },
  },
  version: 1,
  scope: "daemon runtime, terminal, process-port and skill-evaluation subsystems",
  reason:
    "Close the daemon runtime ontology boundary through the existing host Policy registry while preserving every online default; consumers must derive operating budgets from this single declaration.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.batch.defaultConcurrency:ffa507c0146c322f150ed794f7b88053",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.batch.maximumConcurrency:609031f5e815e6e2754e6b70e0bc56d6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.process.resumeAdmissionTimeoutMs:49eb6422ac7e9067ff76aeed9c09ac84",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.process.exitNotificationTimeoutMs:d70f9a5cbbf923c472d612c37b4981a1",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.acp.cancelGraceMs:abf02fbf305350f4cc499a130e5d152b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.terminal.loginShellSnapshotTimeoutMs:29a5fa63f10f805cd8161f6d18d680e5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.process.processTableTimeoutMs:8605b920276aa7094300c0de38d0df26",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.modelSlots.globalCapacity:364f2690112a4e8422a55a585cd8ea63",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.modelSlots.perOwnerCapacity:d226771b4061115c649e7eb837e12eec",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.currentWorktreeHeadTimeoutMs:bd7a3d804fa3439b5eb5e52df87eaecb",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.githubCredentialProbeTimeoutMs:5ef2d5ea5badd8718f929fed3593349d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.handoffGitTimeoutMs:b9000c06635a7b3f06c7b79cd0efa0aa",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.taskPublicationTimeoutMs:f103e2ab70181b74d2082d3da83eedc9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.workerPushTimeoutMs:d84a6604d26fc589bb22167731d37a2e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.windowsProcessGroupTimeoutMs:f7c4de0e894a34bae53a0de11bdb3d4d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.runtime.continuationConclusionLimit:0fac8d885c80aa4024af9490c1eccaa5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonRuntimePolicy.defaultValue.skillEvaluation.defaultThreshold:3af873bef5b24bf44fa2a15c5de4c990",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/agent-runtime-instance-config.ts#runtimeInstanceConfig:3e75c917fa97f3f11361b120ecb27cd4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/agent-runtime-instance-config.ts#runtimeInstanceConfig:ad4a0b78e66f3154bace78e2e10f68df",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/agent-runtime-instance-storage.ts#ensureSharedAuthFile.retryDelay:a38f533782efe76e8e50dba711b96f64",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/process-port.ts#launchProcessText.child:2098982cebd838077098ec255724c782",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/process-port.ts#launchProcessText.timeout:a3b068b32021a7dffa0815ada149c02a",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-continuation-context.ts#conclusionLimit:fe79749e1637c0e3ca6ff12cded11822",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-continuation-context.ts#currentWorktreeHead.result.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-dispatch-evidence.ts#correlationValueLimit:a872cb745b61dbc709aaf7c8ee3c182e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-execution-scope.ts#isCurrentSubmittedWorkerWrite:6a36662642580dfd4a7a7fcf0d5fc936",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-github-credentials.ts#tokenProbeTimeoutMs:7217d271c6c55243f6c2ef3077aabf74",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-handoff-native.ts#prepareRuntimeHandoff.runGit.timeout:74baa14f0593fb06f9712e9ba19bf3f6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-handoff-store.ts#runRuntimeHandoffAction:f51197387f2cba485cfb73e192d8115c",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-handoff-store.ts#buildRuntimeHandoffPacket.attempt:157e165f1a1f4987180a86b47ef31436",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-handoff-store.ts#admitHandoffDispatch:31f8f8202cee1f5e55a592474fad3e8e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:bd9d26faa37ff11a9d7fad027d1b0890",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-instance-selection.ts#selectedRuntimeInstance:e3380d084b8c6305d128f5ae0f81aa6a",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#claudeWorkspaceWriteSandbox.autoAllowBashIfSandboxed:9f765cc5bca5eaf1b325f2d6e455f698",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#claudeWorkspaceWriteSandbox.allowUnsandboxedCommands:bfe321ced025986a518c9a2296a5df2f",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#claudeWorkspaceWriteSandbox.network.allowLocalBinding:baf41d19b0137c70358e25451d91e9c1",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#acpSteer.strategy:b4f689d42498817801d5dc27fd5c915d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#acpKind.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#acpKind.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#acpKind.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#acpKind.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:862175534cb1857de99db327dae12fb5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.steer.strategy:5dc5f329f5b0f1fdf005e4997f8915a6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7a38baeedaf6636c8a11d1cf45faccf8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:0d11545c3ec8fa08bd4a2939a09dd5d1",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:747e0a04b75266a1b570c052fee2aefb",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.configuration.fields.allowInsecureHttp:4032788d40b177f5738b8d89b0aff674",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.configuration.publicFields.allowInsecureHttp:65c075a40a0e71c435005d4b66054705",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:862175534cb1857de99db327dae12fb5:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.steer.strategy:5dc5f329f5b0f1fdf005e4997f8915a6:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:df815fa358ec57bce8609702d542f26d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:862175534cb1857de99db327dae12fb5:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:0d11545c3ec8fa08bd4a2939a09dd5d1:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:cb0664c861b27186b13d91a86cdce94f",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:13aa9f40d7a7db75c5874c507e868806",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:10",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.subscriptionProbeTimeoutMs:13aa9f40d7a7db75c5874c507e868806:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.auth.subscriptionProbeTimeoutMs:2531964ccd364cc4aaa8e9eb2c125d0b:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolAllowlist:7e17542dba8f59dc0fbd345102c8e8a3:9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.toolDenylist:2dc261f1ecd189928a64a4c5e9ce3094:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.turnLimit:402186af313fb570b090a4c6f9d7d621:9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-inventory.ts#runtimeKinds.capabilities.gracefulCancel:9745420c81851eb1d250363f7cb2b8c0:9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-orchestration.ts#runtimeBatchDefaultConcurrency:f2fe3d33df8a692124061152770749a2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-orchestration.ts#runtimeBatchMaxConcurrency:6d65b5143f15c419942132d30b4babe0",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-orchestration.ts#parseRuntimeBatchDeclaration:b06f120109c8d98943ee5b8e99057c75",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-provider-fault.ts#classifyRuntimeExit:b9ed293104e51352a942afa864d01065",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-provider-fault.ts#classifyRuntimeExit:bb31d91aa78dbe3dc51614681b57b925",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-provider-fault.ts#classifyRuntimeExit:b2a544945b431b8eab13bebe423a1cac",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-provider-fault.ts#classifyRuntimeExit:9b40db0d046a5ee24b95a4c374780102",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-publication-queue.ts#mayRescueInfrastructureLatch:9e663702627a3018d30c361402ff3d07",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-resume-admission.ts#admitRuntimeResume:1d24e78f3b5dbed0de88cf195ac44d69",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-resume-admission.ts#admitRuntimeResume:eb846c52fa03633584ef54bcc79f27c0",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-resume-admission.ts#admitRuntimeResume:a8efe8218fae3c67d01dda8c552bad4e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-settlement.ts#runtimeOutcomeRecheckMs:d44183eef12267c83fa44bf5b8922492",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-settlement.ts#runtimeSessionSettlement:e0c10bbf78a1e71624e7d0b4c7528e91",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-settlement.ts#runtimeSessionSettlement.providerFaultClass:8df2ec2659eb227669c0fbba661b19d5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-active.ts#createActiveRuntime.stallTimeoutMs:d6fc2d268343cd6b50b0eb90729c2eec",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-active.ts#isRuntimeProcessProvenStopped:1a9b1476cd2f36dab6cea89b9fc4127e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-active.ts#settleStalledRuntime:2d1d0d36a01d2eced6f15132063c7e38",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-active.ts#attachActiveRuntime.handlers.exit:55b839f8212dfbd3892f6308bc6806ca",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-active.ts#attachActiveRuntime.handlers.exit:fe4a3668aad8e018ebfe54fd4b0a87e1",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-adoption.ts#adoptRuntimes.attempts:732c866a23be48cb4aa696ecfa50fee7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-adoption.ts#adoptRuntimes.attempts.entry.promise:c3e0af7816200835b05823d9c611012c",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-adoption.ts#restoreRuntime:7d3fd3f7168077bcaf35c303654a655e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-adoption.ts#restoreRuntime:39e4830081c0babcb59e3341fa031186",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-control.ts#cancelRuntime:f12e9da0d749ff82a1adcbfb4ea3616b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-deepseek-session.ts#decompressSessionLogBounded:abfa7a199a982ed53bd13e0775cac8e8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-errors.ts#runtimeTaskLeaseRequiredMessage:25c83a9ee0a22be85f048c21b6b3e2b2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-errors.ts#runtimeTaskLeaseRequiredMessage:e5517c87db74daadbf1f42db8cebe890",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-errors.ts#runtimeTaskLeaseRequiredMessage:d1dcaf6ee3b6789b199bdf70b1f5e511",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-fallback.ts#initialFallbackAttempt.attemptIndex:0c8160023357cb0919341e53873bd02d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-fallback.ts#initialFallbackAttempt.retryRound:018baacdfcf52ef81e370bcafd8be70e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-fallback.ts#scheduleFallbackContinuation.publishTerminal:289c3d1cd6a3e751fb2b29195465510d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-fallback.ts#scheduleFallbackContinuation.timer:32207adf55dad23335e56d47f1f249a9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-fallback.ts#scheduleFallbackContinuation.timer.exhausted.payload.attempt:2f74d685e54a426d732e58591ea32ec3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-limits.ts#resumeAdmissionTimeoutMs:385dca11d55717d3b5f06196e925bd5f",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-limits.ts#exitNotificationTimeoutMs:652446a6b5934a3f87a48ffedd5cc2bb",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeCwd:576e2e52a025ebcd3651ec10774959ca",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#resolveRuntimeInstanceCandidates:3d71a58cbf72c9a7726e4a228e954372",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-mission.ts#livingDeliverableProtocol:f79b34d201459ff4adbd5bb1433cb9b7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-process.ts#readPosixProcessRows.output.timeoutMs:e7081fc1e347ae791f97369495842bd2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-process.ts#awaitRuntimeProcessExit.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-process.ts#observeDispatchProcess.released:c634ea4f4d8960a8ac39fbdbce66e15c",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-provider-stream.ts#consumeDurableOutput.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-settlement.ts#publishExit:f9594f016439097ccbfe3a344b460bae",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-settlement.ts#publishExit:7c42a91ec838576fd2546774501fafdd",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-settlement.ts#publishExit.attemptOutcome:e3b6075fefe5acc312b071337a6205d1",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-settlement.ts#publishExit.publication.forceWithLease:f291d2814f9a2a6250e059c5ede39592",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawn-settlement.ts#publishTerminalOutcome:80ea9e816f5f69e7809596f7cdce93ce",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawner.ts#makeRuntimeSpawner.modelSlotQueue.globalCapacity:364f2690112a4e8422a55a585cd8ea63",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawner.ts#makeRuntimeSpawner.modelSlotQueue.perOwnerCapacity:d226771b4061115c649e7eb837e12eec",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawner.ts#makeRuntimeSpawner.spawnClaimAttempt:a012a97a2ce4cbac0087d11ec1d1e41e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawner.ts#makeRuntimeSpawner.spawnClaimAttempt.tokenLimit:66890bd5b7122be93c828738ed022d2b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-spawner.ts#makeRuntimeSpawner.spawnClaimAttempt.openStream:9813dfc42c357216e3adb310aeb4cb6f",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-acp.ts#cancelGraceMs:ed14b5279200162d541b80589f3dcb27",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-acp.ts#runAcpProviderSession.request.timeout:41185da8dd427ca231f76df66e2ed0a7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-host.ts#runRuntimeWorkerHost.settleAttempted:80a663a97e46f17a66f3281f5fdb9a58",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-host.ts#runRuntimeWorkerHost:162e0449404b6057ea143ae97840a567",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-host.ts#runRuntimeWorkerHost:b07a2383aaf27e0d520ccb81184a85b8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-host.ts#runRuntimeWorkerHost:2205bcfa809001dba7c320a95245f519",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-host.ts#parseManifest:fc5850d062358d233af275351e75da63",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#detailLimit:aeb60c86bf8b015f3439f3b05d0565f7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#workerPushTimeoutMs:1965c93bc10640788d3863cf9e7c7a59",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#workerPushFailureCode:63d197dacd856c55aa68547b5fdaea7d",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:62bc05e193021e979c9028880b4b37a3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:62bc05e193021e979c9028880b4b37a3:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:62bc05e193021e979c9028880b4b37a3:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:2",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:3",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:5",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.invocation:269400b7646a986aa20dc7038cd35ecb",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:7",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:9",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e:10",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime-worker-push.ts#pushTaskWorkerBranch.attempted:aeabc2709a4a76af9fe7b83a2624d15e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId: "policy:packages/daemon:packages/daemon/src/runtime.ts#startDaemon:b4c5f72f3599b26554ff63c0b28de8eb",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime.ts#startDaemon.stop.deadlineExpired:5964cb041ee07b1042243b9a26c6ab5b",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/cloud-dispatch-relay.ts#UPSTREAM_TIMEOUT_MS:8d8754d918a6eb2d68ca942163928c60",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/cloud-dispatch-relay.ts#AttemptLedger:36a78395dbfefc9970547031c93c1dd6",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/cloud-dispatch-relay.ts#httpsUpstream.request:94523c0503d2101a4b6918fa08f1bbd4",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/process-group-reconciler.ts#sweepUntilProvenStopped.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/process-group-reconciler.ts#sweepUntilProvenStopped:80781c70fcc2f89fe7bdc666dfe9d534",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/runtime/windows-process-group-port.ts#establishWindowsProcessGroup.timeoutMs:08ce959d3673db2be6251563546f9a16",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/skill-eval-production.ts#defaultPolicy:71be3de7844f99fae703716f25b7ab80",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/skill-eval-runner.ts#SkillEvalRunner.run:798d3e402b66e619cb60c0a1d4b63c1e",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/terminal-environment.ts#loginShellSnapshotTimeoutMs:024ab121b6060ef024067fd0345784ac",
      route: "daemonRuntimePolicy",
    },
    {
      candidateId:
        "policy:packages/daemon:packages/daemon/src/terminal-host.ts#resolveTerminalCwd:701e772aacb1529ca0cef3a5e777bea7",
      route: "daemonRuntimePolicy",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;

// dec_7E44897ECDCAEF2B92EC66A260/CH1: host-wide action catalog vocabulary and read budgets declared by the kernel.
export const hostKernelPolicies = [
  daemonRuntimePolicy,
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
/** Existing daemon protocol/client/transport/Fleet budgets; consumers import these values without changing defaults. */
export const daemonProtocolFleetPolicy = {
  id: "daemon-protocol-fleet",
  ownerRef: "host",
  unit: "daemon protocol/client/transport/Fleet limits, retries and timeouts",
  bounds:
    "Keep the existing daemon protocol, client reconnect, transport admission, access receipt and Fleet frame/retry budgets exactly unchanged.",
  defaultValue: {
    access: { receiptListLimit: 200 },
    client: {
      reconnectBaseDelayMs: 250,
      reconnectMaxDelayMs: 5_000,
      reconnectAttemptLimit: 5,
      streamSilenceMs: 10_000,
      requestTimeoutMs: 75,
      terminalDetachTimeoutMs: 2_000,
      shutdownResponseTimeoutMs: 2_000,
      autostartReadyTimeoutMs: 10_000,
      autostartProgressMultiplier: 6,
      serviceTimeoutSignal: "SIGKILL",
    },
    transport: { connectTimeoutMs: 2_000, helloTimeoutMs: 10_000, tlsProbeTimeoutMs: 1_500 },
    fleet: {
      frameBytes: 96 * 1024,
      chunkBytes: 64 * 1024,
      transferChunkBytes: 48 * 1024,
      uploadMaxBytes: 64 * 1024 * 1024,
      helloTimeoutMs: 30_000,
      helloFailureLimit: 5,
      helloFailureWindowMs: 60_000,
      keySendWindowBytes: 256 * 1024,
      sessionSendWindowBytes: 512 * 1024,
      edgeBackoffMinMs: 250,
      edgeBackoffMaxMs: 30_000,
      replicationIdleTimeoutMs: 45_000,
      trackedSourceLimit: 4096,
      requestReceiptLimit: 1_024,
      edgeJoinQuotaFraction: 0.4,
      edgeJoinTimeoutMs: 60_000,
      edgeJoinAddressTimeoutMs: 30_000,
      edgeJoinSshStartupTimeoutMs: 45_000,
      overviewEventPageLimit: 64,
      overviewPageLimit: 16,
      failurePolicies: {
        busy: { category: "overload", recovery: "same-operation" },
        resource_exhausted: { category: "overload", recovery: "same-operation" },
        quota_exceeded: { category: "quota", recovery: "never" },
        authentication_required: { category: "authentication", recovery: "never" },
        authorization_denied: { category: "authorization", recovery: "never" },
        protocol_upgrade_required: { category: "protocol", recovery: "never" },
        invalid_frame: { category: "protocol", recovery: "never" },
        content_claim_mismatch: { category: "integrity", recovery: "never" },
        upload_replay_mismatch: { category: "integrity", recovery: "never" },
        upload_gap: { category: "offset", recovery: "resume" },
        writer_epoch_stale: { category: "fenced", recovery: "never" },
        outcome_unknown: { category: "unknown-outcome", recovery: "query-receipt" },
        cancelled: { category: "cancelled", recovery: "never" },
      },
      timeoutRetryable: true,
      invalidFrameRetryable: false,
      transferFailureRetryable: true,
      overviewLeasePageLimit: 500,
      uploadWindowLimit: 64,
      gitTimeoutMs: 10_000,
      gitFetchTimeoutMs: 30_000,
      taskWaitTimeoutMs: 60_000,
      taskContentTimeoutMs: 60_000,
      taskCommandOverheadMs: 30_000,
      receiptResponseOverheadMs: 10_000,
      localReplicaWaitBackstopMs: 1_000,
      docShowBudgetLimits: {
        global: { bulkTransfers: 8, memoryBytes: 256 * 1024 * 1024 },
        node: { bulkTransfers: 2, memoryBytes: 64 * 1024 * 1024 },
        session: { bulkTransfers: 2, memoryBytes: 64 * 1024 * 1024 },
        repository: { bulkTransfers: 4, memoryBytes: 128 * 1024 * 1024 },
      },
    },
    protocol: {
      validationValueLimit: 120,
      validationStringLimit: 100,
      validationArrayLimit: 20,
      validationDepthLimit: 3,
      listLimitMaximum: 500,
      runtimeListLimitMaximum: 1_000,
      listLimitPattern: "^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$",
      fleetActionPageRows: 128,
      scheduleMinimumEveryMs: 60_000,
    },
    hosting: { gitTimeoutMs: 10_000 },
  },
  version: 1,
  scope: "daemon protocol, client, transport, access and Fleet boundary",
  reason: "Centralize existing daemon budgets in the shared host policy while preserving every consumer default.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.access.receiptListLimit:f4f679a7fa7fdba259355f08a06333f9",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.reconnectAttemptLimit:46f5c519a70a3525a0f9b11eab38771b",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.requestTimeoutMs:b08ff715218e18da14566d4f850812e1",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.terminalDetachTimeoutMs:730605dd3ffb2c737f204c0fd10571c8",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.shutdownResponseTimeoutMs:3bd7fb94f11d71ba0fb38944fa13c62d",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.autostartReadyTimeoutMs:723251af20814a0a27bd2fc776c6cdb6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.client.serviceTimeoutSignal:8e211405b0b789ad8c6dd8e5b255ca20",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.transport.connectTimeoutMs:f3033bf8d12b90404f3184b1ccc7fb63",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.transport.helloTimeoutMs:24754a8eba13b49ca4b5af7da7febb18",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.transport.tlsProbeTimeoutMs:2b00678f5bea994cff9064b79d24a784",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.helloTimeoutMs:bf8d07f0692db6fdbed8fe1bf0461bd0",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.helloFailureLimit:d5eeff808f6c9d5163e9cb0a56118bb2",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeBackoffMinMs:3acfa1fd913ad46ee84c4d85a83bd8c4",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeBackoffMaxMs:b5b175298c7d8694710efd195605327e",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.replicationIdleTimeoutMs:ecc86c68b7f0cb95ac3fce647788e3ec",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.trackedSourceLimit:09f4c19c554e5cb82546483b4001061b",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.requestReceiptLimit:061587e61f01beaff986c5bec9d0c641",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinQuotaFraction:be8963153e7735b1244f47596675cbe7",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinTimeoutMs:773d8b6326c659aa39c7d62f7d549de8",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinAddressTimeoutMs:d686d1031390c0ae69a312bf2a286919",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.edgeJoinSshStartupTimeoutMs:9ee019dd9eaba064c7e480f44089a778",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.overviewEventPageLimit:ba6b3259e42468f5fd3ba3bb79aeada5",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.overviewPageLimit:1c981a4bde74b26a47533a8d5d646ba6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.failurePolicies.quota_exceeded:65e0e64c9d972311d77e93b0fd82ae46",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.failurePolicies.content_claim_mismatch:99b079cb25cc857c92c6b9a3f00859ff",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.timeoutRetryable:d6fbc3a9e1f243d1e2c9c33200af3a47",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.invalidFrameRetryable:cc398d470c9f9e487aaeb3a64afc1f3c",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.transferFailureRetryable:963f266a39262da067de77c45dec7d55",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.overviewLeasePageLimit:099068e8787cb06e7ca2514ac4072926",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.uploadWindowLimit:585169dea4e98ddd5d2f2ee49d1e4260",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.gitTimeoutMs:07b758deac62385ea988fe471aa2f399",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.gitFetchTimeoutMs:8979cf749d51122e293d09030f287c1a",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.taskWaitTimeoutMs:1c160852548d4dc6b7acf3a528d3a561",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.taskContentTimeoutMs:33ab8bb94761a54a57544b3d8ced30ef",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.fleet.docShowBudgetLimits:5a82c2ef623788998aaa6060ca20d3bf",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.validationValueLimit:57b3c91038c3ab87fa1f2cdf55f8c4e5",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.validationStringLimit:07f41bc7323820043bb906142b0d39d6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.validationArrayLimit:5ccad3f968ade7af591fd63440ab176b",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.validationDepthLimit:961d9a5350db7a29d2174958db02a9a6",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.listLimitMaximum:116265978a22050677d15b6f4275322a",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.runtimeListLimitMaximum:e4076a34207d14c0a71ac2bb821e8484",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.protocol.listLimitPattern:50c896d58b8715286ac18c73ca44db41",
    "policy:packages/kernel:packages/kernel/src/domain/cli-operational-policy.ts#daemonProtocolFleetPolicy.defaultValue.hosting.gitTimeoutMs:07b758deac62385ea988fe471aa2f399",
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.progressDeadline:0580ea11b6e1873d7fb1425588432769",
    "policy:packages/daemon:packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig:71e97e6c158cd623dfe2d07654cc3d18",
    "policy:packages/daemon:packages/daemon/src/client/fleet-edge-config.ts#readFleetEdgeConfig:fbabdfeeabe85e6e0f0aaa95e5ba5c27",
    "policy:packages/daemon:packages/daemon/src/fleet-center-admission.ts#prepareFleetCenterAdmission:9655ee83a3bfb823317404523b9e3185",
    "policy:packages/daemon:packages/daemon/src/fleet-center-admission.ts#syncFleetEdgeMirror:1f8bd7df94f8b6ded8aae2a29bf74b2a",
    "policy:packages/daemon:packages/daemon/src/fleet-center-config.ts#readFleetCenterConfig:b55f993806ec30b68c7727e7b880f2ee",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:89b25555fb25353fed758c96a141a15a",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:2aa23988b576f7993582719ff14f10d7",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime-read.ts#readEdgeRuntimeRepository.selector:6de6f18030ea9fe60f616bea9d75500c",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext.executionId:61b2eb926a33088d5da971f5f20374c6",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:694f90d7281ffb91476471d3952b9935",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:4368c535502fcff7e6c130fe664e669d",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.remote.taskContext:61b2eb926a33088d5da971f5f20374c6",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.spawner.onRuntimeOutcome:18552b0195152b438b36a4942500d6cb",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#openFleetEdgeRuntime.runSchedule:943f3321456b1149301dffc546c83476",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-runtime.ts#taskRuntimeContext:7dfefa24e53538d618ff71ca8895074b",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.waitMs:cca4116819918e2b4a896234c06ef4f0",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask:fa3da66cf6e2bbcc0dc7616243c35e5c",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#runFleetEdgeTask.authorize:14085f29822d258e9ba1df56ece5c97d",
    "policy:packages/daemon:packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue:6ee5ea5aa3ebb16d6998452dcd08ff1a",
    "policy:packages/daemon:packages/daemon/src/fleet/basebackup-queue.ts#createBaseBackupQueue.acquire:d2185cb6a2a6cfdc063704076b76171d",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.admitReplica:89abda51ae346ee745663c7b0c55471b",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:f432688bfdf28796038fda7a3faf5afa",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:1bfcfc598ecd35e03e60db29c5b67620",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:2ab74bd0e156d6731a10b18d0806768b",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:1b338d396a4c7609d3a6cfb4a96bea12",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.handle:911d8a441b8dec3dfbae3b49585c0357",
    "policy:packages/daemon:packages/daemon/src/fleet/command-transfer.ts#FleetTransferAssembler.push.retryable:e2ef0795ddce440400fe319ee22fab94",
    "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#joinFleetEdge:a0303276c88d116a4206d1f6a1799c55",
    "policy:packages/daemon:packages/daemon/src/fleet/edge-join-client.ts#deriveEdgeJoinQuotaBytes:6dc54d57fc380020dbfe8878bb85b2a3",
    "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#leaseRows.runtimeSessionId:b50e578b4c4037af9205216797c42a25",
    "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#validateNodeRow:a1113d2bf0742179c00b5a062ab5cb00",
    "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.page.leaseOnly:7d0d008d737a90dacc53b3213c67778a",
    "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId:0cc48a35900f8a2d906a6e56c185315b",
    "policy:packages/daemon:packages/daemon/src/fleet/fleet-overview-read.ts#readFleetOverviewFromHost.leaseFacts.nodeId:56e970c86bbf4db803eaeceea83d747c",
    "policy:packages/daemon:packages/daemon/src/fleet/node-retirement.ts#createNodeRetirement.inspect:336cc07944400915dc63d9b9c760cb7a",
    "policy:packages/daemon:packages/daemon/src/fleet/transport-contract.ts#contentTransportContract.quotaOwner:ae6e90c390260356498a1fcd986bd840",
    "policy:packages/daemon:packages/daemon/src/host-action-authorization.ts#evaluateFleetAction.policyRef:4f0492d69afdb92f14dac4ff97639d19",
    "policy:packages/daemon:packages/daemon/src/protocol/agent-entity-gui-contract.ts#squadDetailChecks:2992fb30fa14879ed9b3a56065fb291e",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.riskTier:9311e769015637044dbb5cfed85bf3bc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.claims:144c85f3905ab00818e41bf657851398",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-actions.ts#daemonGuiActionMethods.timeoutMs:d02b1e232b41987e44ddd45121bbdb3a",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validateReckoningRead:f33a5cdd4f195ff160f9ba63da6b2cb8",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-repository-reads.ts#validatePolicyMetadataRead:e892d9c9b9f1cfa95daa0960e1bbd3ab",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateRuntimeSessionGroupsPayload:4bb266a93477b6465cf1e2d51ee33c02",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateSquadRunListPayload:e9645cb502bd19513e5fa1a73bda4fcb",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateAgendaQueryPayload:550cdd0cd7d274cdc7e17e4406201ac1",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateTaskDispatchesPayload:346b1c8c807fbdd9e9cae4888600a00c",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload:7dcdeb72672d071722e8d0a55622e840",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-rpc-validation.ts#validateGuiActionPayload:47f9cc8191031de3fb5a53f1f9c92c09",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-task-completion.ts#validateDaemonTaskCompletion:53bfe398c2e676421c927aa703882ba2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-validate-entities.ts#validateTaskClaimableResult:48e00cf5d8e0133ec4ff5b25db2e7302",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-validate-results.ts#writeReceipt:c829de6b1cc9cc83ba7fc87034003f7b",
    "policy:packages/daemon:packages/daemon/src/protocol/gui-result-validation.ts#validateTaskRuntimeContextRead:2e43f537ef1583d90d9cb5e7a2db6462",
    "policy:packages/daemon:packages/daemon/src/protocol/gui-result-validation.ts#validateDaemonTaskWip:e61e19aa284460df35e9b0bebc08d1d4",
    "policy:packages/daemon:packages/daemon/src/protocol/schedules-gui-contract.ts#validateSchedulesList:7062238218b82b4dcbe411b9e762f76e",
  ].map((candidateId) => ({ candidateId, route: "daemonProtocolFleetPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** Exact protocol shape / field type contracts; execution budgets are declared separately. */
export const daemonProtocolShapeContractPolicy = {
  id: "daemon-protocol-shape-contract",
  ownerRef: "host",
  unit: "protocol shape / field type",
  bounds:
    "Register only exact daemon source identities in this semantic class; this contract defines no operational default.",
  defaultValue: null,
  version: 1,
  scope: "daemon protocol shape / field type",
  reason:
    "Wire schema ownership stays with its named daemon protocol declaration; operational limits are referenced from daemonProtocolFleetPolicy.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.errors.nodeAutoClaim:70cfc10d6603af9cf12e5446b9195ade",
    "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.maxConcurrent:8ac1df28cecd20076ac1df48da992d67",
    "policy:packages/daemon:packages/daemon/src/gui-s3-control.ts#validateSystemStatus.allowedAgentIds:5710c973998faafa0fc53d3a1e33b1a9",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonRepositoryReadMethods.params.payload.generatedAt:bab3b56fbceedb0102dd1b7203f77e7a",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.policy:5774ea82d1f8ba5e47cd3d1f88548297",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.threshold:7feb991d966e75d119019ed879c47bec",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#daemonProtocolMethods.params.quotaBytes:842ebae6741341893bdba402c5e5bb52",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes:6ee226975efe9d400b66020a67b74729",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.quotaBytes:6ee226975efe9d400b66020a67b74729:2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#fleetProtocolMethods.params.payload.timeoutMs:a01eacadb58ddacea39848a1288008cf",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:3",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:4",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-gui-reads.ts#daemonGuiReadMethods.params.payload.limit:01756949446e0e6666f8f2734b5d34fc:5",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonUseCaseProjectionPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonTaskQueryPayloadShape.leaseOnly:5973c87cd792d7f35cddf633aef8b8a4",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonRelationQueryPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonArtifactsListPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-schema-ids.ts#daemonAgendaPayloadShape.limit:01756949446e0e6666f8f2734b5d34fc",
  ].map((candidateId) => ({ candidateId, route: "daemonProtocolShapeContractPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** Exact CLI command presentation metadata contracts; execution budgets are declared separately. */
export const daemonCliPresentationContractPolicy = {
  id: "daemon-cli-presentation-contract",
  ownerRef: "host",
  unit: "CLI command presentation metadata",
  bounds:
    "Register only exact daemon source identities in this semantic class; this contract defines no operational default.",
  defaultValue: null,
  version: 1,
  scope: "daemon CLI command presentation metadata",
  reason: "Presentation tiers classify command help metadata and do not define execution or authorization policy.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:3",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:4",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:5",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:3",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:6",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:7",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:8",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b:4",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:9",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task-surface.ts#taskSurfaceProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:10",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:2",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:ef0d19ce89e0c8520ee6e11d64157b31:3",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.helpTier:0ad5118f75336ee917582e43ce77c33b",
  ].map((candidateId) => ({ candidateId, route: "daemonCliPresentationContractPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** Exact client observations / local idempotent release flags contracts; execution budgets are declared separately. */
export const daemonLifecycleObservationContractPolicy = {
  id: "daemon-lifecycle-observation-contract",
  ownerRef: "host",
  unit: "client observations / local idempotent release flags",
  bounds:
    "Register only exact daemon source identities in this semantic class; this contract defines no operational default.",
  defaultValue: null,
  version: 1,
  scope: "daemon client observations / local idempotent release flags",
  reason:
    "Attempt results and release flags describe execution state; retry and timeout budgets are owned by daemonProtocolFleetPolicy.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747",
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:2",
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:3",
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:4",
    "policy:packages/daemon:packages/daemon/src/client/daemon-autostart.ts#ensureLocalDaemonRunning.attempts:5007c49b2464bfbfbcf01e27f6555747:5",
    "policy:packages/daemon:packages/daemon/src/fleet-edge-write.ts#runFleetEdgeRetry.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "policy:packages/daemon:packages/daemon/src/fleet/center-delivery-drain.ts#createFleetDeliveryDrain.admit.released:c634ea4f4d8960a8ac39fbdbce66e15c",
    "policy:packages/daemon:packages/daemon/src/fleet/center-lease-claims.ts#reclaimConsumedClaims.released:c634ea4f4d8960a8ac39fbdbce66e15c",
    "policy:packages/daemon:packages/daemon/src/fleet/center-lease-claims.ts#discardOwnedClaims.released:c634ea4f4d8960a8ac39fbdbce66e15c",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released:c634ea4f4d8960a8ac39fbdbce66e15c",
    "policy:packages/daemon:packages/daemon/src/fleet/center-listener.ts#listenFleetTls.onReplicationStart.source.backup.released:c634ea4f4d8960a8ac39fbdbce66e15c:2",
    "policy:packages/daemon:packages/daemon/src/fleet/replica-generation.ts#createGenerationReaders.acquire.released:c634ea4f4d8960a8ac39fbdbce66e15c",
    "policy:packages/daemon:packages/daemon/src/fleet/resource-budget.ts#createResourceBudget.reserve.released:c634ea4f4d8960a8ac39fbdbce66e15c",
  ].map((candidateId) => ({ candidateId, route: "daemonLifecycleObservationContractPolicy" })),
} as const satisfies OntologyPolicyDeclaration;

/** Exact action routing / authorization receipt shape contracts; execution budgets are declared separately. */
export const daemonAuthorizationReceiptContractPolicy = {
  id: "daemon-authorization-receipt-contract",
  ownerRef: "host",
  unit: "action routing / authorization receipt shape",
  bounds:
    "Register only exact daemon source identities in this semantic class; this contract defines no operational default.",
  defaultValue: null,
  version: 1,
  scope: "daemon action routing / authorization receipt shape",
  reason:
    "These are exact receipt and routing shapes; authority remains the named ActionDeclaration or AuthorizationPort.",
  fixtures: ["tools/gates/test/ontology-closure.test.mjs"],
  sources: [
    "policy:packages/daemon:packages/daemon/src/fleet-edge-task.ts#verifyFleetTaskSubmitHolder:14085f29822d258e9ba1df56ece5c97d",
    "policy:packages/daemon:packages/daemon/src/fleet-task-delivery.ts#assertFleetDeliveryHolder:d24c9064b6f713519f68d752098c35e3",
    "policy:packages/daemon:packages/daemon/src/fleet/forwarding-intent.ts#forwardingIntentIssue:16800eef7e7892d4fe4742af8daee7b5",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-decision-lifecycle.ts#defineCenterForwardArbiterCommand.admission:9f01bc772226841415b8fc2e6c07478e",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-people.ts#peopleWriteTopology.admission:9f01bc772226841415b8fc2e6c07478e",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand.admission:9f01bc772226841415b8fc2e6c07478e",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskActionProtocolCommand:c79f19d96686565b7a11211d4b7c6cbf",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands-task.ts#taskExecutionProtocolCommands.admission:d43014f50cf523fc92be2084ed1f127c",
    "policy:packages/daemon:packages/daemon/src/protocol/daemon-protocol-commands.ts#settingsWriteTopology.admission:9f01bc772226841415b8fc2e6c07478e",
    "policy:packages/daemon:packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting:e9223ea1f35451c5a3e5a78e4b9e9b66",
    "policy:packages/daemon:packages/daemon/src/rpc-command-routing.ts#assertDaemonRpcRouting:44c9510588b412fe3102d073ff7c4f32",
  ].map((candidateId) => ({ candidateId, route: "daemonAuthorizationReceiptContractPolicy" })),
} as const satisfies OntologyPolicyDeclaration;
