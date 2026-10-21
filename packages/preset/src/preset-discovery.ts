import { loadCanonicalAssets } from "./preset-assets.ts";
import { materializeSelections } from "./preset-materialization.ts";
import {
  defaultAssets,
  normalizeLocale,
  presetFailure,
  requiredText,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type { Candidate, PresetFailure } from "./preset-resolver-types.ts";
import type { PresetCatalogEntryV1 } from "./preset.contract.ts";
import path from "node:path";

type PresetCatalogDisplayEntry = PresetCatalogEntryV1 & {
  readonly outputShape?: string;
  readonly completionGates?: readonly string[];
  /** Profile ids the manifest declares, in manifest order. Display-only facet:
   * callers that need to enumerate a preset's legal profiles (settings
   * selectors, GUI catalog) read it here instead of re-deriving from disk. */
  readonly profiles?: readonly { readonly id: string; readonly title: string }[];
};

export function runVerticalDiscoveryAction(
  action: Readonly<Record<string, unknown>> & { readonly kind: string },
  assetsRoot = defaultAssets,
): unknown {
  const assets = loadCanonicalAssets(path.resolve(assetsRoot)),
    vertical = assets.compiledVertical.definition,
    source = path.resolve(assetsRoot) === defaultAssets ? `builtin:${vertical.id}` : path.resolve(assetsRoot);
  if (action.kind === "template-list")
    return assets.catalog.catalog.documents
      .map((document) => ({
        templateRef: `template://${document.id}@${document.version}`,
        slot: document.slot,
        materializeAs: document.materializeAs,
        locales: document.locales.map(({ locale }) => locale),
      }))
      .sort((left, right) => left.templateRef.localeCompare(right.templateRef));
  if (action.kind === "template-render") {
    const templateRef = requiredText(action.templateRef, "templateRef"),
      document = assets.catalog.catalog.documents.find(
        ({ id, version }) => `template://${id}@${version}` === templateRef,
      );
    if (!document) throw presetFailure("template_not_found", `Template ${templateRef} is unavailable.`);
    const selection = {
        slot: document.slot,
        templateRef,
        materializeAs: document.materializeAs,
        localePolicy: {
          prefer: "explicit" as const,
          fallback: document.fallbackLocale,
        },
      },
      rendered = materializeSelections(
        [
          {
            selection,
            owner: "doc-sync",
            source: assets.catalog,
            requiredAnchors: document.requiredAnchors,
          },
        ],
        normalizeLocale(requiredText(action.locale ?? "en-US", "locale")),
      )[0]!;
    return {
      schema: "template-render/v1",
      source,
      templateRef,
      slot: rendered.selection.slot,
      path: rendered.selection.materializeAs,
      locale: rendered.locale,
      mediaType: rendered.mediaType,
      requiredAnchors: rendered.requiredAnchors,
      body: rendered.body,
      digest: `sha256:${resolverContentHash(rendered.body)}`,
    };
  }
  const scripts = [...vertical.scripts].sort((left, right) => left.id.localeCompare(right.id));
  if (action.kind === "script-list")
    return scripts.map(({ id, type, metadata }) => ({
      id,
      type,
      purpose: metadata.purpose,
      description: metadata.description,
      execution: "available" as const,
    }));
  if (action.kind === "script-inspect") {
    const id = requiredText(action.scriptId, "scriptId"),
      declaration = scripts.find((script) => script.id === id);
    if (!declaration) throw presetFailure("script_not_found", `Script ${id} is unavailable.`);
    return {
      schema: "vertical-script-inspection/v1",
      source,
      declaration,
      execution: {
        available: true,
        code: "script_run_available",
        nextAction: `Run ha script run ${id} [--dry-run].`,
      },
    };
  }
  throw presetFailure("unsupported_command", `No builtin discovery contract exists for ${action.kind}.`);
}

export function listCatalog(catalog: ReadonlyMap<string, Candidate>, verticalId: string): PresetCatalogDisplayEntry[] {
  return [...catalog.values()]
    .filter((item) => item.verticalId === verticalId)
    .map(
      (item): PresetCatalogDisplayEntry =>
        item.decoded
          ? {
              id: item.id,
              title: item.decoded.manifest.title,
              description: item.decoded.document.description,
              verticalId,
              layer: item.layer,
              source: item.source,
              validity: "valid",
              version: item.decoded.manifest.version,
              kind: item.decoded.manifest.kind,
              defaultProfile: item.decoded.manifest.defaultProfile,
              profiles: item.decoded.manifest.profiles.map(({ id, title }) => ({ id, title })),
              outputShape: item.decoded.manifest.outputShape,
              completionGates: item.decoded.manifest.profiles.find(
                ({ id }) => id === item.decoded?.manifest.defaultProfile,
              )!.completionGates,
              entrypoints: Object.keys(item.decoded.manifest.entrypoints ?? {}).sort(),
              issues: [],
              issueCount: 0,
            }
          : {
              id: item.id,
              title: item.id,
              description: item.error?.message ?? "Invalid package",
              verticalId,
              layer: item.layer,
              source: item.source,
              validity: "blocked",
              issues: [item.error ?? presetFailure("invalid_package", "Invalid package")],
              issueCount: 1,
              errorCode: item.error?.code ?? "invalid_package",
              ...catalogRecovery(item, item.error ?? presetFailure("invalid_package", "Invalid package")),
              ...(item.shadow
                ? {
                    shadows: {
                      layer: "bundled" as const,
                      title: item.shadow.title,
                    },
                  }
                : {}),
            },
    )
    .sort((left, right) => left.id.localeCompare(right.id));
}

export type PresetResolutionAttempt = (
  presetId: string,
) => { readonly ok: true } | { readonly ok: false; readonly error: PresetFailure };

/**
 * The projection `ha preset list` renders: catalog entries plus an actual resolver attempt for every
 * decodable candidate. The resolver remains the only authority for whether a preset is selectable;
 * this projection only maps its failure into the catalog's display vocabulary.
 */
export function listCatalogWithResolution(
  catalog: ReadonlyMap<string, Candidate>,
  verticalId: string,
  resolveAttempt: PresetResolutionAttempt,
): PresetCatalogDisplayEntry[] {
  return listCatalog(catalog, verticalId).map((entry): PresetCatalogDisplayEntry => {
    if (entry.validity !== "valid") return entry;
    const attempt = resolveAttempt(entry.id);
    if (attempt.ok) return entry;
    const failure = attempt.error;
    return {
      ...entry,
      validity: failure.code === "missing_provider" ? ("unavailable" as const) : ("blocked" as const),
      errorCode: failure.code,
      issues: [{ code: failure.code, message: failure.message }],
      issueCount: 1,
      ...catalogRecovery(entry, failure),
    };
  });
}

export function catalogRecovery(
  entry: Pick<Candidate, "source">,
  failureValue: PresetFailure,
): Pick<PresetCatalogEntryV1, "missingProviderIds" | "nextAction"> {
  const missingProviderIds = [...(failureValue.missingProviderIds ?? [])];
  return {
    missingProviderIds,
    nextAction: missingProviderIds.length
      ? `Use a Harness build that provides ${missingProviderIds.join(", ")}, then rerun ha preset list.`
      : `Repair ${entry.source} (${failureValue.code}), then rerun ha preset list.`,
  };
}
