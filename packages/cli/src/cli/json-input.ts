import { readFileSync } from "node:fs";
import path from "node:path";
import { commandDescriptors, type CommandDescriptor } from "./command-registry.ts";
import { commandInputDescriptorFor, commandPath, type CommandInputShortcut } from "./command-input-descriptors.ts";
import { cliError, CliErrorCode } from "./error-codes.ts";
import type { CliResult } from "./types.ts";

type JsonObject = Record<string, unknown>;

export function applyJsonInputLayer(
  args: ReadonlyArray<string>,
  cwd: string
): { readonly ok: true; readonly args: ReadonlyArray<string> } | { readonly ok: false; readonly error: CliResult["error"] } {
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
  const injected = jsonPayloadToArgs(descriptor, extracted.payload);
  return { ok: true, args: [...extracted.args, ...injected] };
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

function jsonPayloadToArgs(command: CommandDescriptor, payload: JsonObject): ReadonlyArray<string> {
  const input = commandInputDescriptorFor(command);
  const args: string[] = [];
  for (const shortcut of input.shortcuts) {
    const values = valuesForShortcut(payload, shortcut);
    for (const value of values) {
      if (typeof value === "boolean") {
        if (value) args.push(shortcut.flag);
        continue;
      }
      args.push(shortcut.flag, String(value));
    }
  }
  return args;
}

function valuesForShortcut(payload: JsonObject, shortcut: CommandInputShortcut): ReadonlyArray<string | number | boolean> {
  const pathKey = shortcut.path.replace(/^\$\./u, "");
  const value = valueAtPath(payload, pathKey);
  if (shortcut.flag === "--why-not" && value === undefined) return rejectedWhyNot(payload);
  if (value === undefined || value === null) return [];
  if (shortcut.flag === "--chosen" || shortcut.flag === "--rejected") return firstTextValue(value);
  if (shortcut.flag === "--claim") return claimValues(value);
  if (shortcut.flag === "--evidence-relation") return evidenceRelationValues(value);
  if (Array.isArray(value)) {
    if (shortcut.flag === "--module" || shortcut.flag === "--product-line") return [value.map(stringValue).filter(Boolean).join(",")].filter(Boolean);
    return value.map(stringValue).filter(Boolean);
  }
  if (typeof value === "object") return [JSON.stringify(value)];
  return [value as string | number | boolean];
}

function claimValues(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { readonly id?: unknown; readonly text?: unknown; readonly load_bearing?: unknown };
    if (typeof candidate.text !== "string") return [];
    return [JSON.stringify({
      ...(typeof candidate.id === "string" ? { id: candidate.id } : {}),
      text: candidate.text,
      ...(typeof candidate.load_bearing === "boolean" ? { load_bearing: candidate.load_bearing } : {})
    })];
  });
}

function valueAtPath(payload: JsonObject, pathKey: string): unknown {
  const parts = pathKey.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function firstTextValue(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  const first = value[0];
  if (typeof first === "string") return [first];
  if (first && typeof first === "object" && typeof (first as { readonly text?: unknown }).text === "string") return [(first as { readonly text: string }).text];
  return [];
}

function rejectedWhyNot(payload: JsonObject): ReadonlyArray<string> {
  const rejected = payload.rejected;
  if (!Array.isArray(rejected)) return [];
  const first = rejected[0];
  return first && typeof first === "object" && typeof (first as { readonly whyNot?: unknown }).whyNot === "string"
    ? [(first as { readonly whyNot: string }).whyNot]
    : [];
}

function evidenceRelationValues(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const candidate = entry as { readonly anchor?: unknown; readonly type?: unknown; readonly target?: unknown; readonly rationale?: unknown };
    return typeof candidate.anchor === "string" && typeof candidate.type === "string" && typeof candidate.target === "string" && typeof candidate.rationale === "string"
      ? [`${candidate.anchor}:${candidate.type}:${candidate.target}:${candidate.rationale}`]
      : [];
  });
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
