import { INBOX_PAGE_LIMIT } from "./inbox.ts";
import type { OntologyJudgmentDeclaration, OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Inbox aggregate declarations (dec_7CE3162BF9BFB157DAB9F9B6C0 CH1, R4). */
const inboxFixtures = [
  "packages/kernel/test/inbox.test.ts",
  "packages/storage/test/store/inbox-projection.test.ts",
  "packages/storage/test/pglite/pglite-inbox.integration.test.ts",
  "packages/storage/test/postgres/pg-inbox.integration.test.ts",
];
const inboxSource = (symbol: string) => `policy:packages/kernel:packages/kernel/src/domain/inbox.ts#${symbol}`;

export const inboxPolicies = [
  {
    id: "inbox-queue-page",
    ownerRef: "runtime-session/inbox_item_enqueued",
    unit: "inbox items per read",
    bounds:
      "Consumer-partition reads require consumerKind unattended_dispatch, interactive_watch, or quarantined_external, return at most 200 items in enqueue-revision order, and keep each consumer isolated; identities are at most 256 characters, dedupe keys 512 and summaries 1024.",
    defaultValue: INBOX_PAGE_LIMIT,
    version: 2,
    scope: "Inbox events and Inbox projection reads",
    reason:
      "Bound every Inbox read and payload so one fold and one page never grow with inbox history, and keep background dispatch from claiming interactive watch messages.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("INBOX_PAGE_LIMIT:7fbdd7a0b52227f85420ba40b43bb354"),
      inboxSource("INBOX_TEXT_LIMIT:eb151f03d98158007b488536b00f7417"),
      inboxSource("INBOX_SUMMARY_LIMIT:e6e6093fc4dce229ecd75abcef9891e3"),
      inboxSource("enqueuedIssues:b52c34440b99f9ecbadad1ba19b4a5a1"),
      inboxSource("reduceInboxItem.item.consumerKind:19b8d7be33270534fffa4e6841d73c43"),
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
  {
    id: "inbox-claim-lease",
    ownerRef: "runtime-session/inbox_item_claimed",
    unit: "claim lease",
    bounds:
      "An unexpired claim blocks another claim and automatic consumption; an expired claim may be re-claimed (claimCount starts at 0 and counts every claim). Settlement requires the live claim id.",
    defaultValue: null,
    version: 1,
    scope: "Inbox item reducer and consumption verdict",
    reason: "One consumer holds a wakeup at a time; a crashed consumer's lease expires instead of blocking forever.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("reduceInboxItem:77e178908aaf962825288d58ba8df969"),
      inboxSource("reduceInboxItem.item.claimCount:416281315eda57adb7f05a07e5976b64"),
      inboxSource("evaluateInboxConsumption:d7103da7b4f4aa77083daa89e73ec24c"),
      "policy:packages/kernel:packages/kernel/src/domain/status-word-register-inbox.ts#meanings.claimed:c14d85c9256f3d7f11fd3e8f74a785c5",
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
  {
    id: "inbox-external-quarantine",
    ownerRef: "runtime-session/inbox_item_enqueued",
    unit: "inbox admission",
    bounds:
      "external_ingress is admitted only as quarantined_external and only into the quarantined_external consumerKind; peer_request and peer_reply require interactive_watch.",
    defaultValue: "quarantined_external",
    version: 2,
    scope: "Inbox events until verified host isolation exists (R4)",
    reason: "External input is recorded but never executed before host isolation exists.",
    fixtures: inboxFixtures,
    sources: [
      inboxSource("reduceInboxItem.item.status:d91a350dc6eb2c6f420694fcd95c75f1"),
      inboxSource("enqueuedIssues:1fea5df76694395d7b799c3b236d1508"),
      inboxSource("enqueuedIssues.consumerKind:610cfd0bf7fd352a34dc7f040d91a4c1"),
    ].map((candidateId) => ({ candidateId, route: "readInbox" })),
  },
] as const satisfies readonly OntologyPolicyDeclaration[];

export const inboxJudgments = [
  {
    id: "inbox-event-payload",
    symbol: "packages/kernel/src/domain/inbox.ts#validateInboxEventPayload",
    inputs: ["InboxEventType", "unknown payload"],
    output: "readonly string[] issues",
    failureCodes: [],
    explain:
      "Field-value contract of the Inbox event payloads, including peer traffic and optional causal-routing metadata, called once from the agent runtime event validator.",
    consumers: ["packages/kernel/src/domain/agent-runtime.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/inbox.ts#validateInboxEventPayload:6784994f2fb7b2a63475471070ae296e",
        route: "validateInboxEventPayload",
      },
    ],
  },
  {
    id: "session-continuation-fence",
    symbol: "packages/kernel/src/domain/runtime-session-continuation.ts#assertSessionContinuationFence",
    inputs: ["SessionContinuationFenceInput"],
    output: "SessionContinuationFenceVerdict",
    failureCodes: ["unattended_prior_stop_unproven", "unattended_handoff_packet_missing"],
    explain:
      "Govern only unattended wakeups: refuse without stop proof or handoff, cold-start instead of resuming an unclean session; operator recovery and provider-fallback are not governed.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/runtime-session-continuation.ts#assertSessionContinuationFence:11a4e74bbffe81664d8e0e4e41629894",
        route: "assertSessionContinuationFence",
      },
    ],
  },
  {
    id: "unattended-launch-admission",
    symbol: "packages/kernel/src/domain/unattended-launch-admission.ts#assertUnattendedLaunchAdmission",
    inputs: ["UnattendedLaunchAdmissionInput"],
    output: "UnattendedLaunchAdmission",
    failureCodes: [
      "unattended_permission_bypass_forbidden",
      "unattended_permission_exceeds_ceiling",
      "unattended_permission_unsupported",
    ],
    explain:
      "Refuse bypass, cap code work at workspace-write and supervision or peer-read-only work at read-only, fail closed on unsupported modes, and strip plaintext GitHub tokens.",
    consumers: [],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/unattended-launch-admission.ts#assertUnattendedLaunchAdmission:8e948bc6bfb0303cfd796198f8fdbdb1",
        route: "assertUnattendedLaunchAdmission",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
