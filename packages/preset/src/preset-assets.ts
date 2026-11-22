import {
  validateExtensionInputShape,
  validateTemplateCatalog,
  validateTemplateCatalogBodies,
  validateVerticalDefinition,
} from "./preset-extension-model.ts";
import { compileVerticalContract, INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import {
  decodeVerticalDefinition,
  TemplateCatalogSchema,
  type TemplateCatalog,
} from "@harness-anything/kernel/schemas";
import type { CompiledVerticalContract } from "@harness-anything/kernel";
import { requiredRegularFile, safeTemplatePath } from "./preset-materialization.ts";
import { parsePresetJson } from "./preset-json.ts";
import {
  asFailure,
  builtinVerticalAssetRootSet,
  builtinVerticalRoots,
  isPresetResolutionRecord,
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type { CanonicalAssets, CatalogSource, DecodedPresetPackageV3, Provider } from "./preset-resolver-types.ts";
import * as Schema from "effect/Schema";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

const canonicalAssetsCache = new Map<string, CanonicalAssets>();
const protectedBuiltinVerticalId = INITIAL_SETTINGS_V1.defaultVertical;

export interface VerticalCatalogEntryV1 {
  readonly id: string;
  readonly title: string;
  readonly version: string | null;
  readonly layer: "builtin" | "repository";
  readonly source: string;
  readonly default: boolean;
  readonly valid: boolean;
  readonly shadows?: "builtin";
  readonly issues: readonly { readonly code: string; readonly message: string }[];
}

function scanVerticalRoots(repoRoot?: string): {
  readonly roots: Map<string, string>;
  readonly localRoots: Map<string, string>;
  readonly shadowedBuiltins: Set<string>;
} {
  const roots = new Map(builtinVerticalRoots),
    localRoots = new Map<string, string>(),
    shadowedBuiltins = new Set<string>(),
    directory = repoRoot && path.join(repoRoot, "verticals");
  if (directory && existsSync(directory)) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const root = path.join(directory, entry.name),
        declaration = path.join(root, "vertical.json");
      if (!existsSync(declaration)) continue;
      const raw = parsePresetJson(requiredRegularFile(declaration, "missing_vertical"), "invalid_vertical");
      if (!isPresetResolutionRecord(raw) || typeof raw.id !== "string" || !raw.id.trim())
        throw presetFailure("invalid_vertical", `${declaration} must declare a vertical id.`);
      const id = raw.id.trim();
      if (id === protectedBuiltinVerticalId)
        throw presetFailure("duplicate_vertical", `Vertical ${id} is declared by both ${roots.get(id)} and ${root}.`);
      if (localRoots.has(id))
        throw presetFailure(
          "duplicate_vertical",
          `Vertical ${id} is declared by both ${localRoots.get(id)} and ${root}.`,
        );
      if (builtinVerticalRoots.has(id)) shadowedBuiltins.add(id);
      localRoots.set(id, root);
      roots.set(id, root);
    }
  }
  return { roots, localRoots, shadowedBuiltins };
}

export function findLocalVerticalRoot(verticalId: string, repoRoot?: string): string | null {
  if (!repoRoot || verticalId === protectedBuiltinVerticalId) return null;
  return scanVerticalRoots(repoRoot).localRoots.get(verticalId) ?? null;
}

/** Repository declarations are external input; IDs never become filesystem paths. */
export function resolveVerticalAssetsRoot(verticalId: string, repoRoot?: string): string {
  const { roots } = scanVerticalRoots(repoRoot);
  const root = roots.get(verticalId);
  if (!root)
    throw presetFailure(
      "missing_vertical",
      `Vertical ${verticalId} is unavailable. Available vertical ids: ${[...roots.keys()].join(", ")}.`,
    );
  return root;
}

export function listVerticalCatalog(
  input: { readonly rootDir?: string; readonly defaultVertical?: string } = {},
): VerticalCatalogEntryV1[] {
  const { roots, shadowedBuiltins } = scanVerticalRoots(input.rootDir),
    defaultVertical = input.defaultVertical ?? null;
  return [...roots.entries()]
    .map(([id, root]): VerticalCatalogEntryV1 => {
      const resolvedRoot = path.resolve(root),
        isBuiltin = builtinVerticalAssetRootSet.has(resolvedRoot),
        source = isBuiltin ? `builtin:${id}` : root,
        layer = isBuiltin ? ("builtin" as const) : ("repository" as const),
        shadows = !isBuiltin && shadowedBuiltins.has(id) ? ("builtin" as const) : undefined;
      try {
        const assets = loadCanonicalAssets(resolvedRoot),
          vertical = assets.compiledVertical.definition;
        return {
          id: vertical.id,
          title: vertical.title,
          version: vertical.version,
          layer,
          source,
          default: vertical.id === defaultVertical,
          valid: true,
          ...(shadows ? { shadows } : {}),
          issues: [],
        };
      } catch (error) {
        const issue = asFailure(error);
        return {
          id,
          title: id,
          version: null,
          layer,
          source,
          default: id === defaultVertical,
          valid: false,
          ...(shadows ? { shadows } : {}),
          issues: [{ code: issue.code, message: issue.message }],
        };
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function loadCanonicalAssets(source: string): CanonicalAssets {
  const resolvedSource = path.resolve(source),
    cached = canonicalAssetsCache.get(resolvedSource);
  if (cached) return cached;
  const assets = loadCanonicalAssetsUncached(resolvedSource);
  if (!builtinVerticalAssetRootSet.has(resolvedSource)) return assets;
  canonicalAssetsCache.set(resolvedSource, assets);
  return assets;
}

function loadCanonicalAssetsUncached(resolvedSource: string): CanonicalAssets {
  const sourceIsFile = existsSync(resolvedSource) && lstatSync(resolvedSource).isFile(),
    root = sourceIsFile ? path.dirname(resolvedSource) : resolvedSource,
    verticalPath = sourceIsFile ? resolvedSource : path.join(root, "vertical.json"),
    verticalBody = requiredRegularFile(verticalPath, "missing_vertical"),
    catalogBody = requiredRegularFile(path.join(root, "template-catalog.json"), "missing_template_catalog"),
    providersBody = requiredRegularFile(path.join(root, "capabilities.json"), "missing_provider_catalog"),
    verticalRaw = parsePresetJson(verticalBody, "invalid_vertical"),
    catalog = decodeCatalog(catalogBody, root);
  let compiledVertical: CompiledVerticalContract;
  try {
    compiledVertical = compileVerticalContract(decodeVerticalDefinition(verticalRaw));
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

export function decodeCatalog(
  body: string,
  root: string,
  resolveBody?: Parameters<typeof validateTemplateCatalogBodies>[1],
): CatalogSource {
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
    validation = validateTemplateCatalog(catalog);
  if (!validation.ok)
    throw presetFailure("invalid_template_catalog", validation.issues.map((item) => item.message).join("; "));
  for (const document of catalog.documents)
    for (const locale of document.locales)
      safeTemplatePath(root, locale.bodyPath, `${catalog.package.id}/${locale.locale}`);
  if (resolveBody) {
    const bodyValidation = validateTemplateCatalogBodies(catalog, resolveBody);
    if (!bodyValidation.ok)
      throw presetFailure("invalid_template_catalog", bodyValidation.issues.map((item) => item.message).join("; "));
  }
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
