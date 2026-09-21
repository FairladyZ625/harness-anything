import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, readFlags, rejectInput, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInput, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseTaskCreate(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags(route.id, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const title = f.one.get("--title"),
    id = f.one.get("--id"),
    modes = ["migration", "import", "admin"].filter((mode) => f.booleans.has(`--${mode}`)),
    structured = [f.one.get("--from-file"), f.one.get("--json-input")].filter(Boolean),
    moduleNames = ["--register-module", "--module-title", "--module-prefix", "--module-scope"],
    moduleFields = moduleNames.map((name) => f.one.get(name)),
    moduleCount = moduleFields.filter(Boolean).length;
  if (
    (!title && !structured.length) ||
    (id && modes.length !== 1) ||
    (!id && modes.length > 0) ||
    structured.length > 1 ||
    (moduleCount !== 0 && moduleCount !== moduleFields.length) ||
    (moduleCount === moduleFields.length && f.one.get("--module") && f.one.get("--module") !== moduleFields[0])
  )
    return rejectInput(
      inputs,
      route.id,
      !title && !structured.length
        ? "--title"
        : id || modes.length
          ? "--id"
          : structured.length > 1
            ? "--json-input"
            : "--register-module",
      json,
    );
  const declared = Object.fromEntries(
      (route.inputs as readonly (ThinCliInput & { readonly field?: string })[]).flatMap((input) => {
        const value = input.kind === "single" && input.field ? f.one.get(input.name) : undefined;
        return value ? [[input.field!, input.projection === "number" ? Number(value) : value]] : [];
      }),
    ),
    {
      title: _title,
      taskId: _taskId,
      registerModuleKey: _registerModuleKey,
      moduleTitle: _moduleTitle,
      modulePrefix: _modulePrefix,
      moduleScope: _moduleScope,
      ...forwarded
    } = declared;
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "task-create",
      ...(title ? { title } : {}),
      ...(id ? { taskId: id } : {}),
      ...(id ? { createMode: modes[0] } : {}),
      ...forwarded,
      ...(moduleCount
        ? {
            registerModule: {
              key: moduleFields[0],
              title: moduleFields[1],
              prefix: moduleFields[2],
              scope: moduleFields[3],
            },
            moduleKey: moduleFields[0],
          }
        : {}),
      ...(f.many.get("--surface")?.length ? { surfaces: f.many.get("--surface") } : {}),
      ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
    },
    route.method,
  );
}

export function parseSubtaskCreate(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags(route.id, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const parent = f.one.get("--parent"),
    title = f.one.get("--title");
  if (!parent) return rejectInput(inputs, route.id, "--parent", json);
  if (!title) return rejectInput(inputs, route.id, "--title", json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: "task-create",
      title,
      parentTaskId: parent,
      // The subtask shortcut defaults to the preset-declared lightweight profile; the daemon
      // resolves it against the repository default preset and rejects if that preset has none.
      profileId: f.one.get("--profile") ?? "lightweight",
      ...Object.fromEntries(
        (route.inputs as readonly (ThinCliInput & { readonly field?: string })[]).flatMap((input) => {
          if (!input.field || ["title", "parentTaskId", "profileId", "dryRun"].includes(input.field)) return [];
          const value = input.kind === "single" ? f.one.get(input.name) : undefined;
          return value ? [[input.field, value]] : [];
        }),
      ),
      ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
    },
    route.method,
  );
}
