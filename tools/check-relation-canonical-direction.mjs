#!/usr/bin/env node
/**
 * G-IRONLAW3 canonical-direction ratchet gate (blueprint 铁律三 · slice 4).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1 (add ratchet gates only —
 * existing violations tolerated, new ones refused).
 *
 * The gate judges the real kernel modules, not text:
 *   1. The canonical direction registry and the relation allowlist agree cell for
 *      cell (the allowlist is derived from the registry and must stay that way).
 *   2. Every reversed-direction pair keeps exactly one canonical writable side:
 *      fact→decision supports / fact→decision invalidated-by / task→task blocks
 *      stay refused. Retired stored edges are tolerated audit history; re-widening
 *      the write surface is refused.
 *   3. The single reverse query agrees with the canonical direction.
 *   4. No production source re-reads the retired invalidated-by alias.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const KERNEL_ALLOWLIST = "../packages/kernel/src/domain/entity-relation.ts";
const KERNEL_DIRECTION = "../packages/kernel/src/domain/relation-direction.ts";
const GUI_MIRROR = "../packages/gui/src/renderer/model/relation-direction.ts";
const ENDPOINT_KINDS = ["task", "decision", "fact"];
const RETIRED_REVERSE_TRIPLES = [
  { sourceKind: "fact", type: "supports", targetKind: "decision", mirrorOf: "decision --evidenced-by--> fact" },
  { sourceKind: "fact", type: "invalidated-by", targetKind: "decision", mirrorOf: "decision --refuted-by--> fact" },
  { sourceKind: "task", type: "blocks", targetKind: "task", mirrorOf: "task --depends-on--> task" }
];
const RETIRED_ALIAS_COMPARISON = /(?:===|!==|==|!=)\s*["']invalidated-by["']|\bcase\s+["']invalidated-by["']/u;
const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;

export function checkRegistryShape({ canonicalRelationDirections }, findings = []) {
  const seen = new Set();
  for (const [index, direction] of canonicalRelationDirections.entries()) {
    const cell = `${direction.sourceKind} --${direction.type}--> ${direction.targetKind}`;
    if (seen.has(cell)) findings.push(`canonicalRelationDirections: duplicate registry row ${cell}`);
    seen.add(cell);
    for (const field of ["type", "sourceKind", "targetKind", "reads", "registration"]) {
      if (typeof direction[field] !== "string" || direction[field].trim() === "") {
        findings.push(`canonicalRelationDirections[${index}]: ${field} must be a non-empty string`);
      }
    }
    if (direction.registration !== "ratified" && direction.registration !== "unregistered") {
      findings.push(`${cell}: registration must be "ratified" or "unregistered", got ${JSON.stringify(direction.registration)}`);
    }
    if (!ENDPOINT_KINDS.includes(direction.sourceKind) || !ENDPOINT_KINDS.includes(direction.targetKind)) {
      findings.push(`${cell}: endpoint kinds must be task/decision/fact`);
    }
  }
  if (canonicalRelationDirections.length === 0) findings.push("canonicalRelationDirections: registry is empty");
  return findings;
}

export function checkDirectionBijection({ canonicalRelationDirections, isAllowedRelationKindTriple, relationTypes }, findings = []) {
  const registered = new Set(canonicalRelationDirections.map((direction) => `${direction.sourceKind}|${direction.type}|${direction.targetKind}`));
  for (const sourceKind of ENDPOINT_KINDS) {
    for (const type of relationTypes) {
      for (const targetKind of ENDPOINT_KINDS) {
        const cell = `${sourceKind}|${type}|${targetKind}`;
        const allowed = isAllowedRelationKindTriple(sourceKind, type, targetKind);
        if (allowed !== registered.has(cell)) {
          findings.push(`${sourceKind} --${type}--> ${targetKind}: allowlist says ${allowed}, direction registry says ${registered.has(cell)}`);
        }
      }
    }
  }
  return findings;
}

export function checkRetiredReverseTriplesRefused({ canonicalRelationDirections, isAllowedRelationKindTriple }, findings = []) {
  for (const triple of RETIRED_REVERSE_TRIPLES) {
    if (isAllowedRelationKindTriple(triple.sourceKind, triple.type, triple.targetKind)) {
      findings.push(`${triple.sourceKind} --${triple.type}--> ${triple.targetKind} must stay unwritable: it is the retired mirror of ${triple.mirrorOf} (one canonical direction per semantic relation)`);
    }
  }
  for (const direction of canonicalRelationDirections) {
    const alias = direction.replacedReverseAlias;
    if (!alias) continue;
    if (isAllowedRelationKindTriple(direction.targetKind, alias, direction.sourceKind)) {
      findings.push(`${direction.targetKind} --${alias}--> ${direction.sourceKind} must stay unwritable: retired reverse alias of ${direction.sourceKind} --${direction.type}--> ${direction.targetKind}`);
    }
  }
  return findings;
}

export function checkReverseQueryAgreement({ canonicalRelationDirections, incomingRelations }, findings = []) {
  for (const direction of canonicalRelationDirections) {
    const source = `${direction.sourceKind}/probe-source`;
    const target = `${direction.targetKind}/probe-target`;
    const canonical = { source, target, type: direction.type };
    const reverse = { source: target, target: source, type: direction.type };
    const hits = incomingRelations(target, direction.type, [reverse, canonical]);
    if (hits.length !== 1 || hits[0] !== canonical) {
      findings.push(`incomingRelations must answer the reverse question for ${direction.sourceKind} --${direction.type}--> ${direction.targetKind}: expected [${source}], got ${JSON.stringify(hits.map((edge) => edge.source))}`);
    }
  }
  return findings;
}

export function checkGuiMirrorAgreement({ canonicalRelationDirections, incomingRelations }, guiIncomingRelations, findings = []) {
  // The renderer may not import kernel runtime values (window.harness bridge only), so
  // the GUI carries a mirror of the reverse query. Both must answer identically for
  // every registry verb; this check makes the mirror drift a gate failure, not a silent
  // second orientation.
  const kernelEdges = [], rendererEdges = [];
  for (const direction of canonicalRelationDirections) {
    const source = `${direction.sourceKind}/probe-source`, target = `${direction.targetKind}/probe-target`;
    kernelEdges.push({ source, target, type: direction.type }, { source: target, target: source, type: direction.type });
    rendererEdges.push({ from: source, to: target, kind: direction.type }, { from: target, to: source, kind: direction.type });
  }
  for (const direction of canonicalRelationDirections) {
    const target = `${direction.targetKind}/probe-target`;
    const kernelHits = incomingRelations(target, direction.type, kernelEdges).map((edge) => edge.source);
    const rendererHits = guiIncomingRelations(target, direction.type, rendererEdges).map((edge) => edge.from);
    if (JSON.stringify(kernelHits) !== JSON.stringify(rendererHits)) {
      findings.push(`renderer reverse-query mirror disagrees with the kernel for ${direction.type} at ${target}: kernel [${kernelHits}] vs renderer [${rendererHits}]`);
    }
  }
  return findings;
}

export function checkNoRetiredAliasReads(root = process.cwd(), findings = []) {
  for (const file of walk(path.join(root, "packages"))) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (isTestOrFixturePath(rel)) continue;
    if (RETIRED_ALIAS_COMPARISON.test(readFileSync(file, "utf8"))) {
      findings.push(`${rel}: reads or writes the retired invalidated-by alias; reverse questions must go through incomingRelations`);
    }
  }
  return findings;
}

async function main() {
  const allowlist = await import(pathToFileURL(path.resolve(import.meta.dirname, KERNEL_ALLOWLIST)).href);
  const direction = await import(pathToFileURL(path.resolve(import.meta.dirname, KERNEL_DIRECTION)).href);
  const guiMirror = await import(pathToFileURL(path.resolve(import.meta.dirname, GUI_MIRROR)).href);
  const modules = { ...allowlist, ...direction };
  const findings = [
    ...checkRegistryShape(modules),
    ...checkDirectionBijection(modules),
    ...checkRetiredReverseTriplesRefused(modules),
    ...checkReverseQueryAgreement(modules),
    ...checkGuiMirrorAgreement(modules, guiMirror.incomingRelations),
    ...checkNoRetiredAliasReads()
  ];
  if (findings.length > 0) {
    console.error("Canonical relation direction check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
  }
  console.log("Canonical relation direction check passed (registry, allowlist, and reverse query agree; retired mirrors refused).");
}

function walk(dir) {
  const files = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue;
      files.push(...walk(full));
    } else if (SOURCE_FILE.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

function isTestOrFixturePath(rel) {
  return /(?:^|\/)(?:__fixtures__|fixtures|test|tests|e2e)\//u.test(rel) || /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  await main();
}
