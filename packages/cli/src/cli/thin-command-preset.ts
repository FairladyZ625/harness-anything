import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { accepted, nonEmpty, promptInput, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import { projectFlags } from "./thin-command-projection.ts";
import { parseTaskCreate } from "./thin-command-task-create.ts";
import type { ProtocolCommand, ThinCliInput, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parsePreset(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (route.id === "task-create") return parseTaskCreate(route, args, rootDir, repoId, json, inputs);
  if (route.id === "squad-run") {
    const squadId = args[2],
      f = readFlags(route.id, args.slice(3), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    if (!nonEmpty(squadId)) return rejected("missing_field", "squad id is required.", json);
    const prompt = promptInput(f.one);
    return accepted(
      rootDir,
      repoId,
      json,
      {
        kind: "squad-run",
        squadId,
        runtimeInstanceId: f.one.get("--instance"),
        ...(prompt ?? {}),
        ...(f.one.get("--effort") ? { effort: f.one.get("--effort") } : {}),
        ...(f.one.get("--model") ? { model: f.one.get("--model") } : {}),
        ...(f.one.get("--permission-mode") ? { permissionMode: f.one.get("--permission-mode") } : {}),
        cwd:
          f.one.get("--cwd") && f.one.get("--cwd") !== "."
            ? { scope: "repo-relative", path: f.one.get("--cwd") }
            : { scope: "repo-root" },
        taskId: f.one.get("--task"),
        ...(f.booleans.has("--detach") ? { detach: true } : {}),
      },
      route.method,
    );
  }
  if (route.id === "squad-status") {
    const squadRunId = args[2];
    return nonEmpty(squadRunId)
      ? accepted(rootDir, repoId, json, { kind: "squad-status", squadRunId }, route.method)
      : rejected("missing_field", "squad run id is required.", json);
  }
  const positionalField = "positional" in route ? route.positional : undefined,
    positionalFields = "positionalFields" in route ? route.positionalFields : undefined,
    positional = positionalField ? args[route.path.length] : undefined,
    offset = route.path.length + (positionalField ? 1 : 0),
    f = readFlags(route.id, args.slice(offset), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  if (positionalField && !nonEmpty(positional))
    return rejected("missing_field", `${positionalField} is required.`, json);
  const matched =
      positionalFields && positional
        ? /^preset:([a-z0-9][a-z0-9-]{0,127})\/([A-Za-z0-9._-]+)$/u.exec(positional)
        : null,
    positionalRegex = "positionalRegex" in route ? route.positionalRegex : undefined;
  if (
    (positionalFields && !matched) ||
    (positional && positionalRegex && !new RegExp(positionalRegex, "u").test(positional))
  )
    return rejected(
      "invalid_field",
      positionalFields ? "Use preset:<id>/<entrypoint>." : `Invalid ${positionalField}.`,
      json,
    );
  const payload: Record<string, unknown> = { ...projectFlags(route.id, f, inputs) };
  for (const input of route.inputs as readonly (ThinCliInput & { readonly field: string; readonly codec?: "json" })[])
    if (input.codec === "json" && typeof payload[input.field] === "string")
      try {
        payload[input.field] = JSON.parse(payload[input.field] as string);
      } catch {
        return rejectInput(inputs, route.id, input.name, json);
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
  return accepted(rootDir, repoId, json, { ...defaults, kind: route.id, ...position, ...payload }, route.method);
}
