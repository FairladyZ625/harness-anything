import { useQuery } from "@tanstack/react-query";
import type { CatalogSnapshotSuccess } from "../api/renderer-dto.ts";
import { harnessClient } from "./api-client.ts";
import type { AdapterInfo, PresetEntry, TemplateInfo, VerticalInfo } from "./model/types.ts";

export interface CatalogRendererData {
  readonly activeVerticalId: string;
  readonly activePresetId?: string;
  readonly customVerticalsImplemented: false;
  readonly presets: PresetEntry[];
  readonly verticals: VerticalInfo[];
  readonly templates: TemplateInfo[];
  readonly adapters: AdapterInfo[];
}

export function useCatalogQuery(repoId?: string | null) {
  return useQuery({
    queryKey: ["harness", "catalog", "snapshot", repoId ?? "default"],
    queryFn: () => harnessClient.getCatalogSnapshot(repoId ?? undefined),
    select: adaptCatalogSnapshot,
    staleTime: 10_000
  });
}

export function adaptCatalogSnapshot(snapshot: CatalogSnapshotSuccess): CatalogRendererData {
  return {
    activeVerticalId: snapshot.activeVerticalId,
    activePresetId: snapshot.activePresetId,
    customVerticalsImplemented: snapshot.customVerticalsImplemented,
    presets: snapshot.presets.map((preset) => ({
      id: preset.id,
      title: preset.title,
      source: preset.source,
      version: preset.version,
      kind: preset.kind,
      vertical: preset.vertical,
      extends: preset.extends,
      capabilityImports: [...preset.capabilityImports],
      profile: preset.defaultProfile,
      selections: preset.selections.map((selection) => ({
        slot: selection.slot,
        templateRef: selection.templateRef,
        materializeAs: selection.materializeAs,
        locales: [...selection.locales]
      })),
      valid: preset.valid,
      issueCount: preset.issueCount
    })),
    verticals: snapshot.verticals.map((vertical) => ({
      id: vertical.id,
      title: vertical.title,
      version: vertical.version,
      entityKinds: vertical.entityKinds.map((kind) => ({
        id: kind.id,
        kind: kind.entityType,
        contractEntity: kind.contractEntity
      })),
      templateSlots: [...vertical.templateSlots]
    })),
    templates: snapshot.templates.map((template) => ({
      ref: template.ref,
      documentKind: template.documentKind,
      version: template.version,
      locales: [...template.locales],
      usedByPresetIds: [...template.usedByPresetIds]
    })),
    adapters: snapshot.adapters.map((adapter) => ({
      engine: adapter.id,
      displayName: adapter.id === "local" ? "Local Documents" : "Multica",
      capabilities: [...adapter.capabilities],
      readonly: adapter.readonly,
      writable: adapter.writable,
      defaultProvider: adapter.defaultProvider
    }))
  };
}
