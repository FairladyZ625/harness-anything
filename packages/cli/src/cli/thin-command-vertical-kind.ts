import { readFileSync } from "node:fs";
import path from "node:path";
import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

const kindDeclarationHint = "--from-file must contain one complete Artifact kind declaration.";

type ParsedObject = { readonly value: Record<string, unknown> } | { readonly failure: ThinParseResult };

/**
 * `ha vertical kind ...` is a thin projection of the GUI's `repo.vertical.kind.*` actions. The
 * declaration file is read here rather than forwarded as a path: the daemon receives the same
 * object the GUI submits, so there is one interpretation of a Kind and one write path.
 *
 * The command is recognised by the contract's own `path` ([vertical, kind, <verb>]) rather than a
 * copied id list, and `ha vertical validate` shares the `vertical` root but is a preset command, so
 * anything that is not a kind verb falls through to the preset parser instead of being read as a
 * malformed kind command.
 */
export function parseVerticalKindRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | undefined {
  if (route.path[0] !== "vertical" || route.path[1] !== "kind") return undefined;
  const verb = route.path[2];
  if (verb === "list" || verb === "show") return parseRead(route, args, rootDir, repoId, json, inputs);
  if (verb === "upsert") return parseUpsert(route, args, rootDir, repoId, json, inputs);
  if (verb === "publish-schema") return parsePublishSchema(route, args, rootDir, repoId, json, inputs);
  if (verb === "retire") return parseRetire(route, args, rootDir, repoId, json, inputs);
  return undefined;
}

function parseRead(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.id === "vertical-kind-show" ? args[3] : undefined;
  if (route.id === "vertical-kind-show" && (!nonEmpty(kind) || kind.startsWith("--")))
    return rejected("missing_field", "Use ha vertical kind show <kind>.", json);
  const flags = readFlags(route.id, args.slice(kind === undefined ? 3 : 4), inputs);
  if (!flags.ok) return rejected(flags.code, flags.nextAction, json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      ...(kind === undefined ? {} : { kindId: kind }),
      ...(flags.booleans.has("--include-retired") ? { includeRetired: true } : {}),
    },
    route.method,
  );
}

function parseUpsert(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const flags = readFlags(route.id, args.slice(3), inputs);
  if (!flags.ok) return normalizeVersionFailure(flags, json);
  const declaration = declarationFrom(flags, rootDir, json);
  if ("failure" in declaration) return declaration.failure;
  const declaredKindId = declaration.value.kindId,
    declaredId = declaration.value.id,
    kindId = flags.one.get("--kind") ?? (typeof declaredKindId === "string" ? declaredKindId : declaredId);
  if (typeof kindId !== "string" || kindId.trim() === "")
    return rejected(
      "missing_field",
      "The declaration needs an `id` (or pass --kind <kindId>) so the Kind can be addressed.",
      json,
    );
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      kindId: kindId.trim(),
      declaration: declaration.value,
      expectedVersion: Number(flags.one.get("--expected-version")),
    },
    route.method,
  );
}

function parsePublishSchema(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kindId = args[3];
  if (!nonEmpty(kindId) || kindId.startsWith("--"))
    return rejected("missing_field", "Use ha vertical kind publish-schema <kind> --attributes <json>.", json);
  const flags = readFlags(route.id, args.slice(4), inputs);
  if (!flags.ok) return normalizeVersionFailure(flags, json);
  const attributes = parseJsonObject(flags.one.get("--attributes")!, "--attributes", json);
  if ("failure" in attributes) return attributes.failure;
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      kindId,
      attributes: attributes.value,
      expectedVersion: Number(flags.one.get("--expected-version")),
    },
    route.method,
  );
}

function parseRetire(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kindId = args[3];
  if (!nonEmpty(kindId) || kindId.startsWith("--"))
    return rejected("missing_field", "Use ha vertical kind retire <kind> --reason <text>.", json);
  const flags = readFlags(route.id, args.slice(4), inputs);
  if (!flags.ok) return normalizeVersionFailure(flags, json);
  return accepted(
    rootDir,
    repoId,
    json,
    {
      kind: route.id,
      kindId,
      reason: flags.one.get("--reason"),
      expectedVersion: Number(flags.one.get("--expected-version")),
    },
    route.method,
  );
}

/**
 * `--expected-version 0` is the create intent; every other value is the Kind's own accepted
 * revision. Naming the repair here keeps a missing fence from reading like a malformed command.
 */
function normalizeVersionFailure(
  flags: Extract<ReturnType<typeof readFlags>, { readonly ok: false }>,
  json: boolean,
): ThinParseResult {
  return flags.nextAction.startsWith("--expected-version is required.")
    ? rejected(
        "missing_field",
        "Add --expected-version 0 when creating a new Kind, or the revision `ha vertical kind show <kind>` reports for an existing one.",
        json,
      )
    : rejected(flags.code, flags.nextAction, json);
}

function declarationFrom(
  flags: Extract<ReturnType<typeof readFlags>, { readonly ok: true }>,
  rootDir: SafePath,
  json: boolean,
): ParsedObject {
  const inline = flags.one.get("--declaration"),
    fromFile = flags.one.get("--from-file");
  if (inline === undefined && fromFile === undefined)
    return {
      failure: rejected(
        "missing_field",
        "Provide --from-file <path> or --declaration <json> with one complete Artifact kind declaration.",
        json,
      ),
    };
  let text = inline;
  if (fromFile !== undefined) {
    try {
      text = readFileSync(path.resolve(rootDir, fromFile), "utf8");
    } catch (error) {
      return {
        failure: rejected(
          "invalid_field",
          `--from-file ${fromFile} could not be read: ${error instanceof Error ? error.message : String(error)}. ${kindDeclarationHint}`,
          json,
        ),
      };
    }
  }
  return parseJsonObject(text!, fromFile === undefined ? "--declaration" : "--from-file", json);
}

function parseJsonObject(text: string, flag: string, json: boolean): ParsedObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      failure: rejected(
        "invalid_field",
        flag === "--from-file" ? kindDeclarationHint : `${flag} must be one JSON object.`,
        json,
      ),
    };
  }
  return isRecord(parsed)
    ? { value: parsed }
    : { failure: rejected("invalid_field", `${flag} must be one JSON object.`, json) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
