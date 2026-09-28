import { stableStringify } from "../integrity/stable-hash.ts";
import type { EntityDocumentJsonSchema, EntityJsonSchemaNode } from "./entity-json-schema.ts";
import {
  gateAppliesTo,
  gateGovernanceFields,
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
  defineSettingsField,
  reviewIndependenceLevels,
  rolePreferenceFields,
  settingValuePattern,
  settingsActionInputFieldsFromDeclarations,
  settingsCliInputFieldsFromDeclarations,
  settingsLocales,
  settingsFieldLabel,
  type ReviewIndependence,
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
  defineSettingsField,
  reviewIndependenceLevels,
  rolePreferenceFields,
  settingValuePattern,
  settingsLocales,
  settingsFieldLabel,
  type ReviewIndependence,
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
  if (!/^  gates:/mu.test(body)) return INITIAL_SETTINGS_V1.gates;
  const section = /^  gates:[^\S\r\n]*(?:#[^\r\n]*)?\r?\n((?:    [^\r\n]*(?:\r?\n|$))*)/mu.exec(body)?.[1];
  if (section === undefined) throw new Error("settings.gates must be a block of gate witness mappings");
  const gates: Record<string, string | boolean>[] = [];
  for (const line of section.split(/\r?\n/u)) {
    const content = line.replace(/[^\S\r\n]*#.*$/u, "");
    if (!content.trim()) continue;
    const gate = /^    ([^\s:]+):[^\S\r\n]*(\S*)$/u.exec(content),
      field = /^      ([A-Za-z]+):[^\S\r\n]*(\S.*?)[^\S\r\n]*$/u.exec(content),
      current = gates.at(-1);
    if (gate && (gate[2] === "" || gate[2] === "none"))
      gates.push({ gateId: gate[1]!, ...(gate[2] === "none" ? { adapter: "none" } : {}) });
    else if (field && current && current.adapter !== "none" && !Object.hasOwn(current, field[1]!))
      current[field[1]!] = governanceFlag(field[1]!, field[2]!);
    else throw new Error(`settings.gates cannot read line: ${content.trim()}`);
  }
  return gates as unknown as readonly GateWitnessMappingV1[];
}

/** Governance modifiers are YAML booleans; any other spelling stays a string for the schema to reject. */
function governanceFlag(field: string, raw: string): string | boolean {
  return (gateGovernanceFields as readonly string[]).includes(field) && (raw === "true" || raw === "false")
    ? raw === "true"
    : raw;
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
  const settings = settingsValueFromDeclarations(declarations) as SettingsRecord;
  assertDeclaredNestedKeys(body, declarations);
  for (const declaration of declarations) {
    const value = readDeclaredField(body, declaration);
    if (value === undefined) deleteValueAtPath(settings, declaration.path);
    else setValueAtPath(settings, declaration.path, value);
  }
  return settings;
}

function readDeclaredField(body: string, declaration: SettingsFieldDeclaration): unknown {
  if (declaration.valueKind === "gate-mappings") return readGateSettings(body);
  const raw =
    settingsScalar(body, declaration.path) ??
    (declaration.legacyPath ? settingsScalar(body, declaration.legacyPath) : undefined);
  if (raw === undefined) return declaration.defaultValue;
  switch (declaration.valueKind) {
    case "string":
    case "enum":
      return raw;
    case "integer":
      return Number(raw);
    case "boolean":
      if (raw !== "true" && raw !== "false")
        throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must be true or false`);
      return raw === "true";
    case "string-array":
      return parseInlineStringArray(raw, declaration);
  }
}

function parseInlineStringArray(raw: string, declaration: SettingsFieldDeclaration): readonly string[] {
  if (!raw.startsWith("[") || !raw.endsWith("]"))
    throw new SettingsDeclarationError(`settings.${declaration.path.join(".")} must be an inline array`);
  const values = raw.slice(1, -1).trim()
    ? raw
        .slice(1, -1)
        .split(",")
        .map((value) => value.trim())
    : [];
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
  let next = body;
  for (const declaration of declarations) {
    if (declaration.ownership !== "repository") continue;
    const value = valueAtPath(settings, declaration.path);
    next =
      declaration.valueKind === "gate-mappings"
        ? writeGatesFacet(next, value as readonly GateWitnessMappingV1[])
        : writeSettingsScalar(next, declaration, value);
    if (declaration.legacyPath) next = removeSettingsScalar(next, declaration.legacyPath);
  }
  for (const declaration of declarations)
    if (declaration.ownership === "local") next = removeSettingsScalar(next, declaration.path);
  return next;
}

function writeSettingsScalar(body: string, declaration: SettingsFieldDeclaration, value: unknown): string {
  const fallback = serializedDeclaredValue(declaration, declaration.defaultValue),
    serialized = serializedDeclaredValue(declaration, value),
    existing = settingsScalar(body, declaration.path);
  if (serialized === undefined) return existing === undefined ? body : removeSettingsScalar(body, declaration.path);
  if (existing === undefined && serialized === fallback) return body;
  return upsertSettingsScalar(body, declaration.path, serialized);
}

function serializedDeclaredValue(declaration: SettingsFieldDeclaration, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (declaration.valueKind === "string-array") return `[${(value as readonly string[]).join(", ")}]`;
  return String(value);
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
  const section = /^  gates:[^\r\n]*(?:\r?\n)(?:    [^\r\n]*(?:\r?\n|$))*/mu;
  if (gates.length === 0) return section.test(body) ? body.replace(section, "") : body;
  const rendered =
    "  gates:\n" +
    gates
      .map((gate) =>
        gate.adapter === "none"
          ? `    ${gate.gateId}: none`
          : [
              `    ${gate.gateId}:`,
              `      adapter: ${gate.adapter}`,
              ...Object.entries(gate)
                .filter(([key]) => key !== "gateId" && key !== "adapter")
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, value]) => `      ${key}: ${String(value)}`),
            ].join("\n"),
      )
      .join("\n") +
    "\n";
  if (section.test(body)) return body.replace(section, rendered);
  const header = /^settings:[^\r\n]*(?:\r?\n|$)/mu;
  if (!header.test(body)) throw new Error("Missing settings block in harness.yaml.");
  return body.replace(header, (match) => `${match}${rendered}`);
}

function settingsScalar(body: string, path: readonly string[]): string | undefined {
  const lines = body.split(/\r?\n/u),
    location = locateSettingsPath(lines, path);
  if (!location) return undefined;
  const content = lines[location.index]!.slice(location.indent + location.key.length + 1),
    value = content.replace(/[^\S\r\n]*#.*$/u, "").trim();
  return value || undefined;
}

function assertDeclaredNestedKeys(body: string, declarations: readonly SettingsFieldDeclaration[]): void {
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
  const lines = body.split(/\r?\n/u);
  for (const { path, children } of groups.values()) {
    const parent = locateSettingsPath(lines, path);
    if (!parent) continue;
    const end = subtreeEnd(lines, parent.index, parent.indent),
      childIndent = parent.indent + 2;
    for (let index = parent.index + 1; index < end; index += 1) {
      const line = lines[index]!,
        indent = line.length - line.trimStart().length;
      if (indent !== childIndent || !line.trim() || line.trimStart().startsWith("#")) continue;
      const key = /^([^\s:#]+):/u.exec(line.trimStart())?.[1];
      if (key && !children.has(key))
        throw new SettingsDeclarationError(`settings.${path.join(".")} field ${key} is not declared`);
    }
  }
}

function upsertSettingsScalar(body: string, path: readonly string[], value: string): string {
  const trailingNewline = body.endsWith("\n"),
    lines = body.split(/\r?\n/u);
  if (trailingNewline) lines.pop();
  const settingsIndex = lines.findIndex((line) => /^settings:[^\r\n]*$/u.test(line));
  if (settingsIndex < 0) throw new Error("Missing settings block in harness.yaml.");
  const located = locateSettingsPath(lines, path);
  if (located) {
    const line = lines[located.index]!,
      comment = /([^\S\r\n]+#[^\r\n]*)$/u.exec(line)?.[1] ?? "";
    lines[located.index] = `${" ".repeat(located.indent)}${located.key}: ${value}${comment}`;
    return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
  }
  const insertion = missingPathInsertion(lines, settingsIndex, path, value);
  lines.splice(insertion.index, 0, ...insertion.lines);
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function removeSettingsScalar(body: string, path: readonly string[]): string {
  const trailingNewline = body.endsWith("\n"),
    lines = body.split(/\r?\n/u);
  if (trailingNewline) lines.pop();
  const located = locateSettingsPath(lines, path);
  if (!located) return body;
  lines.splice(located.index, 1);
  for (let depth = path.length - 1; depth > 0; depth -= 1) {
    const parent = locateSettingsPath(lines, path.slice(0, depth));
    if (!parent) continue;
    const end = subtreeEnd(lines, parent.index, parent.indent),
      hasContent = lines.slice(parent.index + 1, end).some((line) => line.trim() && !line.trimStart().startsWith("#"));
    if (!hasContent) lines.splice(parent.index, end - parent.index);
  }
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function locateSettingsPath(
  lines: readonly string[],
  path: readonly string[],
): { readonly index: number; readonly indent: number; readonly key: string } | undefined {
  const settingsIndex = lines.findIndex((line) => /^settings:[^\r\n]*$/u.test(line));
  if (settingsIndex < 0) return undefined;
  let start = settingsIndex + 1,
    end = subtreeEnd(lines, settingsIndex, 0);
  for (let depth = 0; depth < path.length; depth += 1) {
    const indent = (depth + 1) * 2,
      key = path[depth]!,
      index = findDirectChild(lines, start, end, indent, key);
    if (index < 0) return undefined;
    if (depth === path.length - 1) return { index, indent, key };
    start = index + 1;
    end = subtreeEnd(lines, index, indent);
  }
  return undefined;
}

function findDirectChild(lines: readonly string[], start: number, end: number, indent: number, key: string): number {
  const prefix = `${" ".repeat(indent)}${key}:`;
  for (let index = start; index < end; index += 1) if (lines[index]!.startsWith(prefix)) return index;
  return -1;
}

function subtreeEnd(lines: readonly string[], index: number, indent: number): number {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const nextIndent = line.length - line.trimStart().length;
    if (nextIndent <= indent) return cursor;
  }
  return lines.length;
}

function missingPathInsertion(
  lines: readonly string[],
  settingsIndex: number,
  path: readonly string[],
  value: string,
): { readonly index: number; readonly lines: readonly string[] } {
  let parentIndex = settingsIndex,
    parentIndent = 0,
    depth = 0;
  for (; depth < path.length - 1; depth += 1) {
    const located = locateSettingsPath(lines, path.slice(0, depth + 1));
    if (!located) break;
    parentIndex = located.index;
    parentIndent = located.indent;
  }
  const inserted = path.slice(depth).map((key, offset) => {
    const indent = (depth + offset + 1) * 2;
    return `${" ".repeat(indent)}${key}:${depth + offset === path.length - 1 ? ` ${value}` : ""}`;
  });
  return { index: subtreeEnd(lines, parentIndex, parentIndent), lines: inserted };
}

export function validateRepositorySettings(value: unknown): readonly string[] {
  return withGateMappingIssues(
    validateEntityJsonSchema(SETTINGS_REPOSITORY_V1_SCHEMA, value, "repository settings"),
    value,
  );
}
