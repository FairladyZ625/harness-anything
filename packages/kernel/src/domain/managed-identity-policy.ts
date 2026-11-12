import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Host-owned process inspection and request-driven recovery share one lifecycle boundary. */
export const managedIdentityPolicy = {
  id: "managed-identity-lifecycle",
  ownerRef: "host",
  unit: "milliseconds / in-flight resume",
  bounds:
    "Process inspection and Windows tree termination each have a 5000ms deadline. Failed startup resumes are retried by a later request; at most one resume is in flight, with no autonomous retry loop. Existing managed-child restart backoff is unchanged.",
  defaultValue: { timeoutMs: 5_000 },
  version: 1,
  scope: "managed identity process ownership inspection, tree termination and daemon startup recovery",
  reason:
    "Reclaim only processes proven to belong to the configured managed runtime; release a rejected startup promise so a transient bind failure cannot permanently disable authentication.",
  fixtures: [
    "packages/daemon/test/managed-rbac-process-orphan.integration.test.ts",
    "packages/daemon/test/daemon-host-keycloak-resume.test.ts",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/managed-identity-policy.ts#managedIdentityPolicy.defaultValue.timeoutMs:08b0a8a64d90c6ee0feb0e9b7d52b2ae",
      route: "daemon:bin",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
