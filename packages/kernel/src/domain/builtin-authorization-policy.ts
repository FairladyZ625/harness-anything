import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** The provider owns its version marker and shapes; the registry binds only their exact source. */
export const builtinAuthorizationContractPolicy = {
  id: "builtin-authorization-contract",
  ownerRef: "host",
  unit: "provider policy version marker",
  bounds: "The builtin adapter owns the builtin-policy@1 protocol marker; it is not a quota or an authorization grant.",
  defaultValue: null,
  version: 1,
  scope: "Builtin authorization decision provenance",
  reason:
    "Classify a policy-shaped protocol identifier while leaving provider implementation and provider-specific shapes in their existing remediation boundary.",
  fixtures: [
    "packages/daemon/test/builtin-identity-provider.test.ts",
    "tools/gates/test/authorization-provider-boundary.test.mjs",
    "tools/gates/test/ontology-closure.test.mjs",
  ],
  sources: [
    {
      candidateId:
        "policy:packages/authorization-builtin:packages/authorization-builtin/src/builtin-policy-adapter.ts#BuiltinPolicyAdapter.policyRef:196006167e2921ac6350b76ee3660eb2",
      route: "BuiltinPolicyAdapter.policyRef",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
