import type { TemplateCatalog, TemplateSelection, VerticalDefinition } from "../schemas/registry.ts";
import { createEntityKindRegistry } from "./entity-kind-registry.ts";

export interface ExtensionValidationIssue {
  readonly code:
    | "duplicate_document"
    | "duplicate_vertical_entity"
    | "missing_fallback_locale"
    | "missing_required_anchor"
    | "missing_template"
    | "custom_vertical_forbidden"
    | "duplicate_materialized_path"
    | "invalid_materialized_path"
    | "reserved_materialized_path"
    | "status_mapping_forbidden"
    | "template_locale_structure_mismatch"
    | "template_body_unavailable"
    | "unknown_extension_field"
    | "vertical_contract_entity_disabled"
    | "vertical_contract_entity_missing"
    | "vertical_lifecycle_scaffold_missing"
    | "vertical_lifecycle_repository_scaffold_missing"
    | "vertical_scaffold_entity_missing"
    | "vertical_schema_repository_scaffold_forbidden"
    | "vertical_schema_scaffold_forbidden";
  readonly message: string;
  readonly path: string;
}

export interface ExtensionValidationResult {
  readonly ok: boolean;
  readonly issues: ReadonlyArray<ExtensionValidationIssue>;
}

export interface MaterializationRequest {
  readonly catalog: TemplateCatalog;
  readonly selections: ReadonlyArray<TemplateSelection>;
  readonly locale: "zh-CN" | "en-US";
  readonly resolveBody?: TemplateBodyResolver;
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

export type ExtensionInputKind = "template-catalog" | "vertical-definition";

export type TemplateBodyResolver = (input: {
  readonly document: TemplateCatalog["documents"][number];
  readonly locale: TemplateCatalog["documents"][number]["locales"][number];
  readonly documentIndex: number;
  readonly localeIndex: number;
}) => string | undefined;

export interface TemplateCatalogValidationOptions {
  readonly resolveBody?: TemplateBodyResolver;
}

export function validateExtensionInputShape(kind: ExtensionInputKind, input: unknown): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  scanForbiddenKeys(input, "$", issues);

  if (kind === "template-catalog") validateTemplateCatalogShape(input, "$", issues); else validateVerticalDefinitionShape(input, "$", issues);

  return { ok: issues.length === 0, issues };
}

export function validateTemplateCatalog(catalog: TemplateCatalog, options: TemplateCatalogValidationOptions = {}): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  const seenDocuments = new Set<string>();

  for (const [documentIndex, document] of catalog.documents.entries()) {
    const documentPath = `documents[${documentIndex}]`;
    const documentKey = formatTemplateRef(document.id, document.version);
    if (seenDocuments.has(documentKey)) {
      issues.push(extensionIssue("duplicate_document", `Duplicate template document ${documentKey}.`, documentPath));
    }
    seenDocuments.add(documentKey);

    const locales = new Set(document.locales.map((variant) => variant.locale));
    if (!locales.has(document.fallbackLocale)) {
      issues.push(extensionIssue("missing_fallback_locale", `Fallback locale ${document.fallbackLocale} is not present for ${documentKey}.`, `${documentPath}.fallbackLocale`));
    }

    for (const [variantIndex, variant] of document.locales.entries()) {
      const variantPath = `${documentPath}.locales[${variantIndex}]`;
      if (!sameStringSet(variant.anchors, document.requiredAnchors)) {
        issues.push(extensionIssue("template_locale_structure_mismatch", `Locale ${variant.locale} anchors must match required anchors for ${documentKey}.`, `${variantPath}.anchors`));
      }
      const body = options.resolveBody?.({ document, locale: variant, documentIndex, localeIndex: variantIndex });
      if (body !== undefined) {
        for (const anchor of document.requiredAnchors) {
          if (!body.includes(anchor)) {
            issues.push(extensionIssue("missing_required_anchor", `Locale ${variant.locale} body is missing anchor ${anchor}.`, `${variantPath}.bodyPath`));
          }
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

export function validateVerticalDefinition(vertical: VerticalDefinition): ExtensionValidationResult {
  const issues: ExtensionValidationIssue[] = [];
  const registry = createEntityKindRegistry(vertical);
  const entityById = registry.byId;
  const scaffoldEntityKinds = new Set<string>();
  const repositoryRootEntityKinds = new Set<string>();

  for (const [entityIndex, entity] of vertical.entityKinds.entries()) {
    if (vertical.entityKinds.findIndex((candidate) => candidate.id === entity.id) !== entityIndex) {
      issues.push(extensionIssue("duplicate_vertical_entity", `Duplicate vertical entity kind ${entity.id}.`, `entityKinds[${entityIndex}].id`));
    }
  }

  for (const [contractIndex, entityKind] of vertical.contractEntityKinds.entries()) {
    const entity = entityById.get(entityKind);
    if (!entity) {
      issues.push(extensionIssue("vertical_contract_entity_missing", `Contract entity ${entityKind} is not declared in entityKinds.`, `contractEntityKinds[${contractIndex}]`));
      continue;
    }
    if (!entity.contractEntity) {
      issues.push(extensionIssue("vertical_contract_entity_disabled", `Contract entity ${entityKind} must be marked contractEntity: true.`, `contractEntityKinds[${contractIndex}]`));
    }
  }

  for (const [scaffoldIndex, scaffold] of vertical.packageScaffolds.entries()) {
    scaffoldEntityKinds.add(scaffold.entityKind);
    const entity = entityById.get(scaffold.entityKind);
    if (!entity) {
      issues.push(extensionIssue("vertical_scaffold_entity_missing", `Package scaffold entity ${scaffold.entityKind} is not declared in entityKinds.`, `packageScaffolds[${scaffoldIndex}].entityKind`));
      continue;
    }
    if (entity.entityType === "schema") {
      issues.push(extensionIssue("vertical_schema_scaffold_forbidden", `Schema entity ${scaffold.entityKind} must not declare a package scaffold.`, `packageScaffolds[${scaffoldIndex}].entityKind`));
    }
  }

  for (const [rootIndex, root] of vertical.repositoryScaffold.entityRoots.entries()) {
    repositoryRootEntityKinds.add(root.entityKind);
    const entity = entityById.get(root.entityKind);
    if (!entity) {
      issues.push(extensionIssue("vertical_scaffold_entity_missing", `Repository scaffold entity ${root.entityKind} is not declared in entityKinds.`, `repositoryScaffold.entityRoots[${rootIndex}].entityKind`));
      continue;
    }
    if (entity.entityType === "schema") {
      issues.push(extensionIssue("vertical_schema_repository_scaffold_forbidden", `Schema entity ${root.entityKind} must not declare a repository root scaffold.`, `repositoryScaffold.entityRoots[${rootIndex}].entityKind`));
    }
  }

  for (const [entityIndex, entity] of vertical.entityKinds.entries()) {
    if (entity.entityType === "lifecycle" && !scaffoldEntityKinds.has(entity.id)) {
      issues.push(extensionIssue("vertical_lifecycle_scaffold_missing", `Lifecycle entity ${entity.id} must declare a package scaffold.`, `entityKinds[${entityIndex}].id`));
    }
    if (entity.entityType === "lifecycle" && !repositoryRootEntityKinds.has(entity.id)) {
      issues.push(extensionIssue("vertical_lifecycle_repository_scaffold_missing", `Lifecycle entity ${entity.id} must declare a repository scaffold root.`, `entityKinds[${entityIndex}].id`));
    }
  }

  const serialized = JSON.stringify(vertical);
  const lifecycleLeakTokens = [`status${"Mapping"}`, `lifecycle${"Status"}`, `provider${"Status"}`];
  if (lifecycleLeakTokens.some((token) => serialized.includes(token))) {
    issues.push(extensionIssue("status_mapping_forbidden", "Vertical definitions must not own lifecycle status mapping.", "$"));
  }

  return { ok: issues.length === 0, issues };
}

export function planTemplateMaterialization(request: MaterializationRequest): MaterializationResult {
  const catalogValidation = validateTemplateCatalog(request.catalog, { resolveBody: request.resolveBody });
  const issues: ExtensionValidationIssue[] = [...catalogValidation.issues];
  const documents: MaterializedTemplatePlan[] = [];

  for (const [selectionIndex, selection] of request.selections.entries()) {
    const parsedRef = parseTemplateRef(selection.templateRef);
    const document = request.catalog.documents.find((candidate) => candidate.id === parsedRef.id && candidate.version === parsedRef.version);
    if (!document) {
      issues.push(extensionIssue("missing_template", `Template ${selection.templateRef} is not present in the catalog.`, `selections[${selectionIndex}].templateRef`));
      continue;
    }

    const preferredLocale = selection.localePolicy.prefer === "explicit" ? request.locale : request.locale;
    const preferred = document.locales.find((variant) => variant.locale === preferredLocale);
    const fallback = document.locales.find((variant) => variant.locale === selection.localePolicy.fallback)
      ?? document.locales.find((variant) => variant.locale === document.fallbackLocale);
    const selected = preferred ?? fallback;
    if (!selected) {
      issues.push(extensionIssue("missing_fallback_locale", `No usable locale for ${selection.templateRef}.`, `selections[${selectionIndex}].localePolicy`));
      continue;
    }
    const documentIndex = request.catalog.documents.indexOf(document);
    const localeIndex = document.locales.indexOf(selected);
    const body = request.resolveBody?.({ document, locale: selected, documentIndex, localeIndex });
    if (body === undefined) {
      issues.push(extensionIssue("template_body_unavailable", `Template body is unavailable for ${selection.templateRef} ${selected.locale}.`, `documents[${documentIndex}].locales[${localeIndex}].bodyPath`));
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
      body
    });
  }

  return { ok: issues.length === 0, documents, issues };
}

export function formatTemplateRef(id: string, version: string): string {
  return `template://${id}@${version}`;
}

function parseTemplateRef(ref: string): { readonly id: string; readonly version: string } {
  const match = /^template:\/\/(.+)@([^@]+)$/u.exec(ref);
  return match ? { id: match[1] ?? ref, version: match[2] ?? "" } : { id: ref, version: "" };
}

function sameStringSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function extensionIssue(code: ExtensionValidationIssue["code"], message: string, path: string): ExtensionValidationIssue {
  return { code, message, path };
}

function validateTemplateCatalogShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["schema", "package", "documents"], issues);
  if (!isExtensionRecord(input)) return;
  validateObjectKeys(input.package, `${path}.package`, ["id", "title", "version", "owner", "locales"], issues);
  if (Array.isArray(input.documents)) {
    for (const [index, document] of input.documents.entries()) {
      const documentPath = `${path}.documents[${index}]`;
      validateObjectKeys(document, documentPath, ["id", "version", "documentKind", "slot", "materializeAs", "frontmatterSchema", "requiredAnchors", "fallbackLocale", "locales"], issues);
      if (isExtensionRecord(document) && Array.isArray(document.locales)) {
        for (const [localeIndex, locale] of document.locales.entries()) {
          validateObjectKeys(locale, `${documentPath}.locales[${localeIndex}]`, ["locale", "anchors", "bodyPath"], issues);
        }
      }
    }
  }
}

function validateVerticalDefinitionShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["schema", "id", "title", "version", "entityFieldExtensions", "entityKinds", "contractEntityKinds", "packageScaffolds", "repositoryScaffold", "scripts", "templateSelections", "checkerProfile", "projectionSchemas"], issues);
  if (!isExtensionRecord(input)) return;
  validateEntityFieldExtensionsShape(input.entityFieldExtensions, `${path}.entityFieldExtensions`, issues);
  if (Array.isArray(input.entityKinds)) {
    for (const [index, entity] of input.entityKinds.entries()) {
      validateObjectKeys(entity, `${path}.entityKinds[${index}]`, ["id", "entityType", "packageKind", "schemaRef", "contractEntity"], issues);
    }
  }
  if (Array.isArray(input.packageScaffolds)) {
    for (const [index, scaffold] of input.packageScaffolds.entries()) {
      const scaffoldPath = `${path}.packageScaffolds[${index}]`;
      validateObjectKeys(scaffold, scaffoldPath, ["entityKind", "templateSelections"], issues);
      if (isExtensionRecord(scaffold)) {
        validateTemplateSelectionsShape(scaffold.templateSelections, `${scaffoldPath}.templateSelections`, issues);
      }
    }
  }
  validateRepositoryScaffoldShape(input.repositoryScaffold, `${path}.repositoryScaffold`, issues);
  validateVerticalScriptsShape(input.scripts, `${path}.scripts`, issues);
  validateTemplateSelectionsShape(input.templateSelections, `${path}.templateSelections`, issues);
  if (Array.isArray(input.projectionSchemas)) {
    for (const [index, projection] of input.projectionSchemas.entries()) {
      validateObjectKeys(projection, `${path}.projectionSchemas[${index}]`, ["id", "schemaRef"], issues);
    }
  }
}

function validateEntityFieldExtensionsShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (!Array.isArray(input)) return;
  for (const [index, extension] of input.entries()) {
    const extensionPath = `${path}[${index}]`;
    validateObjectKeys(extension, extensionPath, ["extends", "field", "kind", "values", "default", "mutability", "projection", "reason"], issues);
    if (isExtensionRecord(extension)) {
      validateObjectKeys(extension.projection, `${extensionPath}.projection`, ["column", "queryable"], issues);
    }
  }
}

function validateRepositoryScaffoldShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  validateObjectKeys(input, path, ["entityRoots", "dirs", "seededDocs", "agentsEntry"], issues);
  if (!isExtensionRecord(input)) return;
  if (Array.isArray(input.entityRoots)) {
    for (const [index, root] of input.entityRoots.entries()) {
      validateObjectKeys(root, `${path}.entityRoots[${index}]`, ["entityKind", "path", "create"], issues);
    }
  }
  if (Array.isArray(input.dirs)) {
    for (const [index, directory] of input.dirs.entries()) {
      validateObjectKeys(directory, `${path}.dirs[${index}]`, ["path", "create"], issues);
    }
  }
  if (Array.isArray(input.seededDocs)) {
    for (const [index, document] of input.seededDocs.entries()) {
      const documentPath = `${path}.seededDocs[${index}]`;
      validateObjectKeys(document, documentPath, ["slot", "templateRef", "materializeAs", "localePolicy", "requiredWhen", "overwrite"], issues);
      if (isExtensionRecord(document)) {
        validateObjectKeys(document.localePolicy, `${documentPath}.localePolicy`, ["prefer", "fallback"], issues);
      }
    }
  }
  if (input.agentsEntry !== undefined) {
    const agentsEntryPath = `${path}.agentsEntry`;
    validateObjectKeys(input.agentsEntry, agentsEntryPath, ["materializeAs", "localePolicy", "baseRef", "overlayRef", "repoSpecificsAnchor", "overwrite"], issues);
    if (isExtensionRecord(input.agentsEntry)) {
      validateObjectKeys(input.agentsEntry.localePolicy, `${agentsEntryPath}.localePolicy`, ["prefer", "fallback"], issues);
    }
  }
}

function validateVerticalScriptsShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (!Array.isArray(input)) return;
  for (const [index, script] of input.entries()) {
    const scriptPath = `${path}[${index}]`;
    validateObjectKeys(script, scriptPath, ["id", "type", "command", "reads", "writes", "inputs", "metadata"], issues);
    if (isExtensionRecord(script)) {
      validateObjectKeys(script.metadata, `${scriptPath}.metadata`, ["description", "purpose", "kind", "contractVersion", "produces"], issues);
    }
  }
}

function validateTemplateSelectionsShape(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (!Array.isArray(input)) return;
  for (const [index, selection] of input.entries()) {
    const selectionPath = `${path}[${index}]`;
    validateObjectKeys(selection, selectionPath, ["slot", "templateRef", "materializeAs", "localePolicy", "requiredWhen"], issues);
    if (isExtensionRecord(selection)) {
      validateObjectKeys(selection.localePolicy, `${selectionPath}.localePolicy`, ["prefer", "fallback"], issues);
    }
  }
}

function validateObjectKeys(input: unknown, path: string, allowedKeys: ReadonlyArray<string>, issues: ExtensionValidationIssue[]): void {
  if (!isExtensionRecord(input)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      issues.push(extensionIssue("unknown_extension_field", `Unknown extension field ${key}.`, `${path}.${key}`));
    }
  }
}

function scanForbiddenKeys(input: unknown, path: string, issues: ExtensionValidationIssue[]): void {
  if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) scanForbiddenKeys(value, `${path}[${index}]`, issues);
    return;
  }
  if (!isExtensionRecord(input)) return;

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
      issues.push(extensionIssue("unknown_extension_field", `Forbidden extension field ${key}.`, `${path}.${key}`));
    }
    scanForbiddenKeys(value, `${path}.${key}`, issues);
  }
}

function isExtensionRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
