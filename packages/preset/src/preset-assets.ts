import {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validateVerticalDefinition,
} from "./preset-extension-model.ts";
import { compileVerticalContract, TemplateCatalogSchema } from "../../kernel/src/index.ts";
import type { CompiledVerticalContract, TemplateCatalog } from "../../kernel/src/index.ts";
import { requiredRegularFile, safeTemplatePath } from "./preset-materialization.ts";
import { parsePresetJson } from "./preset-package.ts";
import { isPresetResolutionRecord, presetFailure, resolverContentHash } from "./preset-resolver-common.ts";
import type { CanonicalAssets, CatalogSource, DecodedPresetPackageV3, Provider } from "./preset-resolver-types.ts";
import { Schema } from "effect";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

export function loadCanonicalAssets(source: string): CanonicalAssets {
  const resolvedSource = path.resolve(source),
    sourceIsFile = existsSync(resolvedSource) && lstatSync(resolvedSource).isFile(),
    root = sourceIsFile ? path.dirname(resolvedSource) : resolvedSource,
    verticalPath = sourceIsFile ? resolvedSource : path.join(root, "vertical.json"),
    verticalBody = requiredRegularFile(verticalPath, "missing_vertical"),
    catalogBody = requiredRegularFile(path.join(root, "template-catalog.json"), "missing_template_catalog"),
    providersBody = requiredRegularFile(path.join(root, "capabilities.json"), "missing_provider_catalog"),
    verticalRaw = parsePresetJson(verticalBody, "invalid_vertical"),
    catalog = decodeCatalog(catalogBody, root);
  let compiledVertical: CompiledVerticalContract;
  try {
    compiledVertical = compileVerticalContract(verticalRaw);
  } catch (error) {
    throw presetFailure("invalid_vertical", error instanceof Error ? error.message : "Vertical contract is invalid.");
  }
  const verticalValidation = validateVerticalDefinition(compiledVertical.definition);
  if (!verticalValidation.ok)
    throw presetFailure("invalid_vertical", verticalValidation.issues.map((item) => item.message).join("; "));
  return {
    compiledVertical,
    verticalSha256: resolverContentHash(verticalBody),
    catalog,
    providers: decodeProviders(parsePresetJson(providersBody, "invalid_provider_catalog")),
  };
}

export function assertCanonicalVertical(assets: CanonicalAssets, verticalId: string): void {
  if (assets.compiledVertical.definition.id !== verticalId)
    throw presetFailure(
      "missing_vertical",
      `Vertical ${verticalId} is unavailable. Available vertical ids: ${assets.compiledVertical.definition.id}.`,
    );
}

export function decodeCatalog(body: string, root: string): CatalogSource {
  const raw = parsePresetJson(body, "invalid_template_catalog"),
    shape = validateExtensionInputShape("template-catalog", raw);
  if (!shape.ok) throw presetFailure("invalid_template_catalog", shape.issues.map((item) => item.message).join("; "));
  let catalog: TemplateCatalog;
  try {
    catalog = Schema.decodeUnknownSync(TemplateCatalogSchema)(raw);
  } catch {
    throw presetFailure("invalid_template_catalog", "Template catalog is invalid.");
  }
  const source = { catalog, root, sha256: resolverContentHash(body) },
    validation = validateTemplateCatalog(catalog, {
      resolveBody: ({ locale }) =>
        requiredRegularFile(
          safeTemplatePath(root, locale.bodyPath, `${catalog.package.id}/${locale.locale}`),
          "missing_template",
        ),
    });
  if (!validation.ok)
    throw presetFailure("invalid_template_catalog", validation.issues.map((item) => item.message).join("; "));
  return source;
}

export function loadPackageCatalog(decoded: DecodedPresetPackageV3): CatalogSource {
  const target = path.join(decoded.root, "template-catalog.json");
  if (!existsSync(target))
    throw presetFailure(
      "missing_template_catalog",
      `User preset ${decoded.manifest.id} must provide template-catalog.json for its template selections.`,
    );
  return decodeCatalog(requiredRegularFile(target, "missing_template_catalog"), decoded.root);
}

export function packageCatalog(decoded: DecodedPresetPackageV3, fallback: CatalogSource): CatalogSource {
  return existsSync(path.join(decoded.root, "template-catalog.json")) ? loadPackageCatalog(decoded) : fallback;
}

export function decodeProviders(value: unknown): Provider[] {
  if (
    !isPresetResolutionRecord(value) ||
    value.schema !== "preset-capabilities/v1" ||
    !Array.isArray(value.providers) ||
    !value.providers.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        typeof (item as Provider).id === "string" &&
        typeof (item as Provider).kind === "string" &&
        typeof (item as Provider).version === "string" &&
        ((item as Provider).actionKind === undefined ||
          (typeof (item as Provider).actionKind === "string" &&
            Array.isArray((item as Provider).payloadFields) &&
            (item as Provider).payloadFields!.every((field) => typeof field === "string"))),
    )
  )
    throw presetFailure("invalid_provider_catalog", "Capability provider catalog is invalid.");
  return value.providers as Provider[];
}
