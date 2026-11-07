import path from "node:path";
import type { SafePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { parseExplain } from "./thin-command-explain.ts";
import { parseGraph } from "./thin-command-graph.ts";
import { accepted, nonEmpty, readFlags, rejected } from "./thin-command-flags.ts";
import { parseProjected, projectFlags } from "./thin-command-projection.ts";
import type { ProtocolCommand, ThinCliInputDirectory, ThinParseResult } from "./thin-command-types.ts";

export function parseRoutedSpecial(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult | undefined {
  if (route.id === "access-password-change" || route.id === "access-password-reset") {
    const parsed = parseProjected(
      route.id,
      args.slice(route.path.length),
      rootDir,
      repoId,
      json,
      inputs,
      {},
      { operation: route.id },
      route.method,
    );
    if (!parsed.ok) return parsed;
    const { passwordFile, ...action } = parsed.command.action;
    return {
      ...parsed,
      command: {
        ...parsed.command,
        action: {
          ...action,
          ...(typeof passwordFile === "string" ? { passwordFile: path.resolve(rootDir, passwordFile) } : {}),
        },
      },
    };
  }
  if (route.id === "agenda") {
    const f = readFlags(route.id, args.slice(1), inputs);
    return f.ok
      ? accepted(rootDir, repoId, json, { kind: "agenda", ...projectFlags(route.id, f) }, route.method)
      : rejected(f.code, f.nextAction, json);
  }
  if (route.id === "migrate-storage")
    return parseProjected(route.id, args.slice(2), rootDir, repoId, json, inputs, {}, {}, route.method);
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
  if (route.id === "assignment-migrate") {
    const f = readFlags(route.id, args.slice(2), inputs);
    return f.ok
      ? accepted(
          rootDir,
          repoId,
          json,
          { kind: "assignment-migrate", ...(f.booleans.has("--dry-run") ? { dryRun: true } : {}) },
          route.method,
        )
      : rejected(f.code, f.nextAction, json);
  }
  if (route.id === "vertical-declaration-migrate")
    return args.length === 2
      ? accepted(rootDir, repoId, json, { kind: "vertical-declaration-migrate" })
      : rejected("unknown_field", "ha migrate vertical-declaration takes no options.", json);
  if (route.id === "explain" || route.id === "graph")
    return route.id === "explain"
      ? parseExplain(args, rootDir, repoId, json, route.method)
      : parseGraph(route, args, rootDir, repoId, json, inputs);
  return undefined;
}

export function parseEntityAssignment(
  route: ProtocolCommand,
  args: readonly string[],
  rootDir: SafePath,
  repoId: string | undefined,
  json: boolean,
  inputs: ThinCliInputDirectory,
): ThinParseResult {
  const kind = route.path[0],
    id = args[2];
  if (!nonEmpty(id) || id.startsWith("--"))
    return rejected(
      "missing_field",
      `Use ha ${kind} ${route.id.endsWith("-assign") ? "assign" : "unassign"} <${kind}-id>.`,
      json,
    );
  return parseProjected(
    route.id,
    args.slice(3),
    rootDir,
    repoId,
    json,
    inputs,
    { [`${kind}Id`]: id },
    {},
    route.method,
  );
}
