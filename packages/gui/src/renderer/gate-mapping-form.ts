/**
 * 门映射编辑面的判定层:草稿形状、合法组合校验、提交载荷派生。
 *
 * 合法组合的权威是 kernel 的 completion-contract(gateMappingAdapterFields /
 * gateGovernanceFields / governableWitnessAdapterIds / CODE_DOC_GATE_ID),GUI 不手抄——
 * 规则经 catalog snapshot 的 gateMappings 描述面投影进来,本模块只消费它。
 * 校验镜像 kernel 的 gateWitnessMappingIssues:界面上挡住的组合,中心同样会拒。
 *
 * 与 settings-form 同型:判定与渲染分开,判定是纯模块。
 */

import type { CatalogGateMappingsDescriptor } from "./api-client-catalog.ts";

/** settings.gates 单条映射的草稿形状(扁平;wire 上与 kernel GateWitnessMappingV1 同键)。 */
export interface GateMappingDraft {
  readonly gateId: string;
  readonly adapter: string;
  readonly appliesTo?: string;
  readonly branch?: string;
  readonly event?: string;
  readonly command?: string;
  readonly coverage?: string;
  readonly selection?: string;
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
  | "governanceNotAllowed"
  | "coverageInvalid"
  | "selectionInvalid"
  | "internalGateAdapter";

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
 * 加在 governable adapter 上;option 字段集必须与 adapter 恰好一致;内建门只能 none。
 */
export function gateMappingRowIssues(
  drafts: readonly GateMappingDraft[],
  descriptor: CatalogGateMappingsDescriptor,
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
    if (adapter === "github-actions") {
      if (options.coverage !== undefined && options.coverage !== "exact" && options.coverage !== "descendant")
        issues.push({ row, issue: "coverageInvalid" });
      if (options.selection !== undefined && options.selection !== "newest")
        issues.push({ row, issue: "selectionInvalid" });
    }
    if (gateId === descriptor.internalGateId && adapter !== "none") issues.push({ row, issue: "internalGateAdapter" });
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
      ...(mandatorySignoff === true ? { mandatorySignoff: true } : {}),
      ...(allowOverride === true ? { allowOverride: true } : {}),
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
