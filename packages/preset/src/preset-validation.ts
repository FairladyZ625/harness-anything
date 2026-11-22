import { existsSync } from "node:fs";
import { createRuntime } from "./preset-runtime.ts";
import { loadCanonicalAssets, resolveVerticalAssetsRoot } from "./preset-assets.ts";
import { decodePackage, presetDocumentValue, scan } from "./preset-package.ts";
import {
  asFailure,
  builtinVerticalAssetRootSet,
  builtinVerticalRoots,
  presetFailure,
} from "./preset-resolver-common.ts";
import type { PresetFailure } from "./preset-resolver-types.ts";
import { consumeKnownError, validatePresetDocumentV1, validatePresetManifestV3 } from "./preset.contract.ts";
import path from "node:path";

export function validatePresetPackage(input: { readonly source: string }) {
  const source = path.resolve(input.source),
    issues: PresetFailure[] = [];
  let files: Map<string, string>;
  try {
    files = scan(source);
  } catch (error) {
    const issue = asFailure(error);
    return {
      schema: "preset-validate-report/v1" as const,
      valid: false,
      source,
      issues: [issue],
    };
  }
  const manifestBody = files.get("preset.json");
  if (manifestBody === undefined)
    issues.push(
      presetFailure("missing_manifest", `Preset package is missing preset.json; expected a v3 JSON manifest.`),
    );
  else {
    try {
      const raw = JSON.parse(manifestBody) as unknown;
      for (const message of validatePresetManifestV3(raw)) issues.push(presetFailure("invalid_manifest", message));
    } catch (error) {
      consumeKnownError(error);
      issues.push(
        presetFailure("invalid_manifest", `preset.json is not valid JSON; expected a preset-manifest/v3 object.`),
      );
    }
  }
  const documentBody = files.get("PRESET.md");
  if (documentBody === undefined)
    issues.push(
      presetFailure(
        "missing_preset_document",
        "Preset package is missing PRESET.md; expected schema: " +
          "preset-document/v1 YAML frontmatter and a markdown body.",
      ),
    );
  else
    for (const message of validatePresetDocumentV1(presetDocumentValue(documentBody)))
      issues.push(presetFailure("invalid_preset_document", message));
  if (issues.length)
    return {
      schema: "preset-validate-report/v1" as const,
      valid: false,
      source,
      issues,
    };
  try {
    const decoded = decodePackage(source, true, undefined, files);
    return {
      schema: "preset-validate-report/v1" as const,
      valid: true,
      source,
      preset: {
        id: decoded.manifest.id,
        verticalId: decoded.manifest.vertical,
        version: decoded.manifest.version,
        digest: decoded.packageDigest,
      },
      issues: [],
    };
  } catch (error) {
    const issue = asFailure(error);
    return {
      schema: "preset-validate-report/v1" as const,
      valid: false,
      source,
      issues: [issue],
    };
  }
}

export function validateVerticalSource(
  input: {
    readonly source?: string;
    readonly assetsRoot?: string;
    readonly rootDir?: string;
    readonly presetId?: string;
    readonly userRoot?: string;
  } = {},
) {
  if (input.source === undefined && input.assetsRoot === undefined) {
    return {
      schema: "vertical-validate-report/v1" as const,
      source: "",
      available: false,
      valid: false,
      issues: [presetFailure("missing_vertical", "Vertical source is required.")],
    };
  }
  const requested = input.source ?? input.assetsRoot!,
    explicitBuiltin = requested.startsWith("builtin:"),
    builtinId = explicitBuiltin ? requested.slice("builtin:".length) : requested,
    builtin = builtinVerticalRoots.has(builtinId);
  let source = path.resolve(input.rootDir ?? process.cwd(), requested);
  try {
    source =
      input.assetsRoot ??
      (explicitBuiltin && builtin
        ? builtinVerticalRoots.get(builtinId)!
        : builtin
          ? resolveVerticalAssetsRoot(builtinId, input.rootDir)
          : existsSync(source)
            ? source
            : resolveVerticalAssetsRoot(requested, input.rootDir));
    const isBuiltinSource = builtinVerticalAssetRootSet.has(path.resolve(source));
    const assets = loadCanonicalAssets(source),
      vertical = assets.compiledVertical.definition,
      refs = [
        ...vertical.packageScaffolds.flatMap(({ templateSelections }) => templateSelections),
        ...vertical.repositoryScaffold.seededDocs,
        ...vertical.templateSelections,
        ...(vertical.repositoryScaffold.agentsEntry
          ? [
              {
                templateRef: vertical.repositoryScaffold.agentsEntry.baseRef,
              },
              {
                templateRef: vertical.repositoryScaffold.agentsEntry.overlayRef,
              },
            ]
          : []),
      ],
      known = new Set(assets.catalog.catalog.documents.map(({ id, version }) => `template://${id}@${version}`)),
      issues = refs
        .filter(({ templateRef }) => !known.has(templateRef))
        .map(({ templateRef }) =>
          presetFailure("missing_template", `Vertical references unavailable template ${templateRef}.`),
        );
    const resolved = input.presetId
      ? createRuntime({ assetsRoot: source, userRoot: input.userRoot! }).resolveInternal({
          presetId: input.presetId,
          verticalId: vertical.id,
          locale: "en-US",
          purpose: "inspect",
        })
      : undefined;
    return {
      schema: "vertical-validate-report/v1" as const,
      source: isBuiltinSource ? `builtin:${vertical.id}` : source,
      available: true,
      valid: issues.length === 0,
      vertical: {
        id: vertical.id,
        title: vertical.title,
        version: vertical.version,
        completion: resolved?.snapshot.completion ?? vertical.completion,
      },
      issues,
    };
  } catch (error) {
    return {
      schema: "vertical-validate-report/v1" as const,
      source: builtin ? `builtin:${builtinId}` : source,
      available: builtin || existsSync(source),
      valid: false,
      issues: [asFailure(error)],
    };
  }
}
