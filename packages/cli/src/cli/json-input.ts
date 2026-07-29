import { readFileSync } from "node:fs";
import path from "node:path";
import { commandDescriptors, type CommandDescriptor } from "./command-registry.ts";
import { commandInputDescriptorFor, commandPath, type JsonSchemaType } from "./command-input-descriptors.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

type JsonObject = Record<string, unknown>;

export interface CommandJsonInput {
  readonly commandKind: CommandDescriptor["kind"];
  readonly payload: Readonly<JsonObject>;
}

export function applyJsonInputLayer(
  args: ReadonlyArray<string>,
  cwd: string
): { readonly ok: true; readonly args: ReadonlyArray<string>; readonly input?: CommandJsonInput } | { readonly ok: false; readonly error: CliResult["error"] } {
  const extracted = extractJsonInput(args, cwd);
  if (!extracted.ok) return extracted;
  if (!extracted.payload) return { ok: true, args: extracted.args };
  const descriptor = findDescriptorForArgs(extracted.args);
  if (!descriptor) {
    return {
      ok: false,
      error: cliError(CliErrorCode.InvalidJsonInput, "--json-input and --from-file require a known command before the input flags.")
    };
  }
  const typeIssue = findJsonTypeIssue(extracted.payload, commandInputDescriptorFor(descriptor).input.properties);
  if (typeIssue) {
    return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, typeIssue) };
  }
  return {
    ok: true,
    args: extracted.args,
    input: { commandKind: descriptor.kind, payload: extracted.payload }
  };
}

function extractJsonInput(
  args: ReadonlyArray<string>,
  cwd: string
): { readonly ok: true; readonly args: ReadonlyArray<string>; readonly payload?: JsonObject } | { readonly ok: false; readonly error: CliResult["error"] } {
  const inline = readFlagValue(args, "--json-input");
  const file = readFlagValue(args, "--from-file");
  if (inline !== undefined && file !== undefined) {
    return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, "Use only one of --json-input or --from-file.") };
  }
  const stripped = stripInputFlags(args);
  if (inline === undefined && file === undefined) return { ok: true, args: stripped };
  const raw = inline ?? readInputFile(String(file), cwd);
  if (raw instanceof Error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, raw.message) };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, "JSON command input must be an object.") };
    }
    return { ok: true, args: stripped, payload: parsed as JsonObject };
  } catch (error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidJsonInput, `JSON command input could not be parsed: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

function readInputFile(filePath: string, cwd: string): string | Error {
  if (!filePath || filePath.startsWith("--")) return new Error("Use --from-file <path>.");
  try {
    return readFileSync(path.resolve(cwd, filePath), "utf8");
  } catch (error) {
    return new Error(`Could not read JSON input file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readFlagValue(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

function stripInputFlags(args: ReadonlyArray<string>): ReadonlyArray<string> {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--json-input" || token === "--from-file") {
      index += 1;
      continue;
    }
    stripped.push(token);
  }
  return stripped;
}

function findDescriptorForArgs(args: ReadonlyArray<string>): CommandDescriptor | undefined {
  const matches = commandDescriptors
    .map((descriptor) => ({ descriptor, path: commandPath(descriptor) }))
    .filter((entry) => entry.path.length > 0 && entry.path.every((token, index) => args[index] === token))
    .sort((left, right) => right.path.length - left.path.length);
  return matches[0]?.descriptor;
}

interface JsonPropertyShape {
  readonly type: JsonSchemaType | ReadonlyArray<JsonSchemaType>;
  readonly maxItems?: number;
  readonly maxLength?: number;
  readonly items?: { readonly type: JsonSchemaType; readonly maxLength?: number } | { readonly type: "object"; readonly properties: Record<string, unknown> };
}

function findJsonTypeIssue(payload: JsonObject, properties: Readonly<Record<string, JsonPropertyShape>>): string | undefined {
  for (const [key, value] of Object.entries(payload)) {
    const property = properties[key];
    if (!property || value === undefined) continue;
    const allowed = Array.isArray(property.type) ? property.type : [property.type];
    const actual = jsonType(value);
    if (!allowed.includes(actual as JsonSchemaType)) {
      return `JSON command input field ${key} must be ${allowed.join(" or ")}; received ${actual}.`;
    }
    if (actual === "string" && property.maxLength !== undefined && [...String(value)].length > property.maxLength) {
      return `JSON command input field ${key} must be at most ${property.maxLength} characters.`;
    }
    if (actual === "array" && property.maxItems !== undefined && (value as ReadonlyArray<unknown>).length > property.maxItems) {
      return `JSON command input field ${key} must contain at most ${property.maxItems} items.`;
    }
    if (actual === "array" && property.items) {
      const itemType = property.items.type;
      const invalidIndex = (value as ReadonlyArray<unknown>).findIndex((item) => jsonType(item) !== itemType);
      if (invalidIndex >= 0) {
        return `JSON command input field ${key}[${invalidIndex}] must be ${itemType}; received ${jsonType((value as ReadonlyArray<unknown>)[invalidIndex])}.`;
      }
      if (itemType === "string" && "maxLength" in property.items && property.items.maxLength !== undefined) {
        const itemMaxLength = property.items.maxLength;
        const overlongIndex = (value as ReadonlyArray<unknown>)
          .findIndex((item) => [...String(item)].length > itemMaxLength);
        if (overlongIndex >= 0) {
          return `JSON command input field ${key}[${overlongIndex}] must be at most ${itemMaxLength} characters.`;
        }
      }
    }
  }
  return undefined;
}

function jsonType(value: unknown): JsonSchemaType | "null" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  if (typeof value === "boolean") return "boolean";
  return "object";
}
