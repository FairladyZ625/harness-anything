#!/usr/bin/env node
/**
 * G-IRONLAW1 aggregate event construction ratchet (blueprint 铁律一).
 *
 * Authorization: dec_399F48E3547D831F1199F51E84 CH1 for the ratchet shape;
 * dec_499E4E98A3D4754132B3BCA1E6 CH1 for the schema→owner generalization.
 *
 * A construction site is any of:
 *   - an object literal carrying a registered canonical `schema` plus a `type`;
 *   - a call to an `*Envelope` helper whose event-type argument is declared by a
 *     registered store;
 *   - a bare `type` literal whose value (or owner-declared token prefix) belongs
 *     to a registered store.
 *
 * The schema resolves to its owner kind through `canonicalEventSchemas`. Sites in
 * one of that kind's `stateStores[].medium.writers` are the aggregate's own write
 * path. Construction outside those writers is refused without exemptions.
 *
 * authored-document-event/v1 is an aggregate-local family pending canonical
 * publication (dec_6B912A63D279A922FA1288536D CH2). Its constructor is owned by
 * the document aggregate; it receives the same writer-only check.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { listWorktreeFiles } from "./gates/git.mjs";
import { loadStateAuthoritySnapshot } from "./gates/ontology-gate-lib.mjs";

export const AUTHORED_DOCUMENT_EVENT_FAMILY = Object.freeze({
  schema: "authored-document-event/v1",
  owner: "document",
  writers: Object.freeze(["packages/kernel/src/domain/authored-document.ts"]),
  types: Object.freeze(["authored_document_registered", "authored_document_revised", "authored_document_retired"]),
});

const SOURCE_FILE = /\.(?:ts|tsx|mts|js|jsx|mjs)$/u;
const DYNAMIC_EVENT_TYPE = "<dynamic>";

/** Turn the evaluated kernel registry into the families this gate checks. */
export function aggregateEventFamiliesFromSnapshot(snapshot, legacyFamilies = [AUTHORED_DOCUMENT_EVENT_FAMILY]) {
  const storesByKind = new Map(
    (snapshot.stateStores ?? []).map(({ kind, stateStores }) => [kind, Array.isArray(stateStores) ? stateStores : []]),
  );
  const families = new Map();
  for (const { schema, owner } of snapshot.canonicalEvents ?? []) {
    const stores = (storesByKind.get(owner) ?? []).filter(
      (store) =>
        store?.role === "authority" &&
        store.medium?.kind === "canonical-event" &&
        store.medium.schema === schema &&
        Array.isArray(store.medium.writers) &&
        store.medium.writers.length > 0,
    );
    if (stores.length === 0)
      throw new Error(
        `canonical event schema ${schema} has no authority canonical-event state store with writers on kind ${owner}`,
      );
    const writers = [...new Set(stores.flatMap((store) => store.medium.writers))];
    const types = explicitTypes(stores);
    families.set(schema, Object.freeze({ schema, owner, writers: Object.freeze(writers), types }));
  }
  for (const family of legacyFamilies) {
    if (families.has(family.schema)) continue;
    families.set(
      family.schema,
      Object.freeze({
        schema: family.schema,
        owner: family.owner,
        writers: Object.freeze([...family.writers]),
        types: Object.freeze([...family.types]),
      }),
    );
  }
  return Object.freeze([...families.values()]);
}

/** A `"*"` medium means the store has not enumerated its event types yet. */
function explicitTypes(stores) {
  if (stores.some((store) => store.medium.types?.includes("*"))) return null;
  return Object.freeze([...new Set(stores.flatMap((store) => store.medium.types ?? []))]);
}

export function loadAggregateEventFamilies(root = process.cwd()) {
  return aggregateEventFamiliesFromSnapshot(loadStateAuthoritySnapshot(root));
}

export function scanAggregateEventConstructionSites(root, families) {
  if (!Array.isArray(families) || families.length === 0)
    throw new Error("Aggregate event construction: at least one registered event family is required");
  const schemaNames = new Set(families.map(({ schema }) => schema));
  const typeIndex = buildEventTypeIndex(families);
  const sites = [];
  const files = listWorktreeFiles(root, ["packages"]).filter(
    (rel) => SOURCE_FILE.test(rel) && /(?:^|\/)src\//u.test(rel) && !isTestOrFixturePath(rel),
  );
  if (files.length === 0)
    throw new Error("Aggregate event construction: required scan root packages has no source files");
  for (const rel of files) {
    const body = readFileSync(path.join(root, rel), "utf8"),
      source = ts.createSourceFile(rel, body, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const add = (node, schema, form, eventType) => {
      const point = source.getLineAndCharacterOfPosition(node.getStart(source));
      sites.push({ schema, path: rel, form, eventType, line: point.line + 1, column: point.character + 1 });
    };
    const visit = (node) => {
      // (1) schema+type object literal: the schema names the owning family directly.
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "schema" &&
        ts.isStringLiteralLike(node.initializer) &&
        schemaNames.has(node.initializer.text) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        const typeProperty = node.parent.properties.find((candidate) => propertyName(candidate.name) === "type");
        if (typeProperty) {
          if (ts.isPropertyAssignment(typeProperty) && ts.isStringLiteralLike(typeProperty.initializer))
            add(node, node.initializer.text, "literal-type", typeProperty.initializer.text);
          else add(node, node.initializer.text, "dynamic-event", DYNAMIC_EVENT_TYPE);
        }
      }
      // (2) bare type literal: attribute through the registered event-type vocabulary,
      // but never for an object that already names a (canonical or non-canonical) schema.
      if (
        ts.isPropertyAssignment(node) &&
        propertyName(node.name) === "type" &&
        ts.isStringLiteralLike(node.initializer) &&
        !hasSchemaProperty(node.parent)
      ) {
        const schema = typeIndex.schemaFor(node.initializer.text);
        if (schema) add(node, schema, "literal-type", node.initializer.text);
      }
      // (3) envelope helper call: the first string argument is the event type.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && /[Ee]nvelope$/u.test(node.expression.text)) {
        const eventType = node.arguments[1];
        if (eventType && ts.isStringLiteralLike(eventType)) {
          const schema = typeIndex.schemaFor(eventType.text);
          if (schema) add(eventType, schema, "envelope-call", eventType.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites;
}

export function checkAggregateEventConstructionSites(sites, { families }) {
  const findings = typeOwnershipFindings(families);
  const bySchema = new Map(families.map((family) => [family.schema, family]));
  const constructors = new Set();
  for (const site of sites) {
    const key = siteKey(site),
      family = bySchema.get(site.schema),
      location = locations([site]);
    if (!family) {
      findings.push(`${key}: schema does not resolve to a registered aggregate event family (${location})`);
      continue;
    }
    if (site.eventType !== DYNAMIC_EVENT_TYPE && family.types !== null && !family.types.includes(site.eventType))
      findings.push(`${key}: event type ${site.eventType} is not declared by schema ${site.schema} (${location})`);
    if (isWriterPath(site.path, family.writers)) {
      // An explicit catalog keeps its single-constructor rule after debt removal,
      // including authored-document's aggregate-local events. Wildcard families
      // have no per-type vocabulary to make this judgment against.
      const constructor = `${site.schema}|${site.form}|${site.eventType}`;
      if (family.types !== null && constructors.has(constructor))
        findings.push(`${key}: duplicate aggregate constructor; use the existing entry (${location})`);
      constructors.add(constructor);
    } else
      findings.push(
        `${key}: aggregate event construction is outside the declared writers of ${family.owner} ` +
          `for ${site.schema} (${location})`,
      );
  }
  return findings;
}

function typeOwnershipFindings(families) {
  const findings = [],
    owners = new Map();
  for (const family of families)
    for (const eventType of family.types ?? []) {
      const previous = owners.get(eventType);
      if (previous !== undefined && previous !== family.schema)
        findings.push(
          `event type ${eventType} is declared by both ${previous} and ${family.schema}; one type has one owner`,
        );
      owners.set(eventType, family.schema);
    }
  return findings;
}

const AMBIGUOUS_PREFIX = "<ambiguous-prefix>";

function buildEventTypeIndex(families) {
  const exact = new Map(),
    prefixes = new Map();
  for (const family of families) {
    for (const eventType of family.types ?? []) {
      exact.set(eventType, family.schema);
      const separator = eventType.indexOf("_");
      if (separator <= 0) continue;
      const prefix = eventType.slice(0, separator + 1),
        candidates = prefixes.get(prefix) ?? new Set();
      candidates.add(family.schema);
      prefixes.set(prefix, candidates);
    }
  }
  return {
    schemaFor(eventType) {
      const declared = exact.get(eventType);
      if (declared !== undefined) return declared;
      const separator = eventType.indexOf("_");
      if (separator <= 0) return null;
      const candidates = prefixes.get(eventType.slice(0, separator + 1));
      if (candidates === undefined) return null;
      return candidates.size === 1 ? [...candidates][0] : AMBIGUOUS_PREFIX;
    },
  };
}

function isWriterPath(rel, writers) {
  return writers.some((writer) => rel === writer || rel.startsWith(writer.endsWith("/") ? writer : `${writer}/`));
}

function hasSchemaProperty(node) {
  return (
    ts.isObjectLiteralExpression(node) && node.properties.some((property) => propertyName(property.name) === "schema")
  );
}

function siteKey(site) {
  return `${site.schema}|${site.path}|${site.form}|${site.eventType}`;
}

function locations(sites) {
  return sites.map((site) => `${site.path}:${site.line}:${site.column}`).join(", ");
}

function propertyName(node) {
  return node !== undefined && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : null;
}

function scriptKind(file) {
  return file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : file.endsWith(".js") || file.endsWith(".mjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
}

function isTestOrFixturePath(rel) {
  return (
    /(?:^|\/)(?:__fixtures__|fixtures|test|tests|e2e)\//u.test(rel) ||
    /\.(?:test|spec|vitest)\.[cm]?[jt]sx?$/u.test(rel)
  );
}

async function main() {
  const families = loadAggregateEventFamilies(),
    sites = scanAggregateEventConstructionSites(process.cwd(), families);
  const findings = checkAggregateEventConstructionSites(sites, { families });
  if (findings.length) {
    console.error("Aggregate event construction check failed:");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Aggregate event construction check passed (${sites.length} sites, no exemptions).`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
