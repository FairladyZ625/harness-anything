import type { PolicyDeclarationV1 } from "./policy.ts";

/** The single built-in policy package consumed by the kernel AuthorizationPort. */
const defaultPolicyDeclaration = {
  schema: "policy/v1",
  id: "default",
  version: 2,
  predicates: Object.freeze([
    { predicate: "isOwner" },
    { predicate: "isSameExecutionOwner" },
    { predicate: "holdsExecutionLease" },
    { predicate: "reclaimsOrphanedLease" },
    { predicate: "dispatchesExecution" },
    { predicate: "delegatedByRuntimeSession" },
    { predicate: "hasCommandClass", commandClass: "arbiter" },
    { predicate: "hasCommandClass", commandClass: "repo-write" },
    { predicate: "reviewIndependence", level: "L1" },
    { predicate: "isNotProposalAgent" },
    { predicate: "sameWriteSource" },
  ]),
  actions: Object.freeze([
    "task.consent",
    "task.complete",
    "execution.start",
    "execution.review",
    "decision.accept",
    "execution.release",
    "runtime.dispatch",
    "doc.submit",
    "task.closeout",
  ]),
  rules: Object.freeze([
    { action: "task.consent", anyOf: [{ allOf: [{ predicate: "isSameExecutionOwner" }] }] },
    { action: "task.complete", anyOf: [{ allOf: [{ predicate: "isOwner" }] }] },
    { action: "execution.start", anyOf: [{ allOf: [{ predicate: "hasCommandClass", commandClass: "repo-write" }] }] },
    {
      action: "execution.review",
      anyOf: [
        {
          allOf: [
            { predicate: "hasCommandClass", commandClass: "arbiter" },
            { predicate: "reviewIndependence", level: "L1" },
          ],
        },
      ],
    },
    {
      action: "decision.accept",
      anyOf: [
        {
          allOf: [
            { predicate: "hasCommandClass", commandClass: "arbiter" },
            { predicate: "isNotProposalAgent" },
            {
              predicate: "reviewIndependence",
              level: "L1",
              gatedBy: { env: "HARNESS_REVIEW_INDEPENDENCE" },
            },
          ],
        },
      ],
    },
    {
      action: "execution.release",
      anyOf: [{ allOf: [{ predicate: "holdsExecutionLease" }] }, { allOf: [{ predicate: "reclaimsOrphanedLease" }] }],
    },
    {
      action: "runtime.dispatch",
      anyOf: [
        { allOf: [{ predicate: "dispatchesExecution" }] },
        { allOf: [{ predicate: "delegatedByRuntimeSession" }] },
      ],
    },
    {
      action: "doc.submit",
      anyOf: [
        { allOf: [{ predicate: "holdsExecutionLease" }, { predicate: "sameWriteSource" }] },
        { allOf: [{ predicate: "delegatedByRuntimeSession" }, { predicate: "sameWriteSource" }] },
      ],
    },
    { action: "task.closeout", scope: "owner", anyOf: [{ allOf: [{ predicate: "isOwner" }] }] },
    {
      action: "task.closeout",
      scope: "active",
      anyOf: [{ allOf: [{ predicate: "holdsExecutionLease" }] }],
    },
  ]),
} satisfies PolicyDeclarationV1;

export const DEFAULT_POLICY: PolicyDeclarationV1 = Object.freeze(defaultPolicyDeclaration);

export const defaultPolicy = DEFAULT_POLICY;
