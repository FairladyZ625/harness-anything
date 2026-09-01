#!/usr/bin/env node

/**
 * Projects the machine half of the GUI entity explainer catalog from the kernel
 * entity kind registry.
 *
 * The catalog in packages/gui/src/renderer/entity-docs.ts carries two kinds of
 * content. The prose half — what an entity is, what each field means, where to
 * see it — is written by a person and is the whole point of the surface. The
 * machine half — schema id, ref template, status vocabulary, available actions —
 * is a mirror of `explainEntityKind` and has no business being retyped by hand:
 * every kernel change silently ages it, and the renderer cannot import kernel
 * directly because kernel pulls in node built-ins.
 *
 * So the machine half is generated into a marked region and committed. Run this
 * script to refresh it; `--check` fails when the committed region no longer
 * matches the kernel, which is what makes the staleness visible in CI instead of
 * in front of a user.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { relationTypes } from "../packages/kernel/src/index.ts";
// Deep import on purpose: the kind registry and its explainer are deliberately kept off the
// public bucket, and hand-listing the kinds here would reintroduce the very drift this
// generator removes. Every kernel contract test reaches for them the same way. This is
// build-time tooling, not shipped renderer code.
import { entityKindContracts, explainEntityKind } from "../packages/kernel/src/domain/entity-kind-registry.ts";

const root = path.resolve(import.meta.dirname, "..");
const catalogTarget = path.join(root, "packages/gui/src/renderer/entity-docs.ts");
const catalogMarkers = {
  start: "// entity-kind-contract:generated:start",
  end: "// entity-kind-contract:generated:end",
};

/** Registered kernel kinds, in a stable order so the generated region is diff-quiet. */
export function projectedEntityKinds() {
  return [...entityKindContracts.map(({ kind }) => kind)].sort();
}

export function projectEntityDocContract() {
  return Object.fromEntries(
    projectedEntityKinds().map((kind) => {
      const explanation = explainEntityKind(kind);
      return [
        kind,
        {
          schemaId: explanation.documentSchema.id,
          refTemplate: explanation.id.refTemplate,
          statuses: explanation.statusVocabulary,
          actions: explanation.transitions.available,
        },
      ];
    }),
  );
}

export async function renderEntityDocContract() {
  const literal = JSON.stringify(projectEntityDocContract(), null, 2),
    relationTypeLiteral = JSON.stringify([...relationTypes], null, 2),
    source = [
      catalogMarkers.start,
      "/** Kernel-derived half of the catalog. Regenerate with tools/generate-entity-doc-contract.mjs. */",
      "export const KERNEL_ENTITY_CONTRACT = Object.freeze(",
      `  ${literal} as const satisfies Readonly<Record<string, EntityKernelContract>>,`,
      ");",
      "",
      "/** Relation 的类型词表:kernel `relationTypes`,不是 statusVocabulary,所以单独投影。 */",
      `export const RELATION_TYPE_WORDS: readonly string[] = Object.freeze(${relationTypeLiteral});`,
      catalogMarkers.end,
    ].join("\n");
  return (await format(source, { parser: "typescript", printWidth: 120 })).trimEnd();
}

export function normalizeContractLineEndings(source) {
  return source.replaceAll("\r\n", "\n");
}

function generatedRegion(source, target) {
  const start = source.indexOf(catalogMarkers.start);
  const end = source.indexOf(catalogMarkers.end, start);
  if (start < 0 || end < 0) throw new Error(`Generated entity kind contract markers are missing in ${target}.`);
  return source.slice(start, end + catalogMarkers.end.length);
}

function replaceGeneratedRegion(target, rendered) {
  const source = readFileSync(target, "utf8");
  const current = generatedRegion(source, target);
  const start = source.indexOf(current);
  writeFileSync(target, `${source.slice(0, start)}${rendered}${source.slice(start + current.length)}`);
}

export async function generateEntityDocContract() {
  replaceGeneratedRegion(catalogTarget, await renderEntityDocContract());
}

export async function checkEntityDocContract() {
  const source = readFileSync(catalogTarget, "utf8"),
    current = generatedRegion(source, catalogTarget),
    expected = await renderEntityDocContract();
  if (normalizeContractLineEndings(current) !== normalizeContractLineEndings(expected)) {
    throw new Error("Generated entity kind contract is stale; run tools/generate-entity-doc-contract.mjs.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--check")) await checkEntityDocContract();
  else await generateEntityDocContract();
}
