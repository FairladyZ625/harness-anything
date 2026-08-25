import type { PolicyDeclarationV1 } from "./policy.ts";

/** The single built-in policy package. Action rules mirror the eight object-level checks
 * that currently live outside a shared AuthorizationPort; later slices consume this declaration. */
const defaultPolicyDeclaration = {
  schema: "policy/v1",
  id: "default",
  version: 1,
  predicates: Object.freeze([
    { predicate: "isOwner" },
    { predicate: "isExecutorOfExecution" },
    { predicate: "hasCommandClass", commandClass: "arbiter" },
    { predicate: "reviewIndependence", level: "L1" },
  ]),
  actions: Object.freeze([
    "task.consent",
    "task.complete",
    "execution.review",
    "decision.accept",
    "execution.release",
    "runtime.dispatch",
    "doc.submit",
    "task.closeout",
  ]),
  rules: Object.freeze([
    { action: "task.consent", mode: "all", predicates: [{ predicate: "isOwner" }] },
    { action: "task.complete", mode: "all", predicates: [{ predicate: "isOwner" }] },
    {
      action: "execution.review",
      mode: "all",
      predicates: [{ predicate: "reviewIndependence", level: "L1" }],
    },
    {
      action: "decision.accept",
      mode: "all",
      predicates: [
        { predicate: "hasCommandClass", commandClass: "arbiter" },
        { predicate: "reviewIndependence", level: "L1" },
      ],
    },
    {
      action: "execution.release",
      mode: "any",
      predicates: [{ predicate: "isExecutorOfExecution" }, { predicate: "isOwner" }],
    },
    {
      action: "runtime.dispatch",
      mode: "all",
      predicates: [{ predicate: "isExecutorOfExecution" }],
    },
    {
      action: "doc.submit",
      mode: "any",
      predicates: [{ predicate: "isExecutorOfExecution" }, { predicate: "isOwner" }],
    },
    { action: "task.closeout", mode: "all", predicates: [{ predicate: "isOwner" }] },
  ]),
} satisfies PolicyDeclarationV1;

export const DEFAULT_POLICY: PolicyDeclarationV1 = Object.freeze(defaultPolicyDeclaration);

export const defaultPolicy = DEFAULT_POLICY;
