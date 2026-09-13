import { localErrorHint, isRendererRecord } from "./result-validation.ts";
import type { CatalogPresetSuccess, CatalogRereadReceipt, CatalogSnapshotSuccess } from "./api-client.ts";

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
