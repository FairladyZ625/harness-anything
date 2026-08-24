import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  nonEmpty,
  promptInput,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import { parseTaskCreate } from "./thin-command-task-create.ts";
import type {
  ProtocolCommand,
  ThinCliInput,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parsePreset(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (route.id === "task-create")
    return parseTaskCreate(route, args, rootDir, repoId, json, inputs);
  if (route.id === "squad-run") {
    const squadId = args[2],
      f = readFlags(route.id, args.slice(3), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    if (!nonEmpty(squadId))
      return rejected("missing_field", "squad id is required.", json);
    if (!f.one.has("--cwd"))
      return rejected(
        "missing_field",
        "Add --cwd <repository-relative-directory> to declare the Squad write boundary.",
        json,
      );
    const prompt = promptInput(f.one);
    if (!prompt)
      return rejectInput(
        inputs,
        route.id,
        f.one.has("--prompt") ? "--prompt-file" : "--prompt",
        json,
      );
    return accepted(
      rootDir,
      repoId,
      json,
      {
        kind: "squad-run",
        squadId,
        runtimeInstanceId: f.one.get("--instance"),
        ...prompt,
        ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
        ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
        cwd:
          f.one.get("--cwd") !== "."
            ? { scope: "repo-relative", path: f.one.get("--cwd") }
            : { scope: "repo-root" },
        taskId: f.one.get("--task"),
      },
      route.method,
    );
  }
  const positionalField = "positional" in route ? route.positional : undefined,
    positionalFields =
      "positionalFields" in route ? route.positionalFields : undefined,
    positional = positionalField ? args[route.path.length] : undefined,
    offset = route.path.length + (positionalField ? 1 : 0),
    f = readFlags(route.id, args.slice(offset), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (positionalField && !nonEmpty(positional))
    return rejected("missing_field", `${positionalField} is required.`, json);
  const matched =
      positionalFields && positional
        ? /^preset:([a-z0-9][a-z0-9-]{0,127})\/([A-Za-z0-9._-]+)$/u.exec(
            positional,
          )
        : null,
    positionalRegex =
      "positionalRegex" in route ? route.positionalRegex : undefined;
  if (
    (positionalFields && !matched) ||
    (positional &&
      positionalRegex &&
      !new RegExp(positionalRegex, "u").test(positional))
  )
    return rejected(
      "invalid_field",
      positionalFields
        ? "Use preset:<id>/<entrypoint>."
        : `Invalid ${positionalField}.`,
      json,
    );
  let payload: Record<string, unknown>;
  const declared = route.inputs as readonly (ThinCliInput & {
    readonly field: string;
    readonly codec?: "json";
  })[];
  try {
    payload = Object.fromEntries(
      declared.flatMap((input) => {
        if (input.kind === "boolean")
          return f.booleans.has(input.name) ? [[input.field, true]] : [];
        const value = f.one.get(input.name);
        return value
          ? [[input.field, input.codec === "json" ? JSON.parse(value) : value]]
          : [];
      }),
    );
  } catch {
    return rejectInput(inputs, route.id, "--inputs", json);
  }
  const position =
      matched && positionalFields
        ? {
            [positionalFields[0]]: matched[1],
            [positionalFields[1]]: matched[2],
          }
        : positionalField
          ? { [positionalField]: positional }
          : {},
    defaults = "actionDefaults" in route ? route.actionDefaults : {};
  return accepted(
    rootDir,
    repoId,
    json,
    { ...defaults, kind: route.id, ...position, ...payload },
    route.method,
  );
}
