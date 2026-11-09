// Initial inventory for the first ForwardingPort slice: 37 files / 81 file-symbol-fingerprint entries.
// Counts are exact: an increase is rejected and a decrease must lower this baseline in the same change.
// Every unregistered production source or symbol has zero allowance.
// Slice 4 removes this baseline when forwarding is fully port-owned.
export const fleetForwardingBoundaryBaseline = Object.freeze({
  "packages/cli/src/daemon/control.ts": {
    flag: {
      readFleetEdgeConfig: 2,
    },
  },
  "packages/daemon/src/access-admin-edge-join.ts": {
    status: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/client/fleet-edge-config.ts": {
    fleetEdgeConfigPath: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/daemon-host-binding.ts": {
    withSessionEnvironment: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/daemon-host-open.ts": {
    keycloakSession: {
      edgeRuntimeFor: 4,
      readFleetEdgeConfig: 5,
      forwardingCredentialAssembly: 2,
    },
    home: {
      edgeRuntimeFor: 1,
      readFleetEdgeConfig: 4,
      forwardingCredentialAssembly: 3,
    },
    writeNodeReviewDispatchFailure: {
      edgeRuntimeFor: 1,
    },
    migrateEdgeWorkspace: {
      edgeRuntimeFor: 1,
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/daemon-host-repository-api.ts": {
    createDaemonHostRepositoryApi: {
      readFleetEdgeConfig: 1,
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/daemon-host-runtime-api.ts": {
    authorizeCenterConfiguration: {
      edgeRuntimeFor: 2,
      readFleetEdgeConfig: 2,
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/fleet/replica-token.ts": {
    createFleetReplicaAccessTokenReader: {
      forwardingCredentialAssembly: 2,
    },
  },
  "packages/daemon/src/fleet-edge-workspace-migration.ts": {
    migrateFleetEdgeWorkspace: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/edge-replica-doctor.ts": {
    edgeReplicaDoctor: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/fact-archive-document.ts": {
    factArchiveIds: {
      fromFileSpecialCase: 1,
    },
  },
  "packages/daemon/src/fleet/center-listener.ts": {
    handle: {
      fleetRequestEnvelope: 1,
      forwardingCredentialAssembly: 2,
    },
    ownedEpochFor: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/fleet/center-transport.ts": {
    dispatch: {
      forwardingCredentialAssembly: 2,
    },
  },
  "packages/daemon/src/fleet/edge-join-client.ts": {
    joinFleetEdge: {
      readFleetEdgeConfig: 2,
      forwardingCredentialAssembly: 4,
    },
  },
  "packages/daemon/src/fleet/peer.ts": {
    runFleetWriteClient: {
      fleetRequestEnvelope: 1,
    },
    runFleetRuntimeEventClient: {
      fleetRequestEnvelope: 1,
    },
    runFleetRuntimeArchiveClient: {
      fleetRequestEnvelope: 1,
    },
    runFleetTaskCommandClient: {
      fleetRequestEnvelope: 2,
      forwardingCredentialAssembly: 1,
    },
    runFleetScheduleCommandClient: {
      fleetRequestEnvelope: 2,
    },
    onClose: {
      forwardingCredentialAssembly: 1,
    },
    messageId: {
      forwardingCredentialAssembly: 1,
    },
    requestFleetEdgeJoinStatusPinned: {
      forwardingCredentialAssembly: 1,
    },
    requestFleetEdgeJoinPinned: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/fleet-center-admission.ts": {
    persistEdgeConnection: {
      readFleetEdgeConfig: 1,
      forwardingCredentialAssembly: 1,
    },
    edgeJoinFor: {
      forwardingCredentialAssembly: 1,
    },
    syncFleetEdgeMirror: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/fleet-edge-runtime.ts": {
    openFleetEdgeRuntime: {
      readFleetEdgeConfig: 1,
    },
    recoverEdgeReviewerReview: {
      forwardingCredentialAssembly: 2,
    },
  },
  "packages/daemon/src/fleet-edge-task.ts": {
    runFleetEdgeRepositoryRead: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/oidc-center-selection.ts": {
    oidcCenterSelections: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/protocol/daemon-protocol.contract.ts": {
    "<module>": {
      fleetRequestEnvelope: 2,
    },
  },
  "packages/daemon/src/protocol/json-rpc-server.ts": {
    createJsonRpcProtocolServer: {
      fleetMethodByDiscriminant: 2,
    },
    sessionIndependentFleetRuntimeRead: {
      fleetMethodByDiscriminant: 1,
    },
  },
  "packages/daemon/src/repo-bootstrap.ts": {
    resolveRepoBootstrap: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/repo-cell-action-parse.ts": {
    taskCreateAction: {
      fromFileSpecialCase: 2,
    },
    decisionProposalAction: {
      bodyFileSpecialCase: 3,
    },
    resolvePacketAction: {
      fileInputConditional: 1,
    },
  },
  "packages/daemon/src/repo-cell-bootstrap-ledger.ts": {
    initializeBootstrapLedger: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/repo-cell-packets.ts": {
    readPacketSource: {
      fromFileSpecialCase: 1,
      fileInputConditional: 1,
    },
    submissionPacket: {
      fromFileSpecialCase: 1,
    },
  },
  "packages/daemon/src/repo-cell-proxy.ts": {
    edgeConfig: {
      readFleetEdgeConfig: 1,
    },
    latched: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/repo-cell-submit.ts": {
    submitTask: {
      fromFileSpecialCase: 1,
    },
  },
  "packages/daemon/src/repo-cell-task-command-docs.ts": {
    runTaskCommandWithDocs: {
      fromFileSpecialCase: 1,
    },
  },
  "packages/daemon/src/repo-read-pool.ts": {
    openRepoReadClient: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/repo-writer-worker.ts": {
    startRepoWriterWorker: {
      forwardingCredentialAssembly: 1,
    },
    reviveBinding: {
      forwardingCredentialAssembly: 1,
    },
  },
  "packages/daemon/src/reviewer-artifact-publication.ts": {
    reviewerArtifactsForReview: {
      fileInputConditional: 1,
    },
  },
  "packages/daemon/src/runtime-execution-scope.ts": {
    requireCurrentExecutionScope: {
      fileInputConditional: 1,
    },
  },
  "packages/daemon/src/schedules-gui-read.ts": {
    viewerNodeIdOf: {
      readFleetEdgeConfig: 1,
    },
  },
  "packages/daemon/src/task-claimable-read.ts": {
    readClaimableTasks: {
      forwardingCredentialAssembly: 2,
    },
  },
  "packages/daemon/src/writer-supervisor.ts": {
    bootstrapMessage: {
      forwardingCredentialAssembly: 1,
    },
  },
});
