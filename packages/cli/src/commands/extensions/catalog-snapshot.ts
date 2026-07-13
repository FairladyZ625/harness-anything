import type {
  CatalogPresetEntry,
  CatalogSnapshotResult,
  CatalogTemplateEntry,
  CatalogTemplateSelection
} from "../../../../application/src/index.ts";
import type { HarnessLayoutInput } from "../../../../kernel/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import type { CliResult } from "../../cli/types.ts";
import { adapterProviderRegistry } from "../../composition/adapter-registry.ts";
import { readProjectHarnessSettings } from "../settings.ts";
import { resolveActiveVertical } from "./active-vertical.ts";
import { bundledTemplateCatalog } from "./bundled.ts";
import { discoverPresetEntries, isInvalidPreset } from "./state.ts";

export function readCatalogSnapshot(rootInput: HarnessLayoutInput): CatalogSnapshotResult {
  const activeVertical = resolveActiveVertical(rootInput, "catalog-snapshot");
  if (!activeVertical.ok) return cliFailure(activeVertical.result);
  const settings = readProjectHarnessSettings(rootInput, "catalog-snapshot");
  if (!settings.ok) return cliFailure(settings.result);

  const catalog = bundledTemplateCatalog(activeVertical.id);
  if (!catalog) {
    return {
      ok: false,
      error: cliError(CliErrorCode.TemplateCatalogInvalid, `No bundled template catalog for ${activeVertical.id}.`)
    };
  }

  const templateLocales = new Map(catalog.documents.map((document) => [
    `template://${document.id}@${document.version}`,
    document.locales.map((locale) => locale.locale)
  ]));
  const presets = discoverPresetEntries(rootInput, activeVertical.id).map((entry): CatalogPresetEntry => {
    if (isInvalidPreset(entry)) {
      return {
        id: entry.id,
        source: entry.layer,
        capabilityImports: [],
        selections: [],
        valid: false,
        issueCount: entry.issues.length
      };
    }
    const profile = entry.manifest.profiles.find((candidate) => candidate.id === entry.manifest.defaultProfile);
    return {
      id: entry.manifest.id,
      title: entry.manifest.title,
      source: entry.layer,
      version: entry.manifest.version,
      kind: entry.manifest.kind ?? "template-content",
      vertical: entry.manifest.vertical,
      ...(entry.manifest.extends ? { extends: entry.manifest.extends } : {}),
      defaultProfile: entry.manifest.defaultProfile,
      capabilityImports: [
        ...entry.manifest.capabilityImports.map((capability) => capability.id),
        ...(profile?.capabilityImports ?? []).map((capability) => capability.id)
      ],
      selections: (profile?.templateSelections ?? []).map((selection): CatalogTemplateSelection => ({
        slot: selection.slot,
        templateRef: selection.templateRef,
        materializeAs: selection.materializeAs,
        locales: templateLocales.get(selection.templateRef) ?? [selection.localePolicy.fallback]
      })),
      valid: true,
      issueCount: 0
    };
  });
  const usedByPresetIds = templateUsage(presets);
  const vertical = activeVertical.definition.manifest;

  return {
    ok: true,
    activeVerticalId: activeVertical.id,
    ...(settings.settings.defaultPreset ? { activePresetId: settings.settings.defaultPreset } : {}),
    customVerticalsImplemented: false,
    presets,
    verticals: [{
      id: vertical.id,
      title: vertical.title,
      version: vertical.version,
      entityKinds: vertical.entityKinds.map((kind) => ({
        id: kind.id,
        entityType: kind.entityType,
        contractEntity: kind.contractEntity
      })),
      templateSlots: [...new Set([
        ...vertical.packageScaffolds.flatMap((scaffold) => scaffold.templateSelections.map((selection) => selection.slot)),
        ...vertical.templateSelections.map((selection) => selection.slot),
        ...vertical.repositoryScaffold.seededDocs.map((selection) => selection.slot)
      ])].sort()
    }],
    templates: catalog.documents.map((document): CatalogTemplateEntry => {
      const ref = `template://${document.id}@${document.version}`;
      return {
        ref,
        documentKind: document.documentKind,
        version: document.version,
        locales: document.locales.map((locale) => locale.locale),
        usedByPresetIds: usedByPresetIds.get(ref) ?? []
      };
    }),
    adapters: adapterProviderRegistry.map((adapter) => ({
      id: adapter.id,
      capabilities: [...adapter.capabilities],
      readonly: adapter.readonly,
      writable: adapter.writable,
      defaultProvider: "defaultProvider" in adapter ? adapter.defaultProvider : false
    }))
  };
}

function templateUsage(presets: ReadonlyArray<CatalogPresetEntry>): ReadonlyMap<string, ReadonlyArray<string>> {
  const usage = new Map<string, string[]>();
  for (const preset of presets) {
    for (const selection of preset.selections) {
      const ids = usage.get(selection.templateRef) ?? [];
      ids.push(preset.id);
      usage.set(selection.templateRef, ids);
    }
  }
  return usage;
}

function cliFailure(result: CliResult): CatalogSnapshotResult {
  return {
    ok: false,
    error: cliError(
      result.error?.code ?? CliErrorCode.HarnessSettingsInvalid,
      result.error?.hint ?? "Catalog resolution failed."
    )
  };
}
