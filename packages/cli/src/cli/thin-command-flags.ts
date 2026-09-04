import { commandDescriptorForAction } from "../../../daemon/src/protocol/daemon-protocol-commands.ts";
import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { ThinCliInput, ThinCliInputDirectory, ThinCommand, ThinParseResult } from "./thin-command-types.ts";
import { renderCliGuidance } from "./guidance-plane.ts";

// The command descriptor is the single authority on which closed task-action method serves a kind;
// parsers that pass no explicit method get the descriptor's routing instead of a hardcoded default.
export function taskActionMethodFor(kind: string): string {
  return commandDescriptorForAction(kind).method;
}

export function optionalFlags(
  values: ReadonlyMap<string, string>,
  mappings: readonly (readonly [string, string])[],
): Record<string, string> {
  return Object.fromEntries(
    mappings.flatMap(([flag, field]) => (values.get(flag) ? [[field, values.get(flag)!]] : [])),
  );
}

export function readFlags(
  commandId: string,
  tokens: readonly string[],
  directory: ThinCliInputDirectory,
):
  | {
      readonly ok: true;
      readonly one: Map<string, string>;
      readonly many: Map<string, string[]>;
      readonly booleans: Set<string>;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly nextAction: string;
      readonly offendingValue?: string;
    } {
  const descriptor = directory.get(commandId)!,
    inputs = descriptor.inputs,
    singles = new Set<string>(),
    repeated = new Set<string>(),
    booleans = new Set<string>(),
    one = new Map<string, string>(),
    many = new Map<string, string[]>(),
    flags = new Set<string>();
  for (const input of inputs)
    (input.kind === "single" ? singles : input.kind === "repeated" ? repeated : booleans).add(input.name);
  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index],
      split = token?.indexOf("=") ?? -1,
      name = split > 0 ? token?.slice(0, split) : token,
      inline = split > 0 ? token?.slice(split + 1) : undefined;
    if (name && booleans.has(name)) {
      if (inline !== undefined)
        return {
          ok: false,
          code: "invalid_field",
          nextAction: renderCliGuidance("flag-value", { name }),
        };
      if (flags.has(name))
        return {
          ok: false,
          code: "duplicate_field",
          nextAction: renderCliGuidance("duplicate-input", { name }),
        };
      flags.add(name);
      index += 1;
      continue;
    }
    const input = inputs.find((candidate) => candidate.name === name),
      value = inline ?? tokens[index + 1];
    if (!input || (!singles.has(input.name) && !repeated.has(input.name)))
      return {
        ok: false,
        code: "unknown_field",
        nextAction: renderCliGuidance("unknown-input", {
          name: name ?? "<missing>",
          helpCommand: descriptor.helpCommand,
        }),
      };
    if (!nonEmpty(value) || (inline === undefined && value.startsWith("--")))
      return { ok: false, code: input.error.code, nextAction: inputGuidance(input, descriptor.helpCommand, true) };
    if (singles.has(input.name)) {
      if (one.has(input.name))
        return {
          ok: false,
          code: "duplicate_field",
          nextAction: renderCliGuidance("duplicate-input", { name: input.name }),
        };
      one.set(input.name, value);
    } else many.set(input.name, [...(many.get(input.name) ?? []), value]);
    index += inline === undefined ? 2 : 1;
  }
  for (const input of inputs) {
    const values =
      input.kind === "single"
        ? one.has(input.name)
          ? [one.get(input.name)!]
          : []
        : input.kind === "repeated"
          ? (many.get(input.name) ?? [])
          : flags.has(input.name)
            ? [input.name]
            : [];
    if (input.required && values.length === 0)
      return { ok: false, code: input.error.code, nextAction: inputGuidance(input, descriptor.helpCommand, true) };
    const relation = values.length > 0 ? inputRelationFailure(input, one, many, flags) : null;
    if (relation) return relation;
    const invalidValue = values.find(
      (value) =>
        (input.enum !== undefined && !input.enum.includes(value)) ||
        (input.regex !== undefined && !new RegExp(input.regex, "u").test(value)),
    );
    if (invalidValue !== undefined)
      return {
        ok: false,
        code: input.error.code,
        nextAction: inputGuidance(input, descriptor.helpCommand, false),
        offendingValue: invalidValue,
      };
  }
  return { ok: true, one, many, booleans: flags };
}

function inputRelationFailure(
  input: ThinCliInput,
  one: ReadonlyMap<string, string>,
  many: ReadonlyMap<string, readonly string[]>,
  booleans: ReadonlySet<string>,
): { readonly ok: false; readonly code: "invalid_field"; readonly nextAction: string } | null {
  const missing = input.requires?.filter((name) => !inputPresent(name, one, many, booleans)) ?? [];
  if (missing.length > 0)
    return { ok: false, code: "invalid_field", nextAction: `${input.name} requires ${missing.join(", ")}.` };
  const conflicts = input.conflictsWith?.filter((name) => inputPresent(name, one, many, booleans)) ?? [];
  if (conflicts.length > 0)
    return {
      ok: false,
      code: "invalid_field",
      nextAction: `${input.name} is mutually exclusive with ${conflicts.join(", ")}.`,
    };
  return null;
}

function inputPresent(
  name: string,
  one: ReadonlyMap<string, string>,
  many: ReadonlyMap<string, readonly string[]>,
  booleans: ReadonlySet<string>,
): boolean {
  return one.has(name) || (many.get(name)?.length ?? 0) > 0 || booleans.has(name);
}

export function rejectInput(
  directory: ThinCliInputDirectory,
  commandId: string,
  name: string,
  json: boolean,
): ThinParseResult {
  const error = directory.get(commandId)?.inputs.find((input) => input.name === name)?.error;
  const descriptor = directory.get(commandId),
    input = descriptor?.inputs.find((candidate) => candidate.name === name);
  return rejected(
    error?.code ?? "invalid_field",
    input
      ? inputGuidance(input, descriptor?.helpCommand ?? `ha ${commandId} --help`, false)
      : renderCliGuidance("invalid-input", { name, helpCommand: `ha ${commandId} --help` }),
    json,
  );
}

function inputGuidance(input: ThinCliInput, helpCommand: string, missing: boolean): string {
  return renderCliGuidance(missing ? "missing-input" : "invalid-input", {
    code: input.error.code,
    name: input.name,
    helpCommand,
    ...(input.enum ? { values: input.enum } : {}),
    ...(input.format ? { format: input.format } : {}),
    ...(input.regex ? { pattern: input.regex } : {}),
  });
}

export function accepted(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  action: ThinCommand["action"],
  method = taskActionMethodFor(action.kind),
): ThinParseResult {
  const normalized =
    action.kind === "agent-create" && !Object.hasOwn(action, "cwd")
      ? { ...action, cwd: { scope: "repo-root" } }
      : action;
  return {
    ok: true,
    command: {
      rootDir,
      ...(repoId ? { repoId } : {}),
      json,
      method,
      action: normalized,
    },
  };
}

export function rejected(code: string, nextAction: string, json: boolean): ThinParseResult {
  return {
    ok: false,
    code,
    nextAction,
    json,
  };
}

export function globalOption(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at < 0 ? undefined : argv[at + 1];
}

export function stripGlobals(argv: readonly string[]): string[] {
  return argv.filter(
    (value, index) =>
      value !== "--json" &&
      !["--root", "--repo"].includes(value) &&
      !["--root", "--repo"].includes(argv[index - 1] ?? ""),
  );
}

export function promptInput(one: ReadonlyMap<string, string>): { readonly prompt: string } | null {
  const prompt = one.get("--prompt");
  return prompt ? { prompt } : null;
}

export function nonEmpty(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function projectionWaitMs(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
