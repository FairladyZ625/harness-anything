import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fleetActionPayloadIssue,
  type EntityActionInputField,
} from "@harness-anything/daemon/internal/protocol/daemon-protocol-fleet-validation";
import { commandDescriptorForAction } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import {
  generatedTaskActionProtocolDeclarations,
  type CliInputFacet,
} from "@harness-anything/preset/internal/preset-command-contract";
import { cliErrorMessage } from "../cli-error.ts";
import type { ThinCommand } from "../cli/thin-command.ts";

type Action = Record<string, unknown> & { readonly kind: string };
type Codec = NonNullable<CliInputFacet["codec"]>;

const fieldName = (name: string) => name.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

function invalid(message: string): never {
  throw Object.assign(new Error(message), { code: "invalid_field" });
}

function descriptorFor(command: ThinCommand) {
  try {
    return commandDescriptorForAction(command.action.kind);
  } catch (error) {
    throw Object.assign(new Error(`No command declaration exists for ${command.action.kind}.`), {
      code: "invalid_field",
      cause: error,
    });
  }
}

function readUtf8(rootDir: string, source: string, maxBytes: number, label: string): string {
  if (typeof source !== "string" || source.length === 0) invalid(`${label} must name one file on this edge.`);
  const resolved = path.resolve(rootDir, source),
    relative = path.relative(rootDir, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    invalid(`${label} must stay within the selected repository.`);
  let bytes: Buffer;
  try {
    bytes = readFileSync(resolved);
  } catch (error) {
    throw Object.assign(new Error(`${label} could not be read on this edge: ${cliErrorMessage(error)}`), {
      code: "invalid_field",
      cause: error,
    });
  }
  if (bytes.byteLength > maxBytes) invalid(`${label} exceeds the declared ${maxBytes}-byte limit.`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw Object.assign(new Error(`${label} must be valid UTF-8.`), { code: "invalid_field", cause: error });
  }
}

function parseJson(value: string, label: string, maxBytes: number): Record<string, unknown> {
  if (Buffer.byteLength(value, "utf8") > maxBytes) invalid(`${label} exceeds the declared ${maxBytes}-byte limit.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw Object.assign(new Error(`${label} could not be read as JSON on this edge: ${cliErrorMessage(error)}`), {
      code: "invalid_field",
      cause: error,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    invalid(`${label} must contain one JSON object.`);
  return parsed as Record<string, unknown>;
}

function inputsOf(descriptor: ReturnType<typeof descriptorFor>): readonly CliInputFacet[] {
  return ("inputs" in descriptor ? descriptor.inputs : []) as readonly CliInputFacet[];
}

type DeclaredInput = CliInputFacet & {
  readonly field?: string;
  readonly maxLength?: number;
  readonly wire?: EntityActionInputField["wire"];
  readonly projection?: "number" | "fact-hold-array" | "json-object" | "json-object-array";
};

function declaredField(input: DeclaredInput): string {
  return input.field ?? fieldName(input.name);
}

function validationFieldFromInput(input: DeclaredInput): EntityActionInputField | null {
  const codec = typeof input.codec === "object" ? input.codec : undefined;
  if (input.jsonAllowedFields || codec?.kind === "json-object") return null;
  const typeByProjection = {
      number: "number",
      "fact-hold-array": "fact-hold-array",
      "json-object": "json-object",
      "json-object-array": "json-object-array",
    } as const,
    type = input.projection
      ? typeByProjection[input.projection]
      : input.kind === "boolean"
        ? "boolean"
        : input.kind === "repeated"
          ? "string-array"
          : "string",
    effectiveType = codec?.kind === "line-list-file" ? "string-array" : type;
  return {
    field: declaredField(input),
    type: effectiveType,
    required: input.required,
    ...(input.enum ? { enum: input.enum } : {}),
    ...(input.regex && type === "string" ? { regex: input.regex } : {}),
    ...(input.maxLength === undefined ? {} : { wire: { maxLength: input.maxLength } }),
    ...(input.wire
      ? { wire: { ...input.wire, ...(input.maxLength === undefined ? {} : { maxLength: input.maxLength }) } }
      : {}),
  };
}

function addJsonAllowedFields(fields: Map<string, EntityActionInputField>, input: DeclaredInput, source: Action): void {
  if (!Object.hasOwn(source, declaredField(input))) return;
  for (const field of input.jsonAllowedFields ?? [])
    if (!fields.has(field))
      fields.set(field, {
        field,
        type: fields.get(field)?.type === "json-object-array" ? "json-object-array" : "string",
        required: input.jsonFields?.includes(field) ?? false,
        ...(input.jsonEnums?.[field] ? { enum: input.jsonEnums[field] } : {}),
      });
}

function addPathFields(
  fields: Map<string, EntityActionInputField>,
  descriptor: ReturnType<typeof descriptorFor>,
): void {
  const positional =
      "positional" in descriptor && typeof descriptor.positional === "string" ? descriptor.positional : null,
    commandPath = "path" in descriptor ? descriptor.path : [],
    syntaxPath = "syntaxPath" in descriptor ? descriptor.syntaxPath : commandPath;
  if ("positionalFields" in descriptor && Array.isArray(descriptor.positionalFields))
    for (const field of descriptor.positionalFields) fields.set(field, { field, type: "string", required: true });
  else if (positional) fields.set(positional, { field: positional, type: "string", required: true });
  for (const token of syntaxPath) {
    const match = token.match(/^(\[)?<([a-z][a-z0-9-]*)>(\])?$/u);
    if (!match) continue;
    const name =
      positional ?? (match[2] === "id" && commandPath[0] ? `${commandPath[0]}Id` : fieldName(`--${match[2]}`));
    if (!fields.has(name)) fields.set(name, { field: name, type: "string", required: !match[1] });
  }
}

function addDefaultFields(
  fields: Map<string, EntityActionInputField>,
  descriptor: ReturnType<typeof descriptorFor>,
): void {
  if (!("actionDefaults" in descriptor) || !descriptor.actionDefaults) return;
  for (const [field, value] of Object.entries(descriptor.actionDefaults)) {
    if (typeof value === "string") fields.set(field, { field, type: "string", required: false, enum: [value] });
    else if (value === null) fields.set(field, { field, type: "string", required: false, wire: { nullable: true } });
    else if (value !== undefined && typeof value === "object" && !Array.isArray(value))
      fields.set(field, { field, type: "json-object", required: false });
    else if (typeof value === "boolean") fields.set(field, { field, type: "boolean", required: false });
  }
}

function inferredField(field: string, value: unknown): EntityActionInputField {
  if (Array.isArray(value)) {
    const item = value.find((candidate) => candidate !== undefined);
    return {
      field,
      type: "string-array",
      required: false,
      ...(item !== undefined && typeof item !== "string" ? { type: "json-object-array" as const } : {}),
    };
  }
  if (value !== null && typeof value === "object") return { field, type: "json-object", required: false };
  if (typeof value === "boolean") return { field, type: "boolean", required: false };
  if (typeof value === "number") return { field, type: "number", required: false };
  return { field, type: "string", required: false };
}

function adaptFieldToValue(field: EntityActionInputField, value: unknown): EntityActionInputField {
  if (!Array.isArray(value)) {
    return value !== null && typeof value === "object" && field.type === "string"
      ? { ...field, type: "json-object" }
      : field;
  }
  const item = value.find((candidate) => candidate !== undefined);
  if (field.type === "string" && (item === undefined || typeof item === "string"))
    return { ...field, type: "string-array" };
  if (
    (field.type === "string" || field.type === "string-array") &&
    item !== undefined &&
    item !== null &&
    typeof item === "object"
  )
    return { ...field, type: "json-object-array" };
  if (field.type === "json-object-array" && (item === undefined || typeof item === "string"))
    return { ...field, type: "string-array" };
  return field;
}

function validationFields(
  descriptor: ReturnType<typeof descriptorFor>,
  source: Action,
): readonly EntityActionInputField[] {
  const fields = new Map<string, EntityActionInputField>(),
    taskAction = generatedTaskActionProtocolDeclarations.find(
      (candidate) => candidate.execution.ingress === descriptor.id,
    );
  for (const field of taskAction?.input.fields ?? [])
    if (!field.cli?.codec)
      fields.set(field.field, {
        field: field.field,
        type: field.type,
        required: field.required,
        ...(field.enum ? { enum: field.enum } : {}),
        ...(field.regex ? { regex: field.regex } : {}),
      });
  for (const input of inputsOf(descriptor) as readonly DeclaredInput[]) {
    const field = validationFieldFromInput(input);
    if (field) fields.set(field.field, field);
    const codec = typeof input.codec === "object" ? input.codec : undefined;
    if (codec && "target" in codec && !fields.has(codec.target))
      fields.set(codec.target, {
        field: codec.target,
        type: codec.kind === "line-list-file" ? "string-array" : "string",
        required: false,
        ...(codec.maxBytes === undefined ? {} : { wire: { maxLength: codec.maxBytes } }),
      });
    addJsonAllowedFields(fields, input, source);
  }
  if ("payloadFields" in descriptor)
    for (const field of descriptor.payloadFields as readonly EntityActionInputField[]) fields.set(field.field, field);
  addPathFields(fields, descriptor);
  addDefaultFields(fields, descriptor);
  return [...fields.values()].filter((field) => !field.wire?.omit);
}

function present(action: Action, field: string, input?: DeclaredInput): boolean {
  if (!Object.hasOwn(action, field) || action[field] === undefined) return false;
  return input?.kind === "repeated" && Array.isArray(action[field]) ? action[field].length > 0 : true;
}

function validateInputs(descriptor: ReturnType<typeof descriptorFor>, original: Action): void {
  const inputs = inputsOf(descriptor) as readonly DeclaredInput[],
    inputForName = (name: string) => inputs.find((candidate) => candidate.name === name),
    fieldForName = (name: string) => declaredField(inputForName(name) ?? ({ name } as DeclaredInput));
  for (const input of inputs) {
    const field = declaredField(input),
      isPresent = present(original, field, input),
      requiredWhen = input.requiredWhen,
      conditionMatches = requiredWhen ? requiredWhen.values.includes(String(original[requiredWhen.field])) : false;
    if (input.required && !isPresent) invalid(`${input.name} is required`);
    if (requiredWhen && conditionMatches && !isPresent) invalid(`${input.name} is required`);
    if (input.allowedWhen && isPresent && !input.allowedWhen.values.includes(String(original[input.allowedWhen.field])))
      invalid(`${input.name} is not allowed for ${input.allowedWhen.field}`);
    if (!isPresent) continue;
    for (const conflict of input.conflictsWith ?? []) {
      const conflictField = fieldForName(conflict);
      if (conflictField !== field && present(original, conflictField, inputForName(conflict)))
        invalid(`${input.name} conflicts with ${conflict}`);
    }
    const hasInput = (name: string) => present(original, fieldForName(name), inputForName(name));
    for (const required of input.requires ?? []) if (!hasInput(required)) invalid(`${input.name} requires ${required}`);
    if (input.requiresAny?.length && !input.requiresAny.some((required) => hasInput(required)))
      invalid(`${input.name} requires one of ${input.requiresAny.join(", ")}`);
  }
  const constraints = ("actionConstraints" in descriptor ? descriptor.actionConstraints : []) as
    | readonly (readonly string[])[]
    | undefined;
  for (const group of constraints ?? []) {
    const selected = group.filter((field) => present(original, field, inputForName(field)));
    if (selected.length !== 1) invalid(`exactly one of ${group.join(", ")} is required`);
  }
}

/** Decode every edge-local Fleet input from the command declaration before it crosses the wire. */
export function serializeFleetAction(command: ThinCommand): Action {
  const descriptor = descriptorFor(command);
  const original = command.action as Action;
  validateInputs(descriptor, original);
  const {
    executor: _executor,
    createMode: _createMode,
    verb: _verb,
    commandType: _commandType,
    ...wireAction
  } = original;
  const action: Action = Object.fromEntries(
    Object.entries(wireAction).filter(([, value]) => value !== undefined),
  ) as Action;
  for (const input of inputsOf(descriptor)) {
    const codec = (typeof input.codec === "object" ? input.codec : undefined) as Codec | undefined;
    if (!codec) continue;
    const sourceField = (input as CliInputFacet & { readonly field?: string }).field ?? fieldName(input.name);
    const source = action[sourceField];
    if (source === undefined) continue;
    delete action[sourceField];
    if (codec.kind === "json-object") {
      const text =
        codec.source === "file"
          ? readUtf8(command.rootDir, String(source), codec.maxBytes, input.name)
          : String(source);
      const packet = parseJson(text, input.name, codec.maxBytes);
      const allowed = input.jsonAllowedFields ?? input.jsonFields ?? [];
      const unsupported = Object.keys(packet).filter((field) => !allowed.includes(field));
      if (unsupported.length) invalid(`${input.name} cannot carry ${unsupported.join(", ")} over the fleet channel.`);
      for (const required of input.jsonFields ?? [])
        if (!Object.hasOwn(packet, required)) invalid(`${input.name} is missing required field ${required}.`);
      Object.assign(action, packet);
      continue;
    }
    const target = codec.target;
    const text = readUtf8(command.rootDir, String(source), codec.maxBytes, input.name);
    action[target] =
      codec.kind === "line-list-file"
        ? text
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0 && !line.startsWith("#"))
        : text;
  }
  const isCenterFleetAction =
    "admission" in descriptor &&
    descriptor.method === "repo.task.run" &&
    descriptor.admission["remote-edge"] === "via-center-forward" &&
    descriptor.path[0] !== "schedule";
  if (isCenterFleetAction) {
    const omitted =
      "payloadFields" in descriptor
        ? (
            descriptor.payloadFields as readonly {
              readonly field: string;
              readonly wire?: { readonly omit?: boolean };
            }[]
          )
            .filter((field) => field.wire?.omit)
            .map((field) => field.field)
        : [];
    const validationAction = omitted.length
      ? Object.fromEntries(Object.entries(action).filter(([field]) => !omitted.includes(field)))
      : action;
    const { kind: _kind, ...payload } = validationAction,
      fields = new Map(validationFields(descriptor, original).map((field) => [field.field, field] as const));
    for (const [field, value] of Object.entries(payload))
      fields.set(field, adaptFieldToValue(fields.get(field) ?? inferredField(field, value), value));
    const issue = fleetActionPayloadIssue([...fields.values()], payload);
    if (issue) invalid(`${issue} does not match its Fleet declaration`);
  }
  return action;
}
