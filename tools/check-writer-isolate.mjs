import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeModuleClosure } from "./analyze-module-closure.mjs";

export const writerEntries = [
  { mode: "sqlite", entry: "packages/daemon/src/writer-cell/repo-writer-worker.ts" },
  { mode: "pg", entry: "packages/daemon/src/writer-cell/repo-writer-worker-pg.ts" },
];
const forbiddenPackages = /(?:^|\/)node_modules\/(?:node-pty|ws|undici|fast-check|pure-rand)(?:\/|$)/u;
const forbiddenWorkspace =
  /(?:^|\/)packages\/(?:cli|gui|authorization-keycloak)\/|packages\/application\/src\/queries\/|local-version-control-system|packages\/daemon\/src\/(?:runtime-engine|fleet-sync|daemon-host)\//u;
const forbiddenBuiltin = new Set([
  "node:child_process",
  "node:http",
  "node:https",
  "node:http2",
  "node:net",
  "node:tls",
  "node:dgram",
  "node:dns",
]);
const pgTransportBuiltin = new Set(["node:net", "node:tls", "node:dns"]);

/** Removing only this edge proves that every PG network path passes through the approved DB adapter. */
function withoutPgTransport(analysis) {
  const edges = new Map();
  for (const edge of analysis.edges) {
    if (edge.from === "packages/storage/src/postgres/transaction.ts" && edge.specifier === "pg") continue;
    const next = edges.get(edge.from) ?? [];
    next.push(edge.to);
    edges.set(edge.from, next);
  }
  const reachable = new Set([analysis.entry]),
    queue = [analysis.entry];
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]) ?? [])
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
  }
  return reachable;
}

// dec_04A9211B073F29F0FC1E1CA573 CH2: static capability lock, separate from the runtime module ratchet.
export function checkWriterIsolate(root = process.cwd(), entries = writerEntries) {
  const violations = [],
    samples = [];
  for (const { mode, entry } of entries) {
    const analysis = analyzeModuleClosure({ root, entry }),
      unprivileged = mode === "pg" ? withoutPgTransport(analysis) : null,
      daemonModules = analysis.modules.filter((m) => m.path.startsWith("packages/daemon/")).length;
    samples.push({ mode, entry, modules: analysis.moduleCount, daemonModules });
    if (daemonModules > 60) violations.push(`${entry}: daemon closure ${daemonModules} exceeds 60`);
    for (const module of analysis.modules) {
      const target = module.path;
      if (forbiddenPackages.test(target) || forbiddenWorkspace.test(target))
        violations.push(`${entry}: forbidden module ${target}`);
      if (
        mode === "sqlite" &&
        /(?:node_modules\/(?:pg(?:-[^/]+)?|@electric-sql\/pglite)\/|packages\/storage\/src\/(?:pg|postgres|pglite)\/)/u.test(
          target,
        )
      )
        violations.push(`${entry}: SQLite writer loads an external database driver: ${target}`);
      const filename = path.resolve(root, target);
      if (
        target.startsWith("packages/daemon/") &&
        /\b(?:syncCapability|asyncCapability)\s*\(|harness-repo-writer-capability-call/u.test(
          readFileSync(filename, "utf8"),
        )
      )
        violations.push(`${entry}: forbidden host capability bridge in ${target}`);
    }
    // Builtins are edges rather than source-bearing modules.
    for (const { to, from, specifier } of analysis.edges) {
      if (specifier === "effect" || specifier === "@harness-anything/kernel")
        violations.push(`${entry}: runtime root barrel ${specifier} in ${from}`);
      if (forbiddenBuiltin.has(to) && (mode !== "pg" || !pgTransportBuiltin.has(to) || unprivileged.has(to)))
        violations.push(`${entry}: forbidden process/network capability ${to}`);
    }
    for (const item of analysis.unresolvedImports) {
      if (
        mode === "pg" &&
        item.specifier === "pg-native" &&
        /node_modules\/pg\/lib\/native\/client\.js$/u.test(item.path)
      )
        continue;
      violations.push(`${entry}: unresolved import ${item.specifier} in ${item.path}`);
    }
  }
  return { ok: violations.length === 0, samples, violations: [...new Set(violations)] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkWriterIsolate();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
