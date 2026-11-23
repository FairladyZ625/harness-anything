import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";

/** PeerRequestV1 ontology declarations (dec_2B573FD17D82C9ADDE2FC69C5D CH2/CH3/CH4). */
export const peerJudgments = [
  {
    id: "authenticated-sender",
    symbol: "packages/kernel/src/domain/peer-collaboration.ts#verifyPeerSenderIdentity",
    inputs: ["claimed person id", "authenticated person id"],
    output: "Peer sender identity result",
    failureCodes: ["peer_sender_spoofing_denied"],
    explain: "Bind the claimed sender to the principal authenticated by the center.",
    consumers: ["packages/kernel/src/domain/peer-collaboration.ts", "packages/daemon/src/daemon-host/peer-action.ts"],
    sources: [],
  },
  {
    id: "peer-request-event-validation",
    symbol: "packages/kernel/src/domain/peer-collaboration.ts#validatePeerRequestEvent",
    inputs: ["unknown canonical peer request event"],
    output: "readonly string[] validation issues",
    failureCodes: ["peer_request_invalid_input"],
    explain: "Validate canonical peer-request-event/v1 envelopes and payloads before admission.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#validatePeerRequestEvent:57ccd6886015e975aaa0ce75d002f61d",
        route: "validatePeerRequestEvent",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];

export const peerPolicies = [
  {
    id: "execution-ceiling",
    ownerRef: "peer-request",
    unit: "Tier A operation",
    bounds:
      "L0 is read-only. L1 requires local preflight and local human confirmation. L2 and unknown operations are draft-only.",
    defaultValue: "draft_only",
    version: 1,
    scope: "Receiver-side evaluation of untrusted peer intent",
    reason: "A remote request cannot delegate the receiving principal's authority.",
    fixtures: ["packages/kernel/test/peer-collaboration.test.ts", "packages/daemon/test/peer-collaboration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#evaluatePeerExecutionCeiling.tier:1aa4cf7aa9729a9ae689d62ff902fa74",
        route: "evaluatePeerExecutionCeiling",
      },
    ],
  },
  {
    id: "claim-fence",
    ownerRef: "peer-request",
    unit: "request claim",
    bounds:
      "A terminal event requires a live claim owned by the recipient and must present its fence. Reclaim is available at expiry.",
    defaultValue: null,
    version: 1,
    scope: "PeerRequest lifecycle",
    reason: "A window that loses its claim cannot settle the request after takeover.",
    fixtures: ["packages/kernel/test/peer-collaboration.test.ts", "packages/daemon/test/peer-collaboration.test.ts"],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#peerRequestV1JsonSchema.claim:02c52e58cabf7ab5083a713eb26afc70",
        route: "PeerRequestV1 claim schema",
      },
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#reducePeerRequestEvent:49adb3c8f0bf4390ec0d6b480bbf3670",
        route: "reducePeerRequestEvent",
      },
    ],
  },
  {
    id: "peer-collaboration-bridge",
    ownerRef: "peer-request",
    unit: "items / ms",
    bounds:
      "Peer reads cap at 200 items per page, peer inbox wakes use dispatchable/interactive_watch admission, and handoff git bundle subprocesses enforce bounded 5s/15s timeouts.",
    defaultValue: 200,
    version: 1,
    scope: "PeerRequest projection reads, daemon ha peer actions, and handoff bundle packaging",
    reason:
      "Keep every peer bridge read bounded, isolated to interactive_watch, and protected against hung git subprocesses.",
    fixtures: [
      "packages/storage/test/store/peer-request-projection.test.ts",
      "packages/daemon/test/peer-collaboration.test.ts",
    ],
    sources: [
      {
        candidateId:
          "policy:packages/kernel:packages/kernel/src/domain/peer-collaboration.ts#PEER_REQUEST_PAGE_LIMIT:e654af11f2334d49dbdfaa7d6d5ebe49",
        route: "readPeerRequests",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#evaluatePeerWatchOnce.read.limit:bf38217595aafee0d2b364031d7e7000",
        route: "peer-watch",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.reqRead:78f06c4227ba785282a4e80f837cbc12",
        route: "peer-inbox",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.inboxRead:78f06c4227ba785282a4e80f837cbc12",
        route: "peer-inbox",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.inboxBundle.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "peer-ask",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-action.ts#runPeerAction.payload.admission:0434b29be0266d9440715451ee9874bd",
        route: "peer-reply",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-handoff-bundle.ts#prepareHandoffBundle.rev.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
        route: "peer-handoff",
      },
      {
        candidateId:
          "policy:packages/daemon:packages/daemon/src/daemon-host/peer-handoff-bundle.ts#prepareHandoffBundle.created.timeoutMs:08ce959d3673db2be6251563546f9a16",
        route: "peer-handoff",
      },
    ],
  },
] as const satisfies readonly OntologyPolicyDeclaration[];
