import type { PresetManifest, TemplateCatalog, TemplateSelection, VerticalDefinition } from "../schemas/registry.ts";

export interface ExtensionValidationIssue {
  readonly code:
    | "duplicate_capability"
    | "duplicate_document"
    | "duplicate_preset"
    | "duplicate_profile"
    | "duplicate_vertical_entity"
    | "incompatible_kernel"
    | "missing_default_profile"
    | "missing_fallback_locale"
    | "missing_parent_preset"
    | "missing_profile"
    | "missing_required_anchor"
    | "missing_template"
    | "custom_vertical_forbidden"
    | "duplicate_materialized_path"
    | "invalid_materialized_path"
    | "preset_required_template_conflict"
    | "preset_path_id_mismatch"
    | "reserved_materialized_path"
    | "preset_extends_cycle"
    | "status_mapping_forbidden"
    | "template_locale_structure_mismatch"
    | "unknown_extension_field"
    | "vertical_contract_entity_disabled"
    | "vertical_contract_entity_missing"
    | "vertical_lifecycle_scaffold_missing"
    | "vertical_scaffold_entity_missing"
    | "vertical_schema_scaffold_forbidden";
  readonly message: string;
  readonly path: string;
}

export interface ExtensionValidationResult {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
}

export interface KernelVersionContext {
  readonly kernelVersion: string;
}

export interface MaterializationRequest {
  readonly catalog: TemplateCatalog;
  readonly selections: ReadonlyArray<TemplateSelection>;
  readonly locale: "zh-CN" | "en-US";
}

export interface MaterializedTemplatePlan {
  readonly slot: string;
  readonly templateRef: string;
  readonly documentKind: string;
  readonly materializeAs: string;
  readonly locale: "zh-CN" | "en-US";
  readonly fallbackUsed: boolean;
  readonly requiredAnchors: ReadonlyArray<string>;
  readonly body: string;
}

export interface MaterializationResult {
  readonly ok: boolean;
  readonly documents: ReadonlyArray<MaterializedTemplatePlan>;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
}

export type ExtensionInputKind = "template-catalog" | "preset-manifest" | "vertical-definition";

export function validateExtensionInputShape(kind: ExtensionInputKind, input: unknown): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  scanForbiddenKeys(input, "$", issues);

  if (kind === "template-catalog") {
    validateTemplateCatalogShape(input, "$", issues);
  } else if (kind === "preset-manifest") {
    validatePresetManifestShape(input, "$", issues);
  } else {
    validateVerticalDefinitionShape(input, "$", issues);
  }

  return { ok: issues.length === 0, issues };
}

export function validateTemplateCatalog(catalog: TemplateCatalog): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  const seenDocuments = new Set<string>();

  for (const [documentIndex, document] of catalog.documents.entries()) {
    const documentPath = `documents[${documentIndex}]`;
    const documentKey = formatTemplateRef(document.id, document.version);
    if (seenDocuments.has(documentKey)) {
      issues.push(issue("duplicate_document", `Duplicate template document ${documentKey}.`, documentPath));
    }
    seenDocuments.add(documentKey);

    const locales = new Set(document.locales.map((variant) => variant.locale));
    if (!locales.has(document.fallbackLocale)) {
      issues.push(issue("missing_fallback_locale", `Fallback locale ${document.fallbackLocale} is not present for ${documentKey}.`, `${documentPath}.fallbackLocale`));
    }

    for (const [variantIndex, variant] of document.locales.entries()) {
      const variantPath = `${documentPath}.locales[${variantIndex}]`;
      if (!sameStringSet(variant.anchors, document.requiredAnchors)) {
        issues.push(issue("template_locale_structure_mismatch", `Locale ${variant.locale} anchors must match required anchors for ${documentKey}.`, `${variantPath}.anchors`));
      }
      for (const anchor of document.requiredAnchors) {
        if (!variant.body.includes(anchor)) {
          issues.push(issue("missing_required_anchor", `Locale ${variant.locale} body is missing anchor ${anchor}.`, `${variantPath}.body`));
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validatePresetManifests(
  presets: ReadonlyArray<PresetManifest>,
  kernel: KernelVersionContext
): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  const byId = new Map<string, PresetManifest>();

  for (const [presetIndex, preset] of presets.entries()) {
    if (byId.has(preset.id)) {
      issues.push(issue("duplicate_preset", `Duplicate preset ${preset.id}.`, `presets[${presetIndex}].id`));
    }
    byId.set(preset.id, preset);
    validateSinglePreset(preset, presetIndex, kernel, issues);
  }

  for (const [presetIndex, preset] of presets.entries()) {
    if (preset.extends && !byId.has(preset.extends)) {
      issues.push(issue("missing_parent_preset", `Preset ${preset.id} extends missing parent ${preset.extends}.`, `presets[${presetIndex}].extends`));
    }
  }

  for (const [presetIndex, preset] of presets.entries()) {
    const visited = new Set<string>();
    let current: PresetManifest | undefined = preset;
    while (current?.extends) {
      if (visited.has(current.id)) {
        issues.push(issue("preset_extends_cycle", `Preset extends cycle includes ${current.id}.`, `presets[${presetIndex}].extends`));
        break;
      }
      visited.add(current.id);
      current = byId.get(current.extends);
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateVerticalDefinition(vertical: VerticalDefinition): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  const entityById = new Map<string, VerticalDefinition["entityKinds"][number]>();
  const scaffoldEntityKinds = new Set<string>();

  for (const [entityIndex, entity] of vertical.entityKinds.entries()) {
    if (entityById.has(entity.id)) {
      issues.push(issue("duplicate_vertical_entity", `Duplicate vertical entity kind ${entity.id}.`, `entityKinds[${entityIndex}].id`));
    }
    entityById.set(entity.id, entity);
  }

  for (const [contractIndex, entityKind] of vertical.contractEntityKinds.entries()) {
    const entity = entityById.get(entityKind);
    if (!entity) {
      issues.push(issue("vertical_contract_entity_missing", `Contract entity ${entityKind} is not declared in entityKinds.`, `contractEntityKinds[${contractIndex}]`));
      continue;
    }
    if (!entity.contractEntity) {
      issues.push(issue("vertical_contract_entity_disabled", `Contract entity ${entityKind} must be marked contractEntity: true.`, `contractEntityKinds[${contractIndex}]`));
    }
  }

  for (const [scaffoldIndex, scaffold] of vertical.packageScaffolds.entries()) {
    scaffoldEntityKinds.add(scaffold.entityKind);
    const entity = entityById.get(scaffold.entityKind);
    if (!entity) {
      issues.push(issue("vertical_scaffold_entity_missing", `Package scaffold entity ${scaffold.entityKind} is not declared in entityKinds.`, `packageScaffolds[${scaffoldIndex}].entityKind`));
      continue;
    }
    if (entity.entityType === "schema") {
      issues.push(issue("vertical_schema_scaffold_forbidden", `Schema entity ${scaffold.entityKind} must not declare a package scaffold.`, `packageScaffolds[${scaffoldIndex}].entityKind`));
    }
  }

  for (const [entityIndex, entity] of vertical.entityKinds.entries()) {
    if (entity.entityType === "lifecycle" && !scaffoldEntityKinds.has(entity.id)) {
      issues.push(issue("vertical_lifecycle_scaffold_missing", `Lifecycle entity ${entity.id} must declare a package scaffold.`, `entityKinds[${entityIndex}].id`));
    }
  }

  const serialized = JSON.stringify(vertical);
  const lifecycleLeakTokens = [`status${"Mapping"}`, `lifecycle${"Status"}`, `provider${"Status"}`];
  if (lifecycleLeakTokens.some((token) => serialized.includes(token))) {
    issues.push(issue("status_mapping_forbidden", "Vertical definitions must not own lifecycle status mapping.", "$"));
  }

  return { ok: issues.length === 0, issues };
}

export function planTemplateMaterialization(request: MaterializationRequest): MaterializationResult {
  const catalogValidation = validateTemplateCatalog(request.catalog);
  const issues: ExtensionValidationIssue[] = [...catalogValidation.issues];
  const documents: MaterializedTemplatePlan[] = [];

  for (const [selectionIndex, selection] of request.selections.entries()) {
    const parsedRef = parseTemplateRef(selection.templateRef);
    const document = request.catalog.documents.find((candidate) => candidate.id === parsedRef.id && candidate.version === parsedRef.version);
    if (!document) {
      issues.push(issue("missing_template", `Template ${selection.templateRef} is not present in the catalog.`, `selections[${selectionIndex}].templateRef`));
      continue;
    }

    const preferredLocale = selection.localePolicy.prefer === "explicit" ? request.locale : request.locale;
    const preferred = document.locales.find((variant) => variant.locale === preferredLocale);
    const fallback = document.locales.find((variant) => variant.locale === selection.localePolicy.fallback)
      ?? document.locales.find((variant) => variant.locale === document.fallbackLocale);
    const selected = preferred ?? fallback;
    if (!selected) {
      issues.push(issue("missing_fallback_locale", `No usable locale for ${selection.templateRef}.`, `selections[${selectionIndex}].localePolicy`));
      continue;
    }

    documents.push({
      slot: selection.slot,
      templateRef: selection.templateRef,
      documentKind: document.documentKind,
      materializeAs: selection.materializeAs,
      locale: selected.locale,
      fallbackUsed: selected.locale !== request.locale,
      requiredAnchors: document.requiredAnchors,
      body: selected.body
    });
  }

  return { ok: issues.length === 0, documents, issues };
}

export function formatTemplateRef(id: string, version: string): string {
  return `template://${id}@${version}`;
}

function validateSinglePreset(
  preset: PresetManifest,
  presetIndex: number,
  kernel: KernelVersionContext,
  issues: ExtensionValidationIssue[]
): void {
  if (compareDottedVersion(kernel.kernelVersion, preset.kernelVersionRange.min) < 0) {
    issues.push(issue("incompatible_kernel", `Preset ${preset.id} requires kernel >= ${preset.kernelVersionRange.min}.`, `presets[${presetIndex}].kernelVersionRange.min`));
  }
  if (preset.kernelVersionRange.maxExclusive && compareDottedVersion(kernel.kernelVersion, preset.kernelVersionRange.maxExclusive) >= 0) {
    issues.push(issue("incompatible_kernel", `Preset ${preset.id} requires kernel < ${preset.kernelVersionRange.maxExclusive}.`, `presets[${presetIndex}].kernelVersionRange.maxExclusive`));
  }

  const profileIds = new Set<string>();
  for (const [profileIndex, profile] of preset.profiles.entries()) {
    if (profileIds.has(profile.id)) {
      issues.push(issue("duplicate_profile", `Duplicate preset profile ${profile.id}.`, `presets[${presetIndex}].profiles[${profileIndex}].id`));
    }
    profileIds.add(profile.id);
  }
  if (!profileIds.has(preset.defaultProfile)) {
    issues.push(issue("missing_default_profile", `Default profile ${preset.defaultProfile} is not declared.`, `presets[${presetIndex}].defaultProfile`));
  }

  const capabilityVersions = new Map<string, string>();
  for (const [capabilityIndex, capability] of preset.capabilityImports.entries()) {
    const existing = capabilityVersions.get(capability.id);
    if (existing && existing !== `${capability.kind}@${capability.version}`) {
      issues.push(issue("duplicate_capability", `Capability ${capability.id} has conflicting imports.`, `presets[${presetIndex}].capabilityImports[${capabilityIndex}]`));
    }
    capabilityVersions.set(capability.id, `${capability.kind}@${capability.version}`);
  }
}

function parseTemplateRef(ref: string): { readonly id: string; readonly version: string } {
  const match = /^template:\/\/(.+)@([^@]+)$/u.exec(ref);
  return match ? { id: match[1] ?? ref, version: match[2] ?? "" } : { id: ref, version: "" };
}

function sameStringSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function compareDottedVersion(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) return leftValue > rightValue ? 1 : -1;
  }
  return 0;
}

function issue(code: ExtensionValidationIssue["code"], message: string, path: string): ExtensionValidationIssue {
  return { code, message, path };
}

function validateTemplateCatalogShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["schema", "package", "documents"], issues);
  if (!isRecord(input)) return;
  validateObjectKeys(input.package, `${path}.package`, ["id", "title", "version", "owner", "locales"], issues);
  if (Array.isArray(input.documents)) {
    for (const [index, document] of input.documents.entries()) {
      const documentPath = `${path}.documents[${index}]`;
      validateObjectKeys(document, documentPath, ["id", "version", "documentKind", "slot", "materializeAs", "frontmatterSchema", "requiredAnchors", "fallbackLocale", "locales"], issues);
      if (isRecord(document) && Array.isArray(document.locales)) {
        for (const [localeIndex, locale] of document.locales.entries()) {
          validateObjectKeys(locale, `${documentPath}.locales[${localeIndex}]`, ["locale", "anchors", "body"], issues);
        }
      }
    }
  }
}

function validatePresetManifestShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["schema", "id", "title", "vertical", "version", "kind", "extends", "kernelVersionRange", "capabilityImports", "entrypoints", "profiles", "defaultProfile"], issues);
  if (!isRecord(input)) return;
  validateObjectKeys(input.kernelVersionRange, `${path}.kernelVersionRange`, ["min", "maxExclusive"], issues);
  validateCapabilityImportsShape(input.capabilityImports, `${path}.capabilityImports`, issues, ["id", "kind", "version", "required"]);
  validatePresetEntrypointsShape(input.entrypoints, `${path}.entrypoints`, issues);
  if (Array.isArray(input.profiles)) {
    for (const [index, profile] of input.profiles.entries()) {
      const profilePath = `${path}.profiles[${index}]`;
      validateObjectKeys(profile, profilePath, ["id", "title", "checkerProfile", "templateSelections", "capabilityImports"], issues);
      if (isRecord(profile)) {
        validateTemplateSelectionsShape(profile.templateSelections, `${profilePath}.templateSelections`, issues);
        validateCapabilityImportsShape(profile.capabilityImports, `${profilePath}.capabilityImports`, issues, ["id", "version"]);
      }
    }
  }
}

function validatePresetEntrypointsShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (input === undefined) return;
  if (!isRecord(input)) return;
  for (const [entrypointName, entrypoint] of Object.entries(input)) {
    const entrypointPath = `${path}.${entrypointName}`;
    if (!isRecord(entrypoint)) continue;
    if (entrypoint.type === "script") {
      validateObjectKeys(entrypoint, entrypointPath, ["type", "command", "reads", "writes", "inputs"], issues);
      continue;
    }
    if (entrypoint.type === "template") {
      validateObjectKeys(entrypoint, entrypointPath, ["type", "writes", "templates"], issues);
      continue;
    }
    validateObjectKeys(entrypoint, entrypointPath, ["type"], issues);
  }
}

function validateVerticalDefinitionShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["schema", "id", "title", "version", "entityKinds", "contractEntityKinds", "packageScaffolds", "templateSelections", "checkerProfile", "projectionSchemas"], issues);
  if (!isRecord(input)) return;
  if (Array.isArray(input.entityKinds)) {
    for (const [index, entity] of input.entityKinds.entries()) {
      validateObjectKeys(entity, `${path}.entityKinds[${index}]`, ["id", "entityType", "packageKind", "schemaRef", "contractEntity"], issues);
    }
  }
  if (Array.isArray(input.packageScaffolds)) {
    for (const [index, scaffold] of input.packageScaffolds.entries()) {
      const scaffoldPath = `${path}.packageScaffolds[${index}]`;
      validateObjectKeys(scaffold, scaffoldPath, ["entityKind", "templateSelections"], issues);
      if (isRecord(scaffold)) {
        validateTemplateSelectionsShape(scaffold.templateSelections, `${scaffoldPath}.templateSelections`, issues);
      }
    }
  }
  validateTemplateSelectionsShape(input.templateSelections, `${path}.templateSelections`, issues);
  if (Array.isArray(input.projectionSchemas)) {
    for (const [index, projection] of input.projectionSchemas.entries()) {
      validateObjectKeys(projection, `${path}.projectionSchemas[${index}]`, ["id", "schemaRef"], issues);
    }
  }
}

function validateTemplateSelectionsShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (!Array.isArray(input)) return;
  for (const [index, selection] of input.entries()) {
    const selectionPath = `${path}[${index}]`;
    validateObjectKeys(selection, selectionPath, ["slot", "templateRef", "materializeAs", "localePolicy", "requiredWhen"], issues);
    if (isRecord(selection)) {
      validateObjectKeys(selection.localePolicy, `${selectionPath}.localePolicy`, ["prefer", "fallback"], issues);
    }
  }
}

function validateCapabilityImportsShape(input: unknown, path: string, issues: ExtensionValidationIssue[], keys: ReadonlyArray<string>): void {
  if (!Array.isArray(input)) return;
  for (const [index, capability] of input.entries()) {
    validateObjectKeys(capability, `${path}[${index}]`, keys, issues);
  }
}

function validateObjectKeys(input: unknown, path: string, allowedKeys: ReadonlyArray<string>, issues: ExtensionValidationIssue[]): void {
  if (!isRecord(input)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push(issue("unknown_extension_field", `Unknown extension field ${key}.`, `${path}.${key}`));
    }
  }
}

function scanForbiddenKeys(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) scanForbiddenKeys(value, `${path}[${index}]`, issues);
    return;
  }
  if (!isRecord(input)) return;

  const forbidden = new Set([
    `status${"Mapping"}`,
    `lifecycle${"Status"}`,
    `provider${"Status"}`,
    "budget",
    "legacy",
    "compat",
    "compatibility",
    "scriptsRefactor"
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (forbidden.has(key)) {
      issues.push(issue("unknown_extension_field", `Forbidden extension field ${key}.`, `${path}.${key}`));
    }
    scanForbiddenKeys(value, `${path}.${key}`, issues);
  }
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
