import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseDecision } from "./thin-command-decision.ts";
import { parseDoc } from "./thin-command-doc.ts";
import { parseFact } from "./thin-command-fact.ts";
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
  if (route.id === "repo-bootstrap") {
    const f = readFlags(route.id, args.slice(1), inputs);
    if (!f.ok) return rejected(f.code, f.nextAction, json);
    const name = f.one.get("--name");
    return accepted(rootDir, undefined, json, {
      kind: "repo-bootstrap",
      repoId: f.one.get("--repo-id"),
      personId: f.one.get("--person-id"),
      displayName: f.one.get("--display-name"),
      ...(name ? { name } : {}),
      ...(f.booleans.has("--add-npm-scripts") ? { addNpmScripts: true } : {}),
      ...(f.booleans.has("--configure-only") ? { configureOnly: true } : {}),
    });
  }
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
  if (route.id === "fact-rekey") {
    const f = readFlags(route.id, args.slice(2), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, {
          kind: "fact-rekey",
          ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
        })
      : rejected(f.code, f.nextAction, json);
  }
  if (route.id === "ledger-migrate")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "ledger-migrate" })
      : rejected("unknown_field", "ha ledger migrate takes no options.", json);
  if (route.id.startsWith("runtime-instance-")) return parseRuntimeInstance(route, args, rootDir, repoId, json, inputs);
  if (route.id.startsWith("runtime-")) return parseRuntime(route, args, rootDir, repoId, json, inputs);
  if (route.id.startsWith("schedule-")) return parseSchedule(route, args, rootDir, repoId, json, inputs);
  if (route.id.startsWith("settings-"))
    return parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (route.id.startsWith("people-")) return parsePeople(route, args, rootDir, repoId, json, inputs);
  if (route.id === "ci-observe-pull")
    return parseProjected(route.id, args.slice(3), rootDir, repoId, json, inputs, {}, {}, route.method);
  if (route.id === "receipt-show" && nonEmpty(args[2]) && args.length === 3)
    return accepted(rootDir, repoId, json, {
      kind: "receipt-show",
      opId: args[2],
    });
  if (route.id.startsWith("doc-")) return parseDoc(route.id, args, rootDir, repoId, json, inputs);
  if (route.id.startsWith("fact-")) return parseFact(route.id, args, rootDir, repoId, json, inputs);
  if (route.id.startsWith("decision-")) return parseDecision(route.id, args, rootDir, repoId, json, inputs);
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
  if (route.id === "relation-list") return parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs);
  if (route.id.startsWith("entity-")) {
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
  if (route.phase.startsWith("Preset-") || /^(?:agent|squad)-/u.test(route.id))
    return parsePreset(route, args, rootDir, repoId, json, inputs);
  return undefined;
}

const peopleRequiredInputs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "people-add": ["--person-id", "--display-name", "--role", "--command-class"],
  "people-set-role": ["--person-id", "--role", "--command-class"],
  "people-bind": ["--actor", "--role", "--target"],
  "people-delegate": ["--token-id", "--runtime-session-id", "--action", "--expires-at"],
  "people-revoke-delegation": ["--token-id"],
  "people-remove": ["--person-id"],
});

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
    directFields = Object.keys(action).filter((field) => field !== "kind" && field !== "fromFile");
  if (fromFile)
    return directFields.length === 0
      ? projected
      : rejected(
          "invalid_field",
          "Use --from-file <packet.json> by itself, or provide the complete direct flag set.",
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
