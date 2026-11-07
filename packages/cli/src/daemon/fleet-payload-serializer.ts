import { readFileSync } from "node:fs";
import path from "node:path";
import { commandDescriptorForAction } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import type { CliInputFacet } from "@harness-anything/preset/internal/preset-command-contract";
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

function validateInputs(descriptor: ReturnType<typeof descriptorFor>, original: Action): void {
  for (const input of inputsOf(descriptor)) {
    const field = (input as CliInputFacet & { readonly field?: string }).field ?? fieldName(input.name);
    if (!Object.hasOwn(original, field)) continue;
    for (const conflict of input.conflictsWith ?? []) {
      const conflictInput = inputsOf(descriptor).find((candidate) => candidate.name === conflict);
      const conflictField =
        (conflictInput as (CliInputFacet & { readonly field?: string }) | undefined)?.field ?? fieldName(conflict);
      if (conflictField !== field && Object.hasOwn(original, conflictField))
        invalid(`${input.name} conflicts with ${conflict}`);
    }
    const hasInput = (name: string) => {
      const requiredInput = inputsOf(descriptor).find((candidate) => candidate.name === name);
      const requiredField =
        (requiredInput as (CliInputFacet & { readonly field?: string }) | undefined)?.field ?? fieldName(name);
      return Object.hasOwn(original, requiredField);
    };
    for (const required of input.requires ?? []) if (!hasInput(required)) invalid(`${input.name} requires ${required}`);
    if (input.requiresAny?.length && !input.requiresAny.some((required) => hasInput(required)))
      invalid(`${input.name} requires one of ${input.requiresAny.join(", ")}`);
  }
}

function validateDeclaredTypes(descriptor: ReturnType<typeof descriptorFor>, action: Action): void {
  if (!("payloadFields" in descriptor)) return;
  for (const field of descriptor.payloadFields as readonly {
    readonly field: string;
    readonly type?: string;
    readonly wire?: { readonly maxLength?: number };
  }[]) {
    if (!Object.hasOwn(action, field.field)) continue;
    const value = action[field.field];
    const valid =
      field.type === "string"
        ? typeof value === "string"
        : field.type === "number"
          ? typeof value === "number" && Number.isSafeInteger(value)
          : field.type === "boolean"
            ? typeof value === "boolean"
            : field.type === "string-array"
              ? Array.isArray(value) && value.every((item) => typeof item === "string")
              : field.type === "json-object"
                ? value !== null && typeof value === "object" && !Array.isArray(value)
                : field.type === "json-object-array"
                  ? Array.isArray(value) && value.every((item) => item !== null && typeof item === "object")
                  : true;
    if (!valid) invalid(`action field ${field.field} does not match its declared type`);
    if (typeof value === "string" && field.wire?.maxLength !== undefined && value.length > field.wire.maxLength)
      invalid(`action field ${field.field} exceeds its declared size limit`);
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
  const action: Action = { ...wireAction };
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
  validateDeclaredTypes(descriptor, action);
  // Packet fields are closed-world validated above. The remaining action fields are already
  // produced by the parser/entity declaration (including positional and derived policy fields).
  return action;
}
