import type { SafePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { parseDecision } from "./thin-command-decision.ts";
import { parseDoc } from "./thin-command-doc.ts";
import { parseFact } from "./thin-command-fact.ts";
import {
  accepted,
  nonEmpty,
  readFlags,
  rejected,
} from "./thin-command-flags.ts";
import { parsePreset } from "./thin-command-preset.ts";
import { parseProjected, projectFlags } from "./thin-command-projection.ts";
import { parseRuntimeInstance } from "./thin-command-runtime-instance.ts";
import { parseRuntime } from "./thin-command-runtime.ts";
import type {
  ProtocolCommand,
  ThinCliInputDirectory,
  ThinParseResult,
} from "./thin-command-types.ts";

export function parseRouted(
  route: ProtocolCommand | undefined,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | undefined {
  if (route?.id === "repo-bootstrap") {
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
  if (route?.id === "agenda") {
    const f = readFlags(route.id, args.slice(1), inputs);
    return f.ok
      ? accepted(
          rootDir,
          repoId,
          json,
          { kind: "agenda", ...projectFlags(route.id, f) },
          route.method,
        )
      : rejected(f.code, f.nextAction, json);
  }
  if (route?.id === "migrate-import") {
    const f = readFlags(route.id, args.slice(2), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, {
          kind: "migrate-import",
          sourceRoots: f.many.get("--source") ?? [],
          ...(f.many.get("--resolve")?.length
            ? { resolutions: f.many.get("--resolve") }
            : {}),
          ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}),
        })
      : rejected(f.code, f.nextAction, json);
  }
  if (route?.id === "ledger-migrate")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "ledger-migrate" })
      : rejected("unknown_field", "ha ledger migrate takes no options.", json);
  if (route?.id.startsWith("runtime-instance-"))
    return parseRuntimeInstance(route, args, rootDir, repoId, json, inputs);
  if (route?.id.startsWith("runtime-"))
    return parseRuntime(route, args, rootDir, repoId, json, inputs);
  if (route?.id === "receipt-show" && nonEmpty(args[2]) && args.length === 3)
    return accepted(rootDir, repoId, json, {
      kind: "receipt-show",
      opId: args[2],
    });
  if (route?.id.startsWith("doc-"))
    return parseDoc(route.id, args, rootDir, repoId, json, inputs);
  if (route?.id.startsWith("fact-"))
    return parseFact(route.id, args, rootDir, repoId, json, inputs);
  if (route?.id.startsWith("decision-"))
    return parseDecision(route.id, args, rootDir, repoId, json, inputs);
  if (route?.id === "distill-candidate" || route?.id === "distill-promote")
    return parseProjected(
      route.id,
      args.slice(2),
      rootDir,
      repoId,
      json,
      inputs,
      {},
      route.id === "distill-promote"
        ? { confidence: "medium", memoryClass: "semantic" }
        : {},
    );
  if (route?.id === "relation-list")
    return parseProjected(
      route.id,
      args.slice(2),
      rootDir,
      repoId,
      json,
      inputs,
    );
  if (
    route &&
    (route.phase.startsWith("Preset-") || /^(?:agent|squad)-/u.test(route.id))
  )
    return parsePreset(route, args, rootDir, repoId, json, inputs);
  return undefined;
}
