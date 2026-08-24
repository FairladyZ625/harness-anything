import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  accepted,
  readFlags,
  rejectInput,
  rejected,
} from "./thin-command-flags.ts";
import type {
  ProtocolCommand,
  ThinCliInput,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

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
    fromLegacy = f.one.get("--from-legacy"),
    modes = ["migration", "import", "admin"].filter((mode) =>
      f.booleans.has(`--${mode}`),
    ),
    structured = [f.one.get("--from-file"), f.one.get("--json-input")].filter(
      Boolean,
    ),
    moduleNames = [
      "--register-module",
      "--module-title",
      "--module-prefix",
      "--module-scope",
    ],
    moduleFields = moduleNames.map((name) => f.one.get(name)),
    moduleCount = moduleFields.filter(Boolean).length;
  if (
    (!title && !structured.length && !fromLegacy) ||
    (id && modes.length !== 1) ||
    (!id && modes.length > 0) ||
    structured.length > 1 ||
    (moduleCount !== 0 && moduleCount !== moduleFields.length) ||
    (moduleCount === moduleFields.length &&
      f.one.get("--module") &&
      f.one.get("--module") !== moduleFields[0])
  )
    return rejectInput(
      inputs,
      route.id,
      !title && !structured.length && !fromLegacy
        ? "--title"
        : id || modes.length
          ? "--id"
          : structured.length > 1
            ? "--json-input"
            : "--register-module",
      json,
    );
  const relation = (f.many.get("--relation") ?? []).map((value) => {
      const first = value.indexOf(":"),
        second = value.indexOf(":", first + 1);
      return {
        type: value.slice(0, first),
        target: value.slice(first + 1, second),
        rationale: value.slice(second + 1),
      };
    }),
    declared = Object.fromEntries(
      (
        route.inputs as readonly (ThinCliInput & { readonly field?: string })[]
      ).flatMap((input) => {
        const value =
          input.kind === "single" && input.field
            ? f.one.get(input.name)
            : undefined;
        return value ? [[input.field!, value]] : [];
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
      ...(f.many.get("--surface")?.length
        ? { surfaces: f.many.get("--surface") }
        : {}),
      ...(relation.length ? { relations: relation } : {}),
      ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
    },
    route.method,
  );
}
