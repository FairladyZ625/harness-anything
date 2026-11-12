/**
 * 门映射编辑面的判定层:草稿形状、合法组合校验、提交载荷派生。
 *
 * 合法组合的权威是 kernel 的 completion-contract(gateMappingAdapterFields /
 * gateGovernanceFields / governableWitnessAdapterIds),GUI 不手抄——
 * 规则经 catalog snapshot 的 gateMappings 描述面投影进来,本模块只消费它。
 * 校验镜像 kernel 的 gateWitnessMappingIssues:界面上挡住的组合,中心同样会拒。
 *
 * 与 settings-form 同型:判定与渲染分开,判定是纯模块。
 */

import type { OntologyPolicyDeclaration, OntologyJudgmentDeclaration } from "./ontology-source.ts";
interface GateMappingDescriptor {
  readonly adapters: readonly string[];
  readonly adapterFields: Readonly<Record<string, readonly string[]>>;
  readonly governableAdapters: readonly string[];
}

/** settings.gates 单条映射的草稿形状(扁平;wire 上与 kernel GateWitnessMappingV1 同键)。 */
export interface GateMappingDraft {
  readonly gateId: string;
  readonly adapter: string;
  readonly appliesTo?: string;
  readonly mandatorySignoff?: boolean;
  readonly allowOverride?: boolean;
}

/** 校验问题的稳定代号;渲染层映射到文案 key。 */
export type GateMappingIssue =
  | "gateIdPattern"
  | "gateIdDuplicate"
  | "adapterUnknown"
  | "adapterFieldMissing"
  | "adapterFieldUnexpected"
  | "governanceNotAllowed";

export interface GateMappingRowIssue {
  readonly row: number;
  readonly issue: GateMappingIssue;
  readonly field?: string;
}

const GATE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_.@-]*$/u;

/** settings read 的 settings.gates → 编辑草稿;原样保留未知键,不静默丢值。 */
export function gateMappingDrafts(gates: readonly unknown[]): GateMappingDraft[] {
  return gates.map((mapping) => ({ ...(mapping as GateMappingDraft) }));
}

/**
 * 行级校验,镜像 kernel gateWitnessMappingIssues 的判据:治理修饰只允许 true 且只能
 * 加在 governable adapter 上;option 字段集必须与 adapter 恰好一致。
 */
export function validateGateMappingDraftRows(
  drafts: readonly GateMappingDraft[],
  descriptor: GateMappingDescriptor,
): readonly GateMappingRowIssue[] {
  const issues: GateMappingRowIssue[] = [],
    seen = new Set<string>();
  drafts.forEach((draft, row) => {
    const { gateId, adapter, mandatorySignoff, allowOverride, ...options } = draft;
    if (!GATE_ID_PATTERN.test(gateId)) issues.push({ row, issue: "gateIdPattern" });
    if (seen.has(gateId)) issues.push({ row, issue: "gateIdDuplicate" });
    seen.add(gateId);
    if (!descriptor.adapters.includes(adapter)) {
      issues.push({ row, issue: "adapterUnknown" });
      return;
    }
    const expected = descriptor.adapterFields[adapter] ?? [],
      actual = Object.keys(options).filter((key) => options[key as keyof typeof options] !== undefined);
    for (const field of expected)
      if (!actual.includes(field) || String(options[field as keyof typeof options] ?? "").trim() === "")
        issues.push({ row, issue: "adapterFieldMissing", field });
    for (const field of actual)
      if (!expected.includes(field)) issues.push({ row, issue: "adapterFieldUnexpected", field });
    if (
      (mandatorySignoff !== undefined || allowOverride !== undefined) &&
      (!descriptor.governableAdapters.includes(adapter) || mandatorySignoff === false || allowOverride === false)
    )
      issues.push({ row, issue: "governanceNotAllowed" });
  });
  return issues;
}

/**
 * 提交载荷的 gatesDraft:与当前 settings.gates 规范化比较,未变则不携带
 * (settings-update 照常走 no-changes)。治理修饰只序列化 true——false 与缺省
 * 语义相同,中心也只接受 true。
 */
export function gatesDraftValue(
  current: readonly unknown[],
  drafts: readonly GateMappingDraft[],
): readonly GateMappingDraft[] | undefined {
  const normalized = drafts.map((draft) => {
    const { mandatorySignoff, allowOverride, ...rest } = draft;
    return {
      ...rest,
      ...normalizedGateGovernance({ mandatorySignoff, allowOverride }),
    };
  });
  return stableDraftKey(normalized) === stableDraftKey(current as readonly GateMappingDraft[]) ? undefined : normalized;
}

function stableDraftKey(gates: readonly GateMappingDraft[]): string {
  return JSON.stringify(
    gates.map(({ gateId, adapter, ...options }) => [
      gateId,
      adapter,
      Object.entries(options)
        .filter(([, value]) => value !== undefined && value !== false)
        .sort(([left], [right]) => left.localeCompare(right)),
    ]),
  );
}

export function normalizedGateGovernance({
  mandatorySignoff,
  allowOverride,
}: Pick<GateMappingDraft, "mandatorySignoff" | "allowOverride">) {
  return {
    ...(mandatorySignoff === true ? { mandatorySignoff: true as const } : {}),
    ...(allowOverride === true ? { allowOverride: true as const } : {}),
  };
}
export function gateGovernanceValue(enabled: boolean): true | undefined {
  return enabled ? true : undefined;
}

export const gateMappingPolicy = {
  id: "gate-mapping-policy",
  ownerRef: "host",
  unit: "desktop admission and draft constraints",
  bounds: "Validate declared adapter fields and governance capabilities; normalize governance flags to true or absent.",
  defaultValue: null,
  version: 1,
  scope: "gate-mapping-policy",
  reason: "Keep the existing desktop guard and its single pure implementation together.",
  fixtures: ["packages/gui/test/settings-gate-mappings.vitest.tsx"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/gate-mapping-policy.ts#validateGateMappingDraftRows:1d2a8f6652cd28da761e02874a1422a9",
    "policy:packages/kernel:packages/kernel/src/domain/gate-mapping-policy.ts#normalizedGateGovernance:65ff3864442a1d5595489a876521f5f7",
  ].map((candidateId) => ({ candidateId, route: "gate-mapping-policy" })),
} as const satisfies OntologyPolicyDeclaration;
export const gateMappingPolicyJudgments = [
  {
    id: "validateGateMappingDraftRows",
    symbol: "packages/kernel/src/domain/gate-mapping-policy.ts#validateGateMappingDraftRows",
    inputs: ["GateMappingDraft[]", "GateMappingDescriptor"],
    output: "GateMappingRowIssue[]",
    failureCodes: [
      "gateIdPattern",
      "gateIdDuplicate",
      "adapterUnknown",
      "adapterFieldMissing",
      "adapterFieldUnexpected",
      "governanceNotAllowed",
    ],
    explain:
      "Validate declared adapter fields and governance capabilities; normalize governance flags to true or absent.",
    consumers: ["packages/gui/src/renderer/views/settings/RepositorySettingsPanel.tsx"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/gate-mapping-policy.ts#validateGateMappingDraftRows:8b20e546c618454fdb3c625821f18e7a",
        route: "gate-mapping-policy",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
