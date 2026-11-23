import type { EntityActionContract, EntityActionInputField } from "./entity-kind-registry.ts";

const text = (field: string, required: boolean, flag?: string): EntityActionInputField => ({
  field,
  type: "string",
  required,
  ...(flag ? { cli: { name: flag, kind: "single", error: { code: "invalid_field" } } } : {}),
});
const flagBool = (field: string, flag: string): EntityActionInputField => ({
  field,
  type: "boolean",
  required: false,
  cli: { name: flag, kind: "boolean", error: { code: "invalid_field" } },
});
const flagNum = (field: string, flag: string): EntityActionInputField => ({
  field,
  type: "number",
  required: false,
  cli: { name: flag, kind: "single", error: { code: "invalid_field" }, projection: "number" },
});
const key = text("idempotencyKey", false, "--idempotency-key");
const requestIdField = text("requestId", true);

export const peerActionDefinitions = [
  {
    id: "ask",
    read: false,
    summary: "Send a structured PeerRequest to another principal with atomic Inbox wakeup.",
    fields: [
      text("toPersonId", true, "--to"),
      text("summary", true, "--summary"),
      text("claim", true, "--claim"),
      text("requestedAction", true, "--action"),
      text("requestKind", false, "--kind"),
      text("workId", false, "--work"),
      text("lane", false, "--lane"),
      text("anchorRef", false, "--anchor-ref"),
      text("rootCause", false, "--root-cause"),
      text("verification", false, "--verification"),
      text("fromPersonId", false, "--from-person-id"),
      text("nodeId", false, "--node-id"),
      text("sessionHint", false, "--session-hint"),
      key,
    ],
  },
  {
    id: "reply",
    read: false,
    summary: "Reply to, complete, or reject a PeerRequest under Tier-A authorization ceilings.",
    fields: [
      requestIdField,
      text("claim", false, "--claim"),
      text("requestedAction", false, "--action"),
      text("outcome", false, "--outcome"),
      text("reason", false, "--reason"),
      text("operation", false, "--operation"),
      flagBool("preflightPassed", "--preflight-passed"),
      flagBool("humanConfirmed", "--human-confirmed"),
      flagBool("draftOnly", "--draft-only"),
      text("rootCause", false, "--root-cause"),
      text("verification", false, "--verification"),
      key,
    ],
  },
  {
    id: "watch",
    read: true,
    summary: "Wait for causally ready interactive_watch PeerRequest or reply frames for this principal.",
    fields: [
      flagBool("once", "--once"),
      text("workId", false, "--work"),
      text("replyTo", false, "--reply-to"),
      text("lane", false, "--lane"),
      flagNum("timeoutMs", "--timeout-ms"),
    ],
  },
  {
    id: "inbox",
    read: true,
    summary: "List interactive_watch peer Inbox items and PeerRequest snapshots for this principal.",
    fields: [
      text("state", false, "--state"),
      text("requestKind", false, "--kind"),
      text("workId", false, "--work"),
      text("lane", false, "--lane"),
      flagBool("sent", "--sent"),
      flagNum("limit", "--limit"),
    ],
  },
  {
    id: "promote",
    read: false,
    summary: "Promote a PeerRequest into a formal HA task under an existing work atomically.",
    fields: [requestIdField, text("work", true, "--work"), text("title", false, "--title"), key],
  },
  {
    id: "handoff",
    read: false,
    summary: "Bundle local WIP state and receipts into a ContinuationPacket and hand off to a peer CEO.",
    fields: [
      text("targetId", true),
      text("toPersonId", true, "--to"),
      text("summary", false, "--summary"),
      text("nextAction", false, "--next-action"),
      text("blockingGate", false, "--blocking-gate"),
      flagNum("prNumber", "--pr-number"),
      text("workId", false, "--work"),
      text("lane", false, "--lane"),
      text("wipCommitSha", false, "--wip-commit-sha"),
      text("bundlePath", false, "--bundle-path"),
      text("fromPersonId", false, "--from-person-id"),
      text("nodeId", false, "--node-id"),
      key,
    ],
  },
] as const;

export function createPeerActionCatalog(baseAction: (id: string) => EntityActionContract) {
  return {
    ref: "kernel/peer-action/v1",
    actions: peerActionDefinitions.map(
      ({ id, read, fields, summary }): EntityActionContract => ({
        ...baseAction(id),
        input: { schema: "entity-action-input/v1", fields, exactlyOneOf: [] },
        explain: summary,
        concurrency: {
          expectedVersion: {
            authority: "canonical-entity-revision",
            required: false,
            arbitration: "center-single-write-queue",
          },
          leasePolicy: { authority: "repository-writer-epoch" },
          occurrenceClaim: { authority: "not-applicable" },
          idempotency: { authority: "operation-id", input: "idempotencyKey" },
          artifactOwnership: { owner: "peer-request/{id}", path: "peer-requests/{id}.json" },
        },
        effects: read ? [] : [{ ref: "peer_request_opened", projection: "peer-request/v1" }],
        execution: {
          ingress: `peer-${id}`,
          compile: null,
          read,
          implementation: "catalog-runtime",
          topology: "center-forward-write",
          targetIdField: id === "handoff" ? "targetId" : "requestId",
        },
      }),
    ),
  };
}
