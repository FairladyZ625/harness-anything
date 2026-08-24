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

export function runBuiltinDiscoveryAction(
  action: Readonly<Record<string, unknown>> & { readonly kind: string },
  assetsRoot = defaultAssets,
): unknown {
  const assets = loadCanonicalAssets(path.resolve(assetsRoot)),
    source = `builtin:${assets.vertical.id}`;
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
    if (!document)
      throw presetFailure(
        "template_not_found",
        `Template ${templateRef} is unavailable.`,
      );
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
  const scripts = [...assets.vertical.scripts].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
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
    if (!declaration)
      throw presetFailure("script_not_found", `Script ${id} is unavailable.`);
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
  throw presetFailure(
    "unsupported_command",
    `No builtin discovery contract exists for ${action.kind}.`,
  );
}

export function listCatalog(
  catalog: Map<string, Candidate>,
  verticalId: string,
): PresetCatalogEntryV1[] {
  return [...catalog.values()]
    .filter((item) => item.verticalId === verticalId)
    .map(
      (item): PresetCatalogEntryV1 =>
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
              entrypoints: Object.keys(
                item.decoded.manifest.entrypoints ?? {},
              ).sort(),
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
              issues: [
                item.error ??
                  presetFailure("invalid_package", "Invalid package"),
              ],
              issueCount: 1,
              errorCode: item.error?.code ?? "invalid_package",
              ...catalogRecovery(
                item,
                item.error ??
                  presetFailure("invalid_package", "Invalid package"),
              ),
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
