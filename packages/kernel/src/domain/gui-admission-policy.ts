import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";

export interface TrustPolicy {
  readonly projectId: string;
  readonly allowedRoots: readonly string[];
  readonly allowedLocalhostPorts?: readonly number[];
  readonly allowedUrlOrigins: readonly string[];
  readonly openExternalByDefault: boolean;
}

export type TrustPolicyValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: "invalid_trust_policy";
        readonly hint: string;
      };
    };

function invalidPolicy(hint: string): TrustPolicyValidationResult {
  return {
    ok: false,
    error: {
      code: "invalid_trust_policy",
      hint,
    },
  };
}

export function validateDesktopTrustPolicy(
  policy: TrustPolicy,
  isAbsolute: (value: string) => boolean,
  isValidOrigin: (value: string) => boolean,
): TrustPolicyValidationResult {
  if (!policy.projectId) return invalidPolicy("TrustPolicy requires projectId.");
  if (policy.allowedRoots.length === 0 || !policy.allowedRoots.every((root) => isAbsolute(root))) {
    return invalidPolicy("TrustPolicy allowedRoots must be non-empty absolute paths.");
  }
  if ((policy.allowedLocalhostPorts ?? []).some((port) => !Number.isInteger(port) || port <= 0 || port > 65535)) {
    return invalidPolicy("TrustPolicy allowedLocalhostPorts must be valid TCP ports.");
  }
  if (!policy.allowedUrlOrigins.every(isValidOrigin)) {
    return invalidPolicy("TrustPolicy allowedUrlOrigins must be URL origins.");
  }
  return { ok: true };
}

export function isMirrorQuotaValid(value: unknown): value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) return false;
  return true;
}

export function shouldExpireApproval(
  timeoutMs: number | null,
  expired: boolean,
  frozen: boolean,
  remainingMs: number | null,
): boolean {
  if (timeoutMs === null || expired || frozen || remainingMs !== 0) return false;
  return true;
}

export const guiAdmissionPolicy = {
  id: "gui-admission-policy",
  ownerRef: "host",
  unit: "desktop admission and draft constraints",
  bounds: "Preserve trust roots/origins/ports, positive mirror quota, single approval expiry.",
  defaultValue: null,
  version: 1,
  scope: "gui-admission-policy",
  reason: "Keep the existing desktop guard and its single pure implementation together.",
  fixtures: [
    "packages/gui/test/trust-policy-contract.test.ts",
    "packages/gui/test/center-settings-ipc.vitest.ts",
    "packages/gui/test/agent-ui-orchestration.vitest.tsx",
    "packages/gui/test/attestation-pool-model.vitest.ts",
  ],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#validateDesktopTrustPolicy:75a129f6bff70b93858bcfeb6175790d",
    "policy:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#validateDesktopTrustPolicy:e838ecb5a6d5452349509c24c5605e27",
    "policy:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#shouldExpireApproval:d1d17cdfa57b6fc52551d44e9c3f1d71",
  ].map((candidateId) => ({ candidateId, route: "guiAdmissionPolicy" })),
} as const satisfies OntologyPolicyDeclaration;
export const guiAdmissionPolicyJudgments = [
  {
    id: "validateDesktopTrustPolicy",
    symbol: "packages/kernel/src/domain/gui-admission-policy.ts#validateDesktopTrustPolicy",
    inputs: ["TrustPolicy", "absolute-path predicate", "origin predicate"],
    output: "TrustPolicyValidationResult",
    failureCodes: ["invalid_trust_policy"],
    explain: "Preserve trust roots/origins/ports, positive mirror quota, single approval expiry.",
    consumers: ["packages/gui/src/main/trust-policy.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#validateDesktopTrustPolicy:c5dc92dd7cdf25d679373dfe3ea5e55e",
        route: "gui-admission-policy",
      },
    ],
  },
  {
    id: "isMirrorQuotaValid",
    symbol: "packages/kernel/src/domain/gui-admission-policy.ts#isMirrorQuotaValid",
    inputs: ["unknown mirror quota"],
    output: "boolean",
    failureCodes: [],
    explain:
      "Preserve trust roots/origins/ports, positive mirror quota, single approval expiry, and contract-authorized gate override.",
    consumers: [
      "packages/gui/src/main/center-settings-ipc.ts",
      "packages/gui/src/renderer/views/settings/centerService.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#isMirrorQuotaValid:b637a9d921eb5b8572c810cb78ec3299",
        route: "gui-admission-policy",
      },
    ],
  },
  {
    id: "shouldExpireApproval",
    symbol: "packages/kernel/src/domain/gui-admission-policy.ts#shouldExpireApproval",
    inputs: ["timeoutMs", "expired", "frozen", "remainingMs"],
    output: "boolean",
    failureCodes: [],
    explain:
      "Preserve trust roots/origins/ports, positive mirror quota, single approval expiry, and contract-authorized gate override.",
    consumers: ["packages/gui/src/renderer/components/agent-ui/ApprovalCard.tsx"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/gui-admission-policy.ts#shouldExpireApproval:25eb196418507c80132f5fa8ec7508c6",
        route: "gui-admission-policy",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
