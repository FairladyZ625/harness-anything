import { localErrorHint, isRendererRecord } from "./result-validation.ts";
import type { BridgeError } from "./api-client.ts";

export interface CatalogPresetRow {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly verticalId: string;
  readonly sourceKind: "bundled" | "user" | "user-shadow";
  readonly validity: "valid" | "unavailable" | "blocked";
  readonly version: string | null;
  readonly kind: string | null;
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly entrypoints: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<unknown>;
  readonly shadows: { readonly layer: "bundled"; readonly title: string } | null;
}
export interface CatalogVerticalRow {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly source: "builtin";
  readonly available: boolean;
  readonly valid: boolean;
  readonly issues: ReadonlyArray<unknown>;
}
export interface CatalogTemplateRow {
  readonly templateRef: string;
  readonly slot: string;
  readonly materializeAs: string;
  readonly locales: ReadonlyArray<string>;
}
export interface CatalogAdapterRow {
  readonly adapterId: string;
  readonly registered: true;
  readonly capabilities: ReadonlyArray<string>;
  readonly writability: "read-only" | "read-write" | "unknown";
  readonly defaultProvider: boolean;
  readonly unavailableReason: string | null;
}
export interface CatalogSnapshotSuccess {
  readonly schema: "gui-catalog-snapshot/v1";
  readonly ok: true;
  readonly status: "ready" | "pending";
  readonly repoId: string;
  readonly observedAt: string;
  readonly defaults: {
    readonly verticalId: string;
    readonly presetId: string;
    readonly profileId: string | null;
    readonly locale: string;
  };
  readonly presets: ReadonlyArray<CatalogPresetRow>;
  readonly verticals: ReadonlyArray<CatalogVerticalRow>;
  readonly templates: ReadonlyArray<CatalogTemplateRow>;
  readonly scaffolds: { readonly task: ReadonlyArray<string>; readonly repository: ReadonlyArray<string> };
  /** CI 工作流多选取值面:.github/workflows 的 *.yml 基名,不带扩展名。 */
  readonly ciWorkflows: ReadonlyArray<string>;
  /** 验收人取值面的 bundled 层;已安装层走 agent 目录共享缓存,不进快照。 */
  readonly bundledAgents: ReadonlyArray<string>;
  /** settings 动作契约字段表(daemon 侧校验行 shape):仓库设置表单的派生源。 */
  readonly settingsFields: ReadonlyArray<{
    readonly field: string;
    readonly type: string;
    readonly required: boolean;
    readonly enum?: readonly string[];
  }>;
  readonly adapters: ReadonlyArray<CatalogAdapterRow>;
}
export interface CatalogPresetDocument {
  readonly slot: string;
  readonly path: string;
  readonly body: string;
  readonly mediaType: string;
  readonly owner: string;
  readonly templateRef: string;
}
export interface CatalogPresetSuccess {
  readonly schema: "gui-catalog-preset/v1";
  readonly ok: true;
  readonly repoId: string;
  readonly preset: {
    readonly id: string;
    readonly verticalId: string;
    readonly version: string | null;
    readonly extends: string | null;
    readonly capabilityImports: ReadonlyArray<unknown>;
  };
  readonly resolved: {
    readonly profile: Readonly<Record<string, unknown>>;
    readonly templates: ReadonlyArray<unknown>;
    readonly documents: ReadonlyArray<CatalogPresetDocument>;
    readonly entrypoints: ReadonlyArray<unknown>;
    readonly provenance: Readonly<Record<string, unknown>>;
    readonly digest: string;
  };
}
export interface CatalogRereadReceipt {
  readonly schema: "catalog-reread-receipt/v1";
  readonly ok: boolean;
  readonly outcome: "applied" | "op_rejected";
  readonly operationId: string;
  readonly repoId: string;
  readonly observedAt: string;
  readonly error: BridgeError | null;
}

export function readCatalogSnapshot(value: unknown): CatalogSnapshotSuccess {
  if (!isCatalogSnapshotSuccess(value))
    throw new Error(localErrorHint(value, "Catalog snapshot bridge returned an invalid result."));
  return value;
}

export function readCatalogPreset(value: unknown): CatalogPresetSuccess {
  if (!isCatalogPresetSuccess(value))
    throw new Error(localErrorHint(value, "Catalog preset bridge returned an invalid result."));
  return value;
}

export function readCatalogRereadReceipt(value: unknown): CatalogRereadReceipt {
  if (!isCatalogRereadReceipt(value))
    throw new Error(localErrorHint(value, "Catalog reread bridge returned an invalid receipt."));
  return value;
}

function isCatalogSnapshotSuccess(value: unknown): value is CatalogSnapshotSuccess {
  return (
    isRendererRecord(value) &&
    value.schema === "gui-catalog-snapshot/v1" &&
    value.ok === true &&
    ["ready", "pending"].includes(String(value.status)) &&
    typeof value.repoId === "string" &&
    isRendererRecord(value.defaults) &&
    Array.isArray(value.presets) &&
    Array.isArray(value.verticals) &&
    Array.isArray(value.templates) &&
    Array.isArray(value.adapters) &&
    isRendererRecord(value.scaffolds) &&
    Array.isArray(value.scaffolds.task) &&
    Array.isArray(value.scaffolds.repository) &&
    Array.isArray(value.ciWorkflows) &&
    Array.isArray(value.bundledAgents) &&
    Array.isArray(value.settingsFields) &&
    value.presets.every(
      (row) =>
        isRendererRecord(row) &&
        Array.isArray(row.profiles) &&
        row.profiles.every(
          (profile) => isRendererRecord(profile) && typeof profile.id === "string" && typeof profile.title === "string",
        ),
    )
  );
}

function isCatalogPresetSuccess(value: unknown): value is CatalogPresetSuccess {
  return (
    isRendererRecord(value) &&
    value.schema === "gui-catalog-preset/v1" &&
    value.ok === true &&
    typeof value.repoId === "string" &&
    isRendererRecord(value.preset) &&
    isRendererRecord(value.resolved) &&
    Array.isArray(value.resolved.documents) &&
    value.resolved.documents.every(
      (row) =>
        isRendererRecord(row) &&
        typeof row.slot === "string" &&
        typeof row.path === "string" &&
        typeof row.body === "string" &&
        typeof row.mediaType === "string",
    )
  );
}

function isCatalogRereadReceipt(value: unknown): value is CatalogRereadReceipt {
  return (
    isRendererRecord(value) &&
    value.schema === "catalog-reread-receipt/v1" &&
    typeof value.ok === "boolean" &&
    ["applied", "op_rejected"].includes(String(value.outcome)) &&
    typeof value.operationId === "string" &&
    typeof value.repoId === "string"
  );
}
