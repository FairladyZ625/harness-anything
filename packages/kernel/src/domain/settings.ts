import { stableStringify } from "../integrity/stable-hash.ts";
import { isMap, isSeq, parseDocument } from "yaml";
import type { EntityDocumentJsonSchema, EntityJsonSchemaNode } from "./entity-json-schema.ts";
import {
  gateAppliesTo,
  gateWitnessMappingIssues,
  mappedWitnessAdapterIds,
  type GateWitnessMappingV1,
} from "./completion-contract.ts";
import { validateEntityJsonSchema } from "./entity-json-schema.ts";
import {
  DEFAULT_CI_WORKFLOWS,
  DEFAULT_RESTORE_DRILL_RETENTION,
  DEFAULT_WAL_FLUSH_SETTINGS,
  AGENDA_PIN_LIMIT_SETTING,
  SETTINGS_FIELD_DECLARATIONS,
  SETTINGS_FIELD_GROUPS,
  SETTINGS_FIELD_PRESENTATION,
  defineSettingsField,
  reviewIndependenceLevels,
  rolePreferenceFields,
  settingValuePattern,
  settingsActionInputFieldsFromDeclarations,
  settingsCliInputFieldsFromDeclarations,
  settingsFieldPresentationFromDeclarations,
  settingsLocales,
  settingsFieldLabel,
  type ReviewIndependence,
  type DecisionReviewRequirement,
  type DeclaredSettingsFields,
  type SettingsCliInputField,
  type SettingsFieldDeclaration,
  type SettingsLocale,
  type WalFlushSettingsV1,
} from "./settings-field-declarations.ts";

export {
  DEFAULT_CI_WORKFLOWS,
  DEFAULT_RESTORE_DRILL_RETENTION,
  DEFAULT_WAL_FLUSH_SETTINGS,
  AGENDA_PIN_LIMIT_SETTING,
  SETTINGS_FIELD_DECLARATIONS,
  SETTINGS_FIELD_GROUPS,
  SETTINGS_FIELD_PRESENTATION,
  defineSettingsField,
  reviewIndependenceLevels,
  rolePreferenceFields,
  settingValuePattern,
  settingsFieldPresentationFromDeclarations,
  settingsLocales,
  settingsFieldLabel,
  type ReviewIndependence,
  type DecisionReviewRequirement,
  type DeclaredSettingsFields,
  type SettingsCliInputField,
  type SettingsFieldDeclaration,
  type SettingsLocale,
  type WalFlushSettingsV1,
};

export const SETTINGS_ID = "repository";
export const SETTINGS_LOCAL_PATH = ".harness/settings.local.json";
export const SETTINGS_FIELD_OWNERSHIP = Object.freeze(
  Object.fromEntries(SETTINGS_FIELD_DECLARATIONS.map(({ path, ownership }) => [path[0], ownership])),
);

export type RepositorySettingsV1 = Readonly<
  {
    readonly schema: "settings/v1";
    readonly settingsId: typeof SETTINGS_ID;
  } & DeclaredSettingsFields<"repository">
>;

export type LocalSettingsV1 = Readonly<
  {
    readonly schema: "settings-local/v1";
  } & DeclaredSettingsFields<"local">
>;

export type SettingsV1 = Readonly<
  {
    readonly schema: "settings/v1";
    readonly settingsId: typeof SETTINGS_ID;
  } & DeclaredSettingsFields<"repository"> &
    DeclaredSettingsFields<"local">
>;

export const SETTINGS_LOCAL_V1_SCHEMA: EntityDocumentJsonSchema<LocalSettingsV1> = settingsSchema(
  "SettingsLocal/v1",
  "settings-local/v1",
  SETTINGS_FIELD_DECLARATIONS.filter(({ ownership }) => ownership === "local"),
  false,
) as EntityDocumentJsonSchema<LocalSettingsV1>;

export const INITIAL_SETTINGS_V1 = Object.freeze(
  settingsValueFromDeclarations(SETTINGS_FIELD_DECLARATIONS),
) as unknown as SettingsV1;

export const SETTINGS_V1_SCHEMA = settingsSchema(
  "Settings/v1",
  "settings/v1",
  SETTINGS_FIELD_DECLARATIONS,
  true,
) as EntityDocumentJsonSchema<SettingsV1>;

/** Event/projection shape containing repository-owned settings only. */
export const SETTINGS_REPOSITORY_V1_SCHEMA = settingsSchema(
  "SettingsRepository/v1",
  "settings/v1",
  SETTINGS_FIELD_DECLARATIONS.filter(({ ownership }) => ownership === "repository"),
  true,
) as EntityDocumentJsonSchema<RepositorySettingsV1>;

export function validateSettingsV1(value: unknown): readonly string[] {
  return withGateMappingIssues(validateEntityJsonSchema(SETTINGS_V1_SCHEMA, value, "settings"), value);
}

export function repositorySettings(settings: SettingsV1 | RepositorySettingsV1): RepositorySettingsV1 {
  return settingsValueFromDeclarations(
    SETTINGS_FIELD_DECLARATIONS.filter(({ ownership }) => ownership === "repository"),
    settings as unknown as Readonly<Record<string, unknown>>,
  ) as unknown as RepositorySettingsV1;
}

export function validateLocalSettingsV1(value: unknown): readonly string[] {
  return validateEntityJsonSchema(SETTINGS_LOCAL_V1_SCHEMA, value, "local settings");
}

export function serializeLocalSettings(locale: SettingsLocale): string {
  const value: LocalSettingsV1 = { schema: "settings-local/v1", locale },
    errors = validateLocalSettingsV1(value);
  if (errors.length) throw new Error(errors.join("; "));
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseLocalSettings(value: unknown): LocalSettingsV1 | null {
  return validateLocalSettingsV1(value).length ? null : (value as LocalSettingsV1);
}

export function readSettingsFacet(body: string): SettingsV1 {
  const settings = SETTINGS_DECLARATION_RUNTIME.read(body) as unknown as SettingsV1;
  const errors = validateSettingsV1(settings);
  if (errors.length) throw new Error(errors.join("; "));
  return settings;
}

/** Replace repository-owned YAML fields and remove the legacy authored locale line. */
export function writeRepositorySettingsFacet(body: string, settings: RepositorySettingsV1 | SettingsV1): string {
  const repository = repositorySettings(settings),
    errors = validateRepositorySettings(repository);
  if (errors.length) throw new Error(errors.join("; "));
  const next = SETTINGS_DECLARATION_RUNTIME.writeRepository(body, repository as unknown as Readonly<SettingsRecord>);
  if (stableStringify(repositorySettings(readSettingsFacet(next))) !== stableStringify(repository))
    throw new Error("repository settings facet replacement did not round-trip exactly");
  return next;
}

type SettingsRecord = Record<string, unknown>;

export class SettingsDeclarationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsDeclarationError";
  }
}

export interface SettingsDeclarationRuntime {
  readonly actionInputFields: ReturnType<typeof settingsActionInputFieldsFromDeclarations>;
  readonly cliInputFields: readonly SettingsCliInputField[];
  readonly repositoryActionFields: readonly string[];
  readonly read: (body: string) => Readonly<SettingsRecord>;
  readonly writeRepository: (body: string, settings: Readonly<SettingsRecord>) => string;
  readonly applyRepositoryAction: (
    current: Readonly<SettingsRecord>,
    action: Readonly<Record<string, unknown>>,
  ) => Readonly<SettingsRecord>;
  readonly actionValues: (settings: Readonly<SettingsRecord>) => Readonly<Record<string, unknown>>;
}

export function createSettingsDeclarationRuntime(
  declarations: readonly SettingsFieldDeclaration[],
): SettingsDeclarationRuntime {
  const repositoryDeclarations = declarations.filter(({ ownership }) => ownership === "repository"),
    actionInputFields = settingsActionInputFieldsFromDeclarations(declarations),
    cliInputFields = settingsCliInputFieldsFromDeclarations(declarations),
    repositoryActionFields = Object.freeze([
      ...new Set(repositoryDeclarations.flatMap(({ action }) => (action ? [action.field] : []))),
    ]);
  return Object.freeze({
    actionInputFields,
    cliInputFields,
    repositoryActionFields,
    read: (body: string) => readDeclaredSettings(body, declarations),
    writeRepository: (body: string, settings: Readonly<SettingsRecord>) =>
      writeDeclaredRepositorySettings(body, settings, declarations),
    applyRepositoryAction: (current: Readonly<SettingsRecord>, action: Readonly<Record<string, unknown>>) =>
      applyDeclaredRepositoryAction(current, action, repositoryDeclarations),
    actionValues: (settings: Readonly<SettingsRecord>) => declaredSettingsActionValues(settings, declarations),
  });
}

export const SETTINGS_DECLARATION_RUNTIME = createSettingsDeclarationRuntime(SETTINGS_FIELD_DECLARATIONS);

function settingsValueFromDeclarations(
  declarations: readonly SettingsFieldDeclaration[],
  source?: Readonly<Record<string, unknown>>,
): Readonly<SettingsRecord> {
  const value: SettingsRecord = { schema: "settings/v1", settingsId: SETTINGS_ID };
  for (const declaration of declarations) {
    const fromSource = source === undefined ? undefined : valueAtPath(source, declaration.path),
      fieldValue = fromSource === undefined ? declaration.defaultValue : fromSource;
    if (fieldValue !== undefined)
      setValueAtPath(
        value,
        declaration.path,
        declaration.valueKind === "gate-mappings"
          ? canonicalGateMappings(fieldValue as readonly GateWitnessMappingV1[])
          : fieldValue,
      );
  }
  return value;
}

function settingsSchema(
  id: string,
  schemaName: "settings/v1" | "settings-local/v1",
  declarations: readonly SettingsFieldDeclaration[],
  includeSettingsId: boolean,
): EntityDocumentJsonSchema {
  const schema: MutableObjectSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: id,
    type: "object",
    properties: { schema: { type: "string", const: schemaName } },
    required: ["schema"],
    additionalProperties: false,
  };
  if (includeSettingsId) {
    schema.properties.settingsId = { type: "string", const: SETTINGS_ID };
    schema.required.push("settingsId");
  }
  for (const declaration of declarations) insertDeclaredSchema(schema, declaration);
  return schema as unknown as EntityDocumentJsonSchema;
}

interface MutableObjectSchema {
  $schema?: "https://json-schema.org/draft/2020-12/schema";
  $id?: string;
  type: "object";
  properties: Record<string, EntityJsonSchemaNode>;
  required: string[];
  additionalProperties: false;
  "x-settings-ownership"?: "repository" | "local";
}

function insertDeclaredSchema(root: MutableObjectSchema, declaration: SettingsFieldDeclaration): void {
  let parent = root;
  declaration.path.forEach((segment, index) => {
    const leaf = index === declaration.path.length - 1;
    if (leaf) {
      parent.properties[segment] = declaredFieldSchema(declaration);
      if (declaration.snapshotRequired && !parent.required.includes(segment)) parent.required.push(segment);
      return;
    }
    const existing = parent.properties[segment] as MutableObjectSchema | undefined;
    if (existing?.type === "object") parent = existing;
    else {
      const nested: MutableObjectSchema = {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
        "x-settings-ownership": declaration.ownership,
      };
      parent.properties[segment] = nested;
      parent = nested;
    }
    if (declaration.snapshotRequired) {
      const owner = schemaParentAtPath(root, declaration.path.slice(0, index));
      if (!owner.required.includes(segment)) owner.required.push(segment);
    }
  });
}

function schemaParentAtPath(root: MutableObjectSchema, path: readonly string[]): MutableObjectSchema {
  return path.reduce((parent, segment) => parent.properties[segment] as MutableObjectSchema, root);
}

function declaredFieldSchema(declaration: SettingsFieldDeclaration): EntityJsonSchemaNode {
  const common = {
    description: declaration.description,
    "x-settings-ownership": declaration.ownership,
  } as const;
  switch (declaration.valueKind) {
    case "string":
      return {
        ...common,
        type: "string",
        ...(declaration.pattern ? { pattern: declaration.pattern } : {}),
        minLength: 1,
      };
    case "enum":
      return { ...common, type: "string", enum: declaration.allowedValues ?? [] };
    case "integer":
      return { ...common, type: "integer", minimum: declaration.minimum };
    case "boolean":
      return { ...common, type: "boolean" };
    case "string-array":
      return {
        ...common,
        type: "array",
        items: {
          type: "string",
          ...(declaration.pattern ? { pattern: declaration.pattern } : {}),
          minLength: 1,
        },
        ...(declaration.uniqueItems ? { uniqueItems: true } : {}),
      };
    case "gate-mappings":
      return { ...gateSettingsSchema(), ...common };
  }
}

function gateSettingsSchema() {
  return {
    type: "array" as const,
    "x-unique-by": "gateId",
    items: {
      type: "object" as const,
      properties: {
        gateId: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        adapter: { type: "string" as const, enum: ["none", ...mappedWitnessAdapterIds] },
        appliesTo: { type: "string" as const, enum: gateAppliesTo },
        branch: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        event: { type: "string" as const, pattern: settingValuePattern, minLength: 1 },
        command: { type: "string" as const, minLength: 1 },
        coverage: { type: "string" as const, enum: ["exact", "descendant"] },
        selection: { type: "string" as const, enum: ["newest"] },
        mandatorySignoff: { type: "boolean" as const },
        allowOverride: { type: "boolean" as const },
      },
      required: ["gateId", "adapter"],
      additionalProperties: false,
    },
  };
}

function withGateMappingIssues(errors: readonly string[], value: unknown): readonly string[] {
  const gates = (value as { readonly gates?: readonly GateWitnessMappingV1[] } | null)?.gates;
  return errors.length || gates === undefined ? errors : gateWitnessMappingIssues(gates);
}

/**
 * `settings.gates` maps each gate id either inline to `none` or to a block naming its witness adapter:
 * `    ci:` followed by six-space `appliesTo:`/`adapter:`/adapter option lines.
 */
export function readGateSettings(body: string): readonly GateWitnessMappingV1[] {
  const settings = authoredSettings(body);
  return readGateMappings(settings.gates);
}

/** One key order for every mapping, so snapshots from YAML, events, and projections compare byte-equal. */
function canonicalGateMappings(gates: readonly GateWitnessMappingV1[]): readonly GateWitnessMappingV1[] {
  return gates.map(({ gateId, adapter, ...options }) => ({
    gateId,
    adapter,
    ...Object.fromEntries(Object.entries(options).sort(([left], [right]) => left.localeCompare(right))),
  }));
}

function readDeclaredSettings(
  body: string,
  declarations: readonly SettingsFieldDeclaration[],
): Readonly<SettingsRecord> {
  const document = parseAuthoredDocument(body),
    authored = authoredSettings(document),
    settings = settingsValueFromDeclarations(declarations) as SettingsRecord;
  assertDeclaredNestedKeys(authored, declarations);
  for (const declaration of declarations) {
    assertDeclaredSequenceStyle(document, declaration);
    const value = readDeclaredField(authored, declaration);
    if (value === undefined) deleteValueAtPath(settings, declaration.path);
    else setValueAtPath(settings, declaration.path, value);
  }
  return settings;
}

function assertDeclaredSequenceStyle(
  document: ReturnType<typeof parseDocument>,
  declaration: SettingsFieldDeclaration,
): void {
  if (declaration.valueKind !== "string-array" || declaration.yamlStyle === undefined) return;
  const node = document.getIn(["settings", ...declaration.path], true);
  if (!isSeq(node)) return;
  if (declaration.yamlStyle === "inline" && !node.flow)
    throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must be an inline array`);
  if (declaration.yamlStyle === "block-list" && node.flow && node.items.length > 0)
    throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must hold a setup: block list`);
}

function readDeclaredField(authored: Readonly<SettingsRecord>, declaration: SettingsFieldDeclaration): unknown {
  const declaredValue = valueAtPath(authored, declaration.path),
    value =
      declaredValue !== undefined
        ? declaredValue
        : declaration.legacyPath
          ? valueAtPath(authored, declaration.legacyPath)
          : undefined;
  if (value === undefined) return declaration.defaultValue;
  if (declaration.valueKind === "gate-mappings") return readGateMappings(value);
  switch (declaration.valueKind) {
    case "string":
    case "enum":
      return value;
    case "integer":
      return value;
    case "boolean":
      return value;
    case "string-array":
      if (!Array.isArray(value))
        throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must be an array of strings`);
      return parseDeclaredStringArray(
        value.map((entry) => {
          if (typeof entry === "string") return entry;
          if (
            declaration.yamlStyle === "block-list" &&
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            Object.keys(entry).length === 1 &&
            typeof (entry as Readonly<SettingsRecord>).run === "string"
          )
            return `run: ${(entry as Readonly<SettingsRecord>).run as string}`;
          throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must be an array of strings`);
        }),
        declaration,
      );
  }
}

function parseDeclaredStringArray(values: readonly string[], declaration: SettingsFieldDeclaration): readonly string[] {
  if (
    values.some(
      (value) =>
        (declaration.pattern !== undefined && !new RegExp(declaration.pattern, "u").test(value)) ||
        (declaration.forbiddenPattern !== undefined && new RegExp(declaration.forbiddenPattern, "u").test(value)),
    ) ||
    (declaration.uniqueItems && new Set(values).size !== values.length)
  )
    throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must contain unique declared values`);
  return values;
}

function writeDeclaredRepositorySettings(
  body: string,
  settings: Readonly<SettingsRecord>,
  declarations: readonly SettingsFieldDeclaration[],
): string {
  const document = parseAuthoredDocument(body),
    authored = authoredSettings(document);
  for (const declaration of declarations) {
    if (declaration.ownership !== "repository") continue;
    const value = valueAtPath(settings, declaration.path);
    writeDeclaredValue(document, declaration, value, readDeclaredField(authored, declaration));
    if (declaration.legacyPath) deleteDocumentPath(document, declaration.legacyPath);
  }
  for (const declaration of declarations)
    if (declaration.ownership === "local") deleteDocumentPath(document, declaration.path);
  if (!document.has("settings")) return body;
  return stringifyAuthoredDocument(document, body);
}

function writeDeclaredValue(
  document: ReturnType<typeof parseDocument>,
  declaration: SettingsFieldDeclaration,
  value: unknown,
  current: unknown,
): void {
  const path = ["settings", ...declaration.path],
    exists = document.hasIn(path);
  if (exists && stableStringify(value) === stableStringify(current)) return;
  if (
    value === undefined ||
    (declaration.valueKind === "gate-mappings" && Array.isArray(value) && value.length === 0) ||
    (declaration.yamlStyle === "block-list" &&
      Array.isArray(value) &&
      value.length === 0 &&
      Array.isArray(declaration.defaultValue) &&
      declaration.defaultValue.length === 0)
  ) {
    if (exists) deleteDocumentPath(document, declaration.path);
    return;
  }
  if (!exists && stableStringify(value) === stableStringify(declaration.defaultValue)) return;
  if (!document.has("settings")) throw new Error("Missing settings block in harness.yaml.");
  ensureSettingsMap(document);
  const authoredValue =
    declaration.valueKind === "gate-mappings"
      ? gateMappingsValue(value)
      : declaration.yamlStyle === "block-list" && Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === "string" && entry.startsWith("run: ") ? { run: entry.slice("run: ".length) } : entry,
          )
        : value;
  document.setIn(path, Array.isArray(authoredValue) ? document.createNode(authoredValue) : authoredValue);
  const node = document.getIn(path, true);
  if (isSeq(node) && declaration.yamlStyle !== undefined) node.flow = declaration.yamlStyle === "inline";
}

function applyDeclaredRepositoryAction(
  current: Readonly<SettingsRecord>,
  action: Readonly<Record<string, unknown>>,
  declarations: readonly SettingsFieldDeclaration[],
): Readonly<SettingsRecord> {
  const candidate = settingsValueFromDeclarations(declarations, current) as SettingsRecord;
  validateGroupedActionValues(action, declarations);
  for (const declaration of declarations) {
    const actionDeclaration = declaration.action;
    if (!actionDeclaration || !Object.hasOwn(action, actionDeclaration.field)) continue;
    const input = action[actionDeclaration.field];
    if (actionDeclaration.key !== undefined) {
      const record = input as Readonly<Record<string, unknown>>;
      if (!Object.hasOwn(record, actionDeclaration.key)) continue;
      const value = record[actionDeclaration.key];
      if (value === null) deleteValueAtPath(candidate, declaration.path);
      else setValueAtPath(candidate, declaration.path, parseActionValue(value, declaration));
      continue;
    }
    setValueAtPath(candidate, declaration.path, parseActionValue(input, declaration));
  }
  return candidate;
}

function validateGroupedActionValues(
  action: Readonly<Record<string, unknown>>,
  declarations: readonly SettingsFieldDeclaration[],
): void {
  const groups = new Map<string, Set<string>>();
  for (const declaration of declarations) {
    const grouped = declaration.action;
    if (!grouped?.key) continue;
    const keys = groups.get(grouped.field) ?? new Set<string>();
    keys.add(grouped.key);
    groups.set(grouped.field, keys);
  }
  for (const [field, keys] of groups) {
    if (!Object.hasOwn(action, field)) continue;
    const value = action[field];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new SettingsDeclarationError(`${field} must be an object.`);
    for (const [key, entry] of Object.entries(value)) {
      if (!keys.has(key)) throw new SettingsDeclarationError(`Unknown ${field} entry ${key}.`);
      if (entry !== null && typeof entry !== "string")
        throw new SettingsDeclarationError(`${field}.${key} must be a declared value or null.`);
    }
  }
}

function parseActionValue(value: unknown, declaration: SettingsFieldDeclaration): unknown {
  const label = declaration.action?.field ?? declaration.path.join(".");
  switch (declaration.valueKind) {
    case "string": {
      if (typeof value !== "string" || !value.trim())
        throw new SettingsDeclarationError(`${label} must be a non-empty string.`);
      const trimmed = value.trim();
      if (declaration.pattern && !new RegExp(declaration.pattern, "u").test(trimmed))
        throw new SettingsDeclarationError(`${label} does not match its declared pattern.`);
      return trimmed;
    }
    case "enum":
      if (typeof value === "string" && declaration.allowedValues?.includes(value)) return value;
      throw new SettingsDeclarationError(`${label} must be one of ${declaration.allowedValues?.join(", ")}.`);
    case "integer": {
      const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
      if (
        Number.isSafeInteger(parsed) &&
        (declaration.minimum === undefined || parsed >= declaration.minimum) &&
        (declaration.maximum === undefined || parsed <= declaration.maximum)
      )
        return parsed;
      throw new SettingsDeclarationError(`${label} must be an integer in its declared range.`);
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      throw new SettingsDeclarationError(`${label} must be true or false.`);
    case "string-array": {
      if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
        throw new SettingsDeclarationError(`${label} must be an array of strings.`);
      if (declaration.noneMeansEmpty && value.length === 1 && value[0] === "none") return [];
      const strings = value.map((entry) => entry.trim());
      if (
        strings.some(
          (entry) =>
            (declaration.pattern !== undefined && !new RegExp(declaration.pattern, "u").test(entry)) ||
            (declaration.forbiddenPattern !== undefined && new RegExp(declaration.forbiddenPattern, "u").test(entry)),
        ) ||
        (declaration.uniqueItems && new Set(strings).size !== strings.length)
      )
        throw new SettingsDeclarationError(`${label} contains invalid or duplicate values.`);
      return strings;
    }
    case "gate-mappings":
      if (Array.isArray(value) && value.every((entry) => typeof entry === "object" && entry !== null)) return value;
      throw new SettingsDeclarationError(`${label} must be an array of gate witness mappings.`);
  }
}

function declaredSettingsActionValues(
  settings: Readonly<SettingsRecord>,
  declarations: readonly SettingsFieldDeclaration[],
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const declaration of declarations) {
    const action = declaration.action;
    if (!action || action.internal || Object.hasOwn(values, action.field)) continue;
    if (action.key !== undefined) {
      values[action.field] = valueAtPath(settings, declaration.path.slice(0, -1)) ?? {};
      continue;
    }
    const stored = valueAtPath(settings, declaration.path);
    values[action.field] =
      action.project === "effective-closeout-gate"
        ? (stored ?? valueAtPath(settings, ["closeout", "profile"]) === "strict")
        : stored;
  }
  return values;
}

function valueAtPath(value: Readonly<Record<string, unknown>>, path: readonly string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Readonly<Record<string, unknown>>)[segment];
  }
  return current;
}

function setValueAtPath(target: SettingsRecord, path: readonly string[], value: unknown): void {
  let current = target;
  path.forEach((segment, index) => {
    if (index === path.length - 1) {
      current[segment] = value;
      return;
    }
    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[segment] = {};
    current = current[segment] as SettingsRecord;
  });
}

function deleteValueAtPath(target: SettingsRecord, path: readonly string[]): void {
  const parents: Array<{ readonly record: SettingsRecord; readonly key: string }> = [];
  let current = target;
  for (const segment of path.slice(0, -1)) {
    const next = current[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    parents.push({ record: current, key: segment });
    current = next as SettingsRecord;
  }
  delete current[path.at(-1)!];
  for (const { record, key } of parents.reverse()) {
    const child = record[key];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0)
      delete record[key];
  }
}

/**
 * Serialize `settings.gates` back into the authored facet: an empty mapping list removes the
 * section outright (a bare `gates:` line has no block and `readGateSettings` rejects it), a
 * non-empty list renders `    <id>: none` inline or a `    <id>:` block with six-space fields in
 * canonical key order so the read-back is byte-equal to the entity value.
 */
export function writeGatesFacet(body: string, gates: readonly GateWitnessMappingV1[]): string {
  const document = parseAuthoredDocument(body);
  if (!document.has("settings")) throw new Error("Missing settings block in harness.yaml.");
  ensureSettingsMap(document);
  if (gates.length) document.setIn(["settings", "gates"], gateMappingsValue(gates));
  else deleteDocumentPath(document, ["gates"]);
  return stringifyAuthoredDocument(document, body);
}

function ensureSettingsMap(document: ReturnType<typeof parseDocument>): void {
  if (document.get("settings") == null) document.set("settings", document.createNode({}));
}

function parseAuthoredDocument(body: string): ReturnType<typeof parseDocument> {
  const document = parseDocument(body);
  if (document.errors.length) throw new SettingsDeclarationError(`cannot read line: ${document.errors[0]!.message}`);
  return document;
}

function authoredSettings(body: string | ReturnType<typeof parseDocument>): Readonly<SettingsRecord> {
  const value = (
    typeof body === "string" ? parseAuthoredDocument(body) : body
  ).toJS() as Readonly<SettingsRecord> | null;
  return value?.settings && typeof value.settings === "object" && !Array.isArray(value.settings)
    ? (value.settings as Readonly<SettingsRecord>)
    : {};
}

function readGateMappings(value: unknown): readonly GateWitnessMappingV1[] {
  if (value === undefined) return INITIAL_SETTINGS_V1.gates;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SettingsDeclarationError(
      "settings.gates must be a block of gate witness mappings; cannot read line as a mapping",
    );
  return Object.entries(value).map(([gateId, mapping]) => {
    if (mapping === "none") return { gateId, adapter: "none" };
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping))
      throw new SettingsDeclarationError(`settings.gates cannot read line: ${gateId} must be none or a mapping`);
    return { gateId, ...(mapping as Readonly<Record<string, unknown>>) } as GateWitnessMappingV1;
  });
}

function gateMappingsValue(value: unknown): Readonly<SettingsRecord> {
  return Object.fromEntries(
    (value as readonly GateWitnessMappingV1[]).map(({ gateId, adapter, ...options }) => [
      gateId,
      adapter === "none" ? "none" : { adapter, ...options },
    ]),
  );
}

function assertDeclaredNestedKeys(
  authored: Readonly<SettingsRecord>,
  declarations: readonly SettingsFieldDeclaration[],
): void {
  const groups = new Map<string, { readonly path: readonly string[]; readonly children: Set<string> }>();
  for (const declaration of declarations) {
    for (let depth = 1; depth < declaration.path.length; depth += 1) {
      const path = declaration.path.slice(0, depth),
        id = path.join("."),
        group = groups.get(id) ?? { path, children: new Set<string>() };
      group.children.add(declaration.path[depth]!);
      groups.set(id, group);
    }
  }
  for (const { path, children } of groups.values()) {
    const parent = valueAtPath(authored, path);
    if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    for (const key of Object.keys(parent))
      if (!children.has(key))
        throw new SettingsDeclarationError(`settings.${path.join(".")} field ${key} is not declared`);
  }
}

function deleteDocumentPath(document: ReturnType<typeof parseDocument>, path: readonly string[]): void {
  const fullPath = ["settings", ...path];
  if (!document.hasIn(fullPath)) return;
  document.deleteIn(fullPath);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parentPath = ["settings", ...path.slice(0, depth)],
      parent = document.getIn(parentPath, true);
    if (isMap(parent) && parent.items.length === 0) document.deleteIn(parentPath);
  }
}

function stringifyAuthoredDocument(document: ReturnType<typeof parseDocument>, original: string): string {
  const trailing = /(?:\r?\n)*$/u.exec(original)?.[0] ?? "",
    rendered = document.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/(?:\r?\n)*$/u, "");
  return `${rendered}${trailing}`;
}

export function validateRepositorySettings(value: unknown): readonly string[] {
  return withGateMappingIssues(
    validateEntityJsonSchema(SETTINGS_REPOSITORY_V1_SCHEMA, value, "repository settings"),
    value,
  );
}
