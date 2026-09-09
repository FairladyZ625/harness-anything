import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseDecision } from "./thin-command-decision.ts";
import { parseDoc } from "./thin-command-doc.ts";
import { parseFact } from "./thin-command-fact.ts";
import { parseExplain } from "./thin-command-explain.ts";
import { accepted, nonEmpty, readFlags, rejected, rejectInput } from "./thin-command-flags.ts";
import { parsePreset } from "./thin-command-preset.ts";
import { parseProjected, projectFlags } from "./thin-command-projection.ts";
import { parseRuntimeInstance } from "./thin-command-runtime-instance.ts";
import { parseRuntime } from "./thin-command-runtime.ts";
import { parseSchedule } from "./thin-command-schedule.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseRouted(
  route: ProtocolCommand | undefined,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | undefined {
  if (!route) return undefined;
  const rootCommand = route.path[0];
  if (route.id === "repo-bootstrap") return parseBootstrapRouted(args, rootDir, json, inputs);
  if (route.id === "agenda") {
    const f = readFlags(route.id, args.slice(1), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, { kind: "agenda", ...projectFlags(route.id, f) }, route.method)
      : rejected(f.code, f.nextAction, json);
  }
  if (route.id === "migrate-import") {
    const f = readFlags(route.id, args.slice(2), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, {
          kind: "migrate-import",
          sourceRoots: f.many.get("--source") ?? [],
          ...(f.many.get("--resolve")?.length ? { resolutions: f.many.get("--resolve") } : {}),
          ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
        })
      : rejected(f.code, f.nextAction, json);
  }
  if (route.id === "vertical-declaration-migrate")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "vertical-declaration-migrate" })
      : rejected("unknown_field", "ha migrate vertical-declaration takes no options.", json);
  if (route.id === "ledger-reconcile") return parseLedgerReconcileRouted(route, args, rootDir, repoId, json, inputs);
  if (route.id === "explain") return parseExplain(args, rootDir, repoId, json, route.method);
  if (rootCommand === "runtime" && route.path[1] === "instance")
    return parseRuntimeInstance(route, args, rootDir, repoId, json, inputs);
  if (rootCommand === "runtime") return parseRuntime(route, args, rootDir, repoId, json, inputs);
  if (rootCommand === "schedule") return parseSchedule(route, args, rootDir, repoId, json, inputs);
  if (rootCommand === "settings" || rootCommand === "ci")
    return parseProjected(route.id, args.slice(route.path.length), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (rootCommand === "people") return parsePeople(route, args, rootDir, repoId, json, inputs);
  if (route.id === "receipt-show" && nonEmpty(args[2])) {
    const f = readFlags(route.id, args.slice(3), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const wait = f.one.get("--wait"),
      timeout = f.one.get("--timeout-ms");
    if (timeout !== undefined && (!/^[0-9]+$/u.test(timeout) || Number(timeout) > 60_000))
      return rejected("invalid_field", "--timeout-ms must be between 0 and 60000.", json);
    return accepted(
      rootDir,
      repoId,
      json,
      {
        kind: "receipt-show",
        opId: args[2],
        ...(wait ? { waitFor: wait.split(",") } : {}),
        ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
      },
      route.method,
    );
  }
  if (rootCommand === "doc") return parseDoc(route.id, args, rootDir, repoId, json, inputs);
  if (rootCommand === "fact") return parseFact(route.id, args, rootDir, repoId, json, inputs);
  if (rootCommand === "decision") return parseDecision(route, args, rootDir, repoId, json, inputs);
  if (route.id === "distill-candidate" || route.id === "distill-promote")
    return parseProjected(
      route.id,
      args.slice(2),
      rootDir,
      repoId,
      json,
      inputs,
      {},
      route.id === "distill-promote" ? { confidence: "medium", memoryClass: "semantic" } : {},
    );
  if (rootCommand === "relation") return parseRelationRouted(route, args, rootDir, repoId, json, inputs);
  if (rootCommand === "vertical" && args[1] === "entity-kind")
    return parseVerticalKindRouted(route, args, rootDir, repoId, json, inputs);
  if (rootCommand === "entity") return parseEntityRouted(route, args, rootDir, repoId, json, inputs);
  if (route.phase.startsWith("Preset-") || rootCommand === "agent" || rootCommand === "squad")
    return parsePreset(route, args, rootDir, repoId, json, inputs);
  return undefined;
}

function parseBootstrapRouted(
  args: readonly string[],
  rootDir: SafePath,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags("repo-bootstrap", args.slice(1), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const name = f.one.get("--name");
  return accepted(rootDir, undefined, json, {
    kind: "repo-bootstrap",
    ...(f.one.has("--repo-id") ? { repoId: f.one.get("--repo-id") } : {}),
    ...(f.one.has("--person-id") ? { personId: f.one.get("--person-id") } : {}),
    ...(f.one.has("--display-name") ? { displayName: f.one.get("--display-name") } : {}),
    ...(name ? { name } : {}),
    ...(f.booleans.has("--add-npm-scripts") ? { addNpmScripts: true } : {}),
    ...(f.booleans.has("--configure-only") ? { configureOnly: true } : {}),
  });
}

function parseLedgerReconcileRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const f = readFlags(route.id, args.slice(2), inputs);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  const generation = f.one.get("--generation");
  if (generation !== "1") return rejected("invalid_field", "--generation currently requires 1.", json);
  return accepted(rootDir, repoId, json, { kind: "ledger-reconcile", generation: 1 }, route.method);
}

function parseVerticalKindRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const positional = route.id === "vertical-kind-upsert-cli" ? undefined : args[3],
    offset = route.id === "vertical-kind-upsert-cli" ? 3 : 4,
    projected = parseProjected(route.id, args.slice(offset), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (!projected.ok) return projected;
  if (route.id === "vertical-kind-upsert-cli")
    return accepted(rootDir, repoId, json, { ...projected.command.action, kind: "vertical-kind-upsert" });
  const retire = route.id === "vertical-kind-retire-cli";
  return nonEmpty(positional)
    ? accepted(rootDir, repoId, json, {
        ...projected.command.action,
        kind: retire ? "vertical-kind-retire" : "vertical-kind-publish-schema",
        kindId: positional,
      })
    : rejected(
        "missing_field",
        retire
          ? "Use ha vertical entity-kind retire <kind> --reason <reason>."
          : "Use ha vertical entity-kind publish-schema <kind> --from-file <attributes>.",
        json,
      );
}

const peopleRequiredInputs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "people-add": ["--person-id", "--display-name", "--role", "--command-class"],
  "people-set-role": ["--person-id", "--role", "--command-class"],
  "people-bind": ["--actor", "--role", "--target"],
  "people-delegate": ["--token-id", "--runtime-session-id", "--action", "--expires-at"],
  "people-revoke-delegation": ["--token-id"],
  "people-remove": ["--person-id"],
});

function parseEntityRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  if (route.id === "entity-import") return parseEntityImportRouted(route, args, rootDir, repoId, json, inputs);
  if (route.id === "entity-update" || route.id === "entity-archive") {
    const entityKind = args[2],
      projected = parseProjected(route.id, args.slice(3), rootDir, repoId, json, inputs, {}, {}, route.method);
    if (!nonEmpty(entityKind))
      return rejected("missing_field", `Use ha entity ${route.id.slice("entity-".length)} <kind>.`, json);
    if (!projected.ok) return projected;
    return accepted(rootDir, repoId, json, { ...projected.command.action, entityKind });
  }
  const entityKind = args[2],
    f = readFlags(route.id, args.slice(3), inputs);
  if (!nonEmpty(entityKind))
    return rejected("missing_field", `Use ha entity ${route.id.slice("entity-".length)} <kind>.`, json);
  if (!f.ok) return rejected(f.code, f.nextAction, json);
  return accepted(rootDir, repoId, json, {
    kind: route.id,
    entityKind,
    ...(route.id === "entity-get" ? { entityId: f.one.get("--id") } : {}),
  });
}

function parseEntityImportRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const projected = parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (!projected.ok) return projected;
  const action = projected.command.action,
    hasEntityId = typeof action.entityId === "string",
    hasSourceIdentity = typeof action.sourceIdentity === "string";
  return hasEntityId === hasSourceIdentity
    ? projected
    : rejected(
        "invalid_field",
        "Use --entity-id and --source-identity together for an explicit relink, or omit both.",
        json,
      );
}

function parsePeople(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const projected = parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (!projected.ok) return projected;
  const action = projected.command.action,
    fromFile = typeof action.fromFile === "string",
    jsonInput = typeof action.jsonInput === "string",
    directFields = Object.keys(action).filter(
      (field) => field !== "kind" && field !== "fromFile" && field !== "jsonInput",
    );
  if (fromFile && jsonInput)
    return rejected("invalid_field", "Use only one of --from-file <path> or --json-input <json|@->.", json);
  if (fromFile || jsonInput)
    return directFields.length === 0
      ? projected
      : rejected(
          "invalid_field",
          "Use one of --from-file <path> or --json-input <json|@-> by itself, or provide the complete direct flag set.",
          json,
        );
  for (const input of peopleRequiredInputs[route.id] ?? []) {
    const field = input.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());
    if (!Object.hasOwn(action, field)) return rejectInput(inputs, route.id, input, json);
  }
  if (route.id !== "people-add") return projected;
  const credentials = [action.credentialKind, action.credentialIssuer, action.credentialSubject];
  return credentials.some((value) => value !== undefined) && credentials.some((value) => value === undefined)
    ? rejected(
        "invalid_field",
        "Credential kind, issuer, and subject must be supplied together, or all three must be omitted.",
        json,
      )
    : projected;
}

function parseRelationRouted(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | undefined {
  if (route.id === "relation-list") return parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs);
  if (route.id === "relation-relate")
    return normalizeRelationRelateFailure(
      parseProjected(
        route.id,
        args.slice(2),
        rootDir,
        repoId,
        json,
        inputs,
        {},
        { direction: "directed", origin: "declared" },
        route.method,
      ),
      json,
    );
  if (route.id === "relation-unrelate") {
    const relationId = args[2];
    return typeof relationId === "string" && /^rel_[0-9a-f]{16}$/u.test(relationId)
      ? parseProjected(route.id, args.slice(3), rootDir, repoId, json, inputs, { relationId }, {}, route.method)
      : rejected(
          "invalid_field",
          "Use ha relation unrelate rel_<16-hex> --reason <text> --expected-version <n>.",
          json,
        );
  }
  if (route.id === "relation-reconfirm") {
    const relationId = args[2];
    return typeof relationId === "string" && /^rel_[0-9a-f]{16}$/u.test(relationId)
      ? parseProjected(route.id, args.slice(3), rootDir, repoId, json, inputs, { relationId }, {}, route.method)
      : rejected(
          "invalid_field",
          "Use ha relation reconfirm rel_<16-hex> --expected-version <n> --rationale <text>.",
          json,
        );
  }
  return undefined;
}

function normalizeRelationRelateFailure(result: ThinParseResult, json: boolean): ThinParseResult {
  if (result.ok || result.code !== "invalid_field") return result;
  if (result.nextAction.startsWith("--expected-version is required."))
    return rejected(
      "missing_field",
      "Add --expected-version 0 when creating a new Relation, then rerun the command.",
      json,
    );
  return result.nextAction.startsWith("--rationale is required.")
    ? rejected("missing_field", "Add --rationale <why>, then rerun the command.", json)
    : result;
}
