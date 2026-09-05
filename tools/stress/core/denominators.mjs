/**
 * Frozen S1 denominator interface for S2-S4.
 *
 * generateCoverageDenominators({ repoRoot, mappedIds }) derives writable
 * command routes and canonical event schemas from their runtime registries,
 * then scans production source for claim and durable-boundary call sites. The
 * returned missing/unmapped set is computed from that source-derived list.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoots = ["packages/kernel/src", "packages/daemon/src"];

export async function generateCoverageDenominators({ repoRoot, mappedIds = [] }) {
  const commandModule = await import(
    pathToFileURL(path.join(repoRoot, "packages/daemon/src/protocol/daemon-protocol-commands.ts")).href
  );
  const eventModule = await import(
    pathToFileURL(path.join(repoRoot, "packages/kernel/src/domain/doc-sync-canonical-events.ts")).href
  );
  const commandRoutes = commandModule.thinCliCommands
    .filter((command) => command.commandClass !== "repo-read")
    .map((command) => ({
      id: `command:${command.id}`,
      kind: "command-route",
      commandId: command.id,
      commandClass: command.commandClass,
      method: command.method,
      path: command.path.join(" "),
      source: "packages/daemon/src/protocol/daemon-protocol-commands.ts#thinCliCommands",
    }));
  const eventSchemas = eventModule.canonicalEventSchemas.map((registration) => ({
    id: `event-schema:${registration.schema}`,
    kind: "event-schema",
    schema: registration.schema,
    source: "packages/kernel/src/domain/doc-sync-canonical-events.ts#canonicalEventSchemas",
  }));
  const sourceFiles = sourceRoots.flatMap((root) => walk(path.join(repoRoot, root), repoRoot));
  const claimPoints = scan(sourceFiles, repoRoot, "claim-point", [
    ["claimWriter", /\bclaimWriter\b/u],
    ["claimFence", /\bclaimFence\b/u],
    ["writerEpochFence", /\bwriterEpochFence\b/u],
    ["writer_lease", /\bwriter_lease\b/u],
    ["occurrenceId", /\boccurrenceId\b/u],
  ]);
  const durableBoundaries = scan(sourceFiles, repoRoot, "durable-boundary", [
    ["fsync", /\bfsyncSync\s*\(/u],
    ["fdatasync", /\bfdatasyncSync\s*\(/u],
    ["commit", /["'`]COMMIT(?:;|["'`])/u],
    ["rename", /\brenameSync\s*\(/u],
    ["checkpoint", /\bcheckpoint(?:Cut)?\s*\(/u],
    ["ref-publish", /\b(?:updateRef|publishRef|commitRef)\s*\(/u],
    ["gc", /\b(?:garbageCollect|collectGarbage|runGc)\s*\(/u],
  ]);
  const required = [...commandRoutes, ...eventSchemas, ...claimPoints, ...durableBoundaries].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const requiredIds = new Set(required.map(({ id }) => id));
  const hit = [...new Set(mappedIds)].filter((id) => requiredIds.has(id)).sort();
  const missing = required.map(({ id }) => id).filter((id) => !hit.includes(id));
  const categories = Object.fromEntries(
    ["command-route", "event-schema", "claim-point", "durable-boundary"].map((kind) => [
      kind,
      required.filter((item) => item.kind === kind).length,
    ]),
  );
  const facets = {
    commandClasses: countBy(commandRoutes, "commandClass"),
    claimTerms: countBy(claimPoints, "boundary", [
      "claimWriter",
      "claimFence",
      "writerEpochFence",
      "writer_lease",
      "occurrenceId",
    ]),
    durableBoundaries: countBy(durableBoundaries, "boundary", [
      "fsync",
      "fdatasync",
      "commit",
      "rename",
      "checkpoint",
      "ref-publish",
      "gc",
    ]),
  };
  const digest = createHash("sha256").update(JSON.stringify(required)).digest("hex");
  return {
    schema: "sqlite-stress-denominators/v1",
    digest: `sha256:${digest}`,
    sources: [
      "packages/daemon/src/protocol/daemon-protocol-commands.ts#thinCliCommands",
      "packages/kernel/src/domain/doc-sync-canonical-events.ts#canonicalEventSchemas",
      ...sourceRoots,
    ],
    categories,
    facets,
    required,
    hit,
    missing,
    unmapped: missing,
  };
}

function countBy(items, field, expected = []) {
  const counts = Object.fromEntries(expected.map((name) => [name, 0]));
  for (const item of items) counts[item[field]] = (counts[item[field]] ?? 0) + 1;
  return counts;
}

function walk(directory, repoRoot) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(target, repoRoot));
    else if (entry.isFile() && /\.(?:mjs|js|ts)$/u.test(entry.name)) files.push(path.relative(repoRoot, target));
  }
  return files.sort();
}

function scan(files, repoRoot, kind, patterns) {
  const matches = [];
  for (const file of files) {
    const lines = readFileSync(path.join(repoRoot, file), "utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const [name, pattern] of patterns) {
        if (!pattern.test(line)) continue;
        matches.push({
          id: `${kind}:${name}:${file}:${index + 1}`,
          kind,
          boundary: name,
          source: `${file}:${index + 1}`,
        });
      }
    }
  }
  return matches;
}
