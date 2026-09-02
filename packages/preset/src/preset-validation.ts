import { loadCanonicalAssets } from "./preset-assets.ts";
import { decodePresetPackageV3, parsePresetJson, presetDocumentValue, scan } from "./preset-package.ts";
import { asFailure, defaultAssets, isPresetResolutionRecord, presetFailure } from "./preset-resolver-common.ts";
import type { PresetFailure } from "./preset-resolver-types.ts";
import { consumeKnownError, validatePresetDocumentV1, validatePresetManifestV3 } from "./preset.contract.ts";
import { existsSync } from "node:fs";
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
    const decoded = decodePresetPackageV3(source);
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
  input: { readonly source?: string; readonly assetsRoot?: string; readonly rootDir?: string } = {},
) {
  const requested = input.source ?? "software/coding",
    builtin = ["software/coding", "builtin:software/coding"].includes(requested),
    source = builtin
      ? path.resolve(input.assetsRoot ?? defaultAssets)
      : path.resolve(input.rootDir ?? process.cwd(), requested);
  try {
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
    return {
      schema: "vertical-validate-report/v1" as const,
      source: builtin ? `builtin:${vertical.id}` : source,
      available: true,
      valid: issues.length === 0,
      vertical: {
        id: vertical.id,
        title: vertical.title,
        version: vertical.version,
      },
      issues,
    };
  } catch (error) {
    return {
      schema: "vertical-validate-report/v1" as const,
      source: builtin ? "builtin:software/coding" : source,
      available: builtin || existsSync(source),
      valid: false,
      issues: [asFailure(error)],
    };
  }
}

export function validatePackagePolicy(body: string): void {
  const value = parsePresetJson(body, "invalid_policy");
  if (
    !isPresetResolutionRecord(value) ||
    Object.keys(value).some((key) => !["schema", "requires"].includes(key)) ||
    value.schema !== "preset-policy/v1" ||
    !Array.isArray(value.requires) ||
    value.requires.some((item) => typeof item !== "string" || !item.trim()) ||
    new Set(value.requires).size !== value.requires.length
  )
    throw presetFailure("invalid_policy", "Preset package policy is invalid.");
}
