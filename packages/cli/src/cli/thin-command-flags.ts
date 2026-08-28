import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import type { ThinCliInputDirectory, ThinCommand, ThinParseResult } from "./thin-command-types.ts";

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
          nextAction: `${name} is a flag and takes no value.`,
        };
      if (flags.has(name))
        return {
          ok: false,
          code: "duplicate_field",
          nextAction: `${name} may appear once.`,
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
        nextAction: `Unknown option ${name ?? "<missing>"}. Run ${descriptor.helpCommand}.`,
      };
    if (!nonEmpty(value) || (inline === undefined && value.startsWith("--"))) return { ok: false, ...input.error };
    if (singles.has(input.name)) {
      if (one.has(input.name))
        return {
          ok: false,
          code: "duplicate_field",
          nextAction: `${input.name} may appear once.`,
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
    if (input.required && values.length === 0) return { ok: false, ...input.error };
    const invalidValue = values.find(
      (value) =>
        (input.enum !== undefined && !input.enum.includes(value)) ||
        (input.regex !== undefined && !new RegExp(input.regex, "u").test(value)),
    );
    if (invalidValue !== undefined)
      return {
        ok: false,
        code: input.error.code,
        nextAction: input.error.nextAction,
        offendingValue: invalidValue,
      };
  }
  return { ok: true, one, many, booleans: flags };
}

export function rejectInput(
  directory: ThinCliInputDirectory,
  commandId: string,
  name: string,
  json: boolean,
): ThinParseResult {
  const error = directory.get(commandId)?.inputs.find((input) => input.name === name)?.error;
  return rejected(error?.code ?? "invalid_field", error?.nextAction ?? `${name} is invalid.`, json);
}

export function accepted(
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  action: ThinCommand["action"],
  method = "repo.task.run",
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
    nextAction:
      nextAction === "This runtime kind does not accept options for another adapter."
        ? "Claude runtime instances cannot accept Codex options: --effort, --wire-api, " +
          "--requires-openai-auth, or --http-header."
        : nextAction,
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
