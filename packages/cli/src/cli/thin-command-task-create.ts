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
    structured = [f.one.get("--from-file"), f.one.get("--json-input")].filter(Boolean);
  if (
    (!title && !structured.length) ||
    (id && modes.length !== 1) ||
    (!id && modes.length > 0) ||
    structured.length > 1
  )
    return rejectInput(
      inputs,
      route.id,
      !title && !structured.length ? "--title" : id || modes.length ? "--id" : "--json-input",
      json,
    );
  const declared = Object.fromEntries(
      (route.inputs as readonly (ThinCliInput & { readonly field?: string })[]).flatMap((input) => {
        const value = input.kind === "single" && input.field ? f.one.get(input.name) : undefined;
        return value ? [[input.field!, input.projection === "number" ? Number(value) : value]] : [];
      }),
    ),
    { title: _title, taskId: _taskId, ...forwarded } = declared;
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
      // `ha work create` is task-create fixed to the create-work preset and the declared work class.
      ...(route.id === "work-create" ? { presetId: "create-work", taskClass: "work" } : {}),
      ...(f.many.get("--surface")?.length ? { surfaces: f.many.get("--surface") } : {}),
      ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
    },
    route.method,
  );
}
