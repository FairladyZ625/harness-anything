#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import {
  directObjectStringProperties,
  exitCodeFor,
  findVariable,
  lineNumber,
  loadActionCoverageSnapshot,
  loadStateAuthoritySnapshot,
  parseCommonArgs,
  parseTypeScript,
} from "./ontology-gate-lib.mjs";

const entityRefPath = "packages/kernel/src/domain/entity-ref.ts";
const declarationPath = "packages/kernel/src/domain/action-declaration.ts";

export function auditKindAuthority(rootDir = process.cwd()) {
  // The registry is evaluated, not parsed: a factory-made contract is as real as a literal row.
  const snapshot = loadActionCoverageSnapshot(rootDir);
  const canonicalKinds = [...new Set(snapshot.kinds)].sort();
  const coverage = actionCoverage(snapshot);
  const authority = stateAuthorityCoverage(rootDir);
  const tables = [];

  const refSource = parseTypeScript(rootDir, entityRefPath);
  const authorities = findVariable(refSource, "entityKindRefAuthorities");
  if (authorities?.initializer) {
    tables.push({
      file: entityRefPath,
      line: lineNumber(refSource, authorities.getStart(refSource)),
      name: "entityKindRefAuthorities",
      kinds: [
        ...new Set(directObjectStringProperties(authorities.initializer, "kind").map(({ value }) => value)),
      ].sort(),
    });
  }
  const refKind = findTypeAlias(refSource, "EntityRefKind");
  const specialKinds = refKind ? [...new Set(stringLiterals(refKind.type))].sort() : [];
  if (refKind && specialKinds.length) {
    tables.push({
      file: entityRefPath,
      line: lineNumber(refSource, refKind.getStart(refSource)),
      name: "EntityRefKind special cases",
      kinds: specialKinds,
    });
  }

  return {
    canonicalKinds,
    coverage,
    authority,
    tables,
    findings: [...coverage.findings, ...authority.findings, ...tables.map(formatTable)],
  };
}

const STORE_ROLES = new Set(["authority", "replica", "projection", "spool", "operational"]);
const STORE_RESIDENCIES = new Set(["canonical", "runtime-local", "host-local"]);
const MEDIUM_KINDS = new Set([
  "journal",
  "sqlite-table",
  "postgres-table",
  "canonical-event",
  "shared-cache",
  "host-operational",
]);
const STORE_FIELDS = new Set([
  "id",
  "owner",
  "role",
  "residency",
  "medium",
  "vocabulary",
  "source",
  "freshness",
  "invalidation",
  "reader",
  "purpose",
  "writerApi",
  "projection",
]);
const HOST_OPERATIONAL = Object.freeze({
  "process-lock": { recordSchema: "host-process-lock/v1", writerApi: "withHostProcessLock" },
  "diagnostic-log": { recordSchema: "host-diagnostic-line/v1", writerApi: "appendHostDiagnostic" },
});
const FRESHNESS_CURSORS = new Set(["revision", "watermark", "generation", "none"]);
const INVALIDATIONS = new Set(["event-push", "fence-on-read", "rebuild-on-start"]);

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function stateAuthorityCoverage(rootDir) {
  const snapshot = loadStateAuthoritySnapshot(rootDir);
  const kinds = new Set(snapshot.kinds);
  const findings = [];
  for (const contract of snapshot.stateStores ?? [])
    if (!Array.isArray(contract.stateStores))
      findings.push(`${contract.kind}: declare stateStores: [] in EntityKindContract`);
  const stores = (snapshot.stateStores ?? []).flatMap(({ kind, stateStores }) =>
    (Array.isArray(stateStores) ? stateStores : []).map((store) => ({ ...store, owner: kind })),
  );
  const byId = new Map();
  for (const store of stores) {
    if (!store || typeof store !== "object") {
      findings.push("stateStores contains a non-object declaration");
      continue;
    }
    if (typeof store.id !== "string" || store.id.length === 0) findings.push("state store id must be non-empty");
    else if (byId.has(store.id)) findings.push(`state store id ${store.id} is declared by multiple kinds`);
    else byId.set(store.id, store);
    if (!STORE_ROLES.has(store.role)) findings.push(`${store.id ?? "<unknown>"}: state store role is invalid`);
    if (!STORE_RESIDENCIES.has(store.residency))
      findings.push(`${store.id ?? "<unknown>"}: state store residency is invalid`);
    for (const key of Object.keys(store))
      if (!STORE_FIELDS.has(key)) findings.push(`${store.id ?? "<unknown>"}: unsupported state store field ${key}`);
    if (!Array.isArray(store.vocabulary) || store.vocabulary.some((entry) => typeof entry !== "string"))
      findings.push(`${store.id ?? "<unknown>"}: vocabulary must be a string array`);
    if (
      !store.medium ||
      typeof store.medium !== "object" ||
      Array.isArray(store.medium) ||
      !MEDIUM_KINDS.has(store.medium.kind)
    )
      findings.push(`${store.id ?? "<unknown>"}: state store medium is invalid`);
    else {
      const allowedMediumFields = {
        journal: new Set(["kind", "recordSchema"]),
        "sqlite-table": new Set(["kind", "table"]),
        "postgres-table": new Set(["kind", "table"]),
        "canonical-event": new Set(["kind", "schema", "types", "writers", "payloadField"]),
        "shared-cache": new Set(["kind", "adapter"]),
        "host-operational": new Set(["kind", "recordSchema", "purpose"]),
      }[store.medium.kind];
      for (const key of Object.keys(store.medium))
        if (!allowedMediumFields.has(key)) findings.push(`${store.id}: unsupported medium field ${key}`);
    }
    if (store.medium?.kind === "canonical-event") {
      if (
        !nonEmptyString(store.medium.schema) ||
        !Array.isArray(store.medium.types) ||
        store.medium.types.length === 0 ||
        store.medium.types.some((type) => !nonEmptyString(type))
      )
        findings.push(`${store.id}: canonical-event medium requires schema and types`);
      if (
        store.role === "authority" &&
        (!Array.isArray(store.medium.writers) ||
          store.medium.writers.length === 0 ||
          store.medium.writers.some((writer) => !nonEmptyString(writer)))
      )
        findings.push(`${store.id}: canonical-event medium requires writers`);
      if (store.role !== "authority" && store.role !== "projection")
        findings.push(`${store.id}: canonical-event medium must be authority or projection`);
      if (
        store.role === "projection" &&
        (!nonEmptyString(store.medium.payloadField) || Object.hasOwn(store.medium, "writers"))
      )
        findings.push(`${store.id}: canonical-event projection requires payloadField and cannot declare writers`);
      if (store.role === "authority" && Object.hasOwn(store.medium, "payloadField"))
        findings.push(`${store.id}: canonical-event authority cannot declare payloadField`);
    }
    if (store.medium?.kind === "journal" && !nonEmptyString(store.medium.recordSchema))
      findings.push(`${store.id}: journal medium requires recordSchema`);
    if (["sqlite-table", "postgres-table"].includes(store.medium?.kind) && !nonEmptyString(store.medium.table))
      findings.push(`${store.id}: ${store.medium.kind} medium requires table`);
    if (store.medium?.kind === "shared-cache") {
      if (!/^[^#\s]+#[^#\s]+$/u.test(String(store.medium.adapter ?? "")))
        findings.push(`${store.id}: shared-cache medium requires an exact module#export adapter`);
      if (!new Set(["replica", "projection"]).has(store.role))
        findings.push(`${store.id}: shared-cache must be a replica or projection`);
    }
    if (store.role === "replica" || store.role === "projection") {
      if (
        !store.source ||
        typeof store.source !== "object" ||
        Array.isArray(store.source) ||
        !nonEmptyString(store.source.kind) ||
        !nonEmptyString(store.source.store)
      )
        findings.push(`${store.id}: ${store.role} requires source kind/store`);
      if (
        !store.freshness ||
        typeof store.freshness !== "object" ||
        Array.isArray(store.freshness) ||
        !FRESHNESS_CURSORS.has(store.freshness.cursor)
      )
        findings.push(`${store.id}: ${store.role} requires freshness cursor`);
      if (
        typeof store.invalidation !== "string" ||
        (!INVALIDATIONS.has(store.invalidation) && !/^ttl:[1-9]\d*$/u.test(store.invalidation))
      )
        findings.push(`${store.id}: ${store.role} requires a supported invalidation policy`);
      if (
        store.freshness?.cursor === "none" &&
        store.invalidation !== "rebuild-on-start" &&
        !/^ttl:[1-9]\d*$/u.test(String(store.invalidation))
      )
        findings.push(`${store.id}: freshness none requires rebuild-on-start or ttl invalidation`);
      if (!nonEmptyString(store.reader)) findings.push(`${store.id}: ${store.role} requires reader`);
    }
    if (Object.hasOwn(store, "source") && store.role !== "replica" && store.role !== "projection")
      findings.push(`${store.id}: source is only valid for replica or projection stores`);
    if (
      (Object.hasOwn(store, "freshness") || Object.hasOwn(store, "invalidation") || Object.hasOwn(store, "reader")) &&
      store.role !== "replica" &&
      store.role !== "projection"
    )
      findings.push(`${store.id}: freshness, invalidation, and reader are only valid for replica or projection stores`);
    if (Object.hasOwn(store, "projection")) {
      const projection = store.projection;
      if (
        store.role !== "projection" ||
        !projection ||
        typeof projection !== "object" ||
        Array.isArray(projection) ||
        store.medium?.kind !== "canonical-event" ||
        !nonEmptyString(projection.payloadField) ||
        !Array.isArray(projection.types) ||
        projection.types.length === 0 ||
        projection.types.some((type) => !nonEmptyString(type)) ||
        projection.payloadField !== store.medium.payloadField ||
        JSON.stringify(projection.types) !== JSON.stringify(store.medium.types)
      )
        findings.push(`${store.id}: canonical-event projection must match its medium payloadField and types`);
    }
    if (store.role === "operational") validateOperationalStore(store, kinds, findings);
    else if (store.owner === "host") findings.push(`${store.id}: host stores must use the operational role`);
    if ((Object.hasOwn(store, "purpose") || Object.hasOwn(store, "writerApi")) && store.role !== "operational")
      findings.push(`${store.id}: purpose and writerApi are only valid for operational stores`);
  }
  for (const store of stores) {
    if ((store.role !== "replica" && store.role !== "projection") || !store.source) continue;
    if (!kinds.has(store.source.kind)) findings.push(`${store.id}: source kind ${store.source.kind} does not exist`);
    const source = byId.get(store.source.store);
    if (!source) findings.push(`${store.id}: source store ${store.source.store} does not exist`);
    else if (source.role !== "authority")
      findings.push(`${store.id}: source store ${store.source.store} must be authority`);
    else if (source.owner !== store.source.kind)
      findings.push(
        `${store.id}: source store ${store.source.store} is owned by ${source.owner}, not ${store.source.kind}`,
      );
  }
  for (const event of snapshot.canonicalEvents ?? []) {
    if (typeof event.schema !== "string") {
      findings.push("canonical event schema is missing schema");
      continue;
    }
    if (typeof event.owner !== "string" || event.owner.length === 0) {
      findings.push(`${event.schema}: canonical event schema has no owner`);
      continue;
    }
    if (!kinds.has(event.owner)) findings.push(`${event.schema}: owner kind ${event.owner} does not exist`);
    const owned = stores.some(
      (store) =>
        store.owner === event.owner && store.medium?.kind === "canonical-event" && store.medium.schema === event.schema,
    );
    if (!owned) findings.push(`${event.schema}: owner ${event.owner} has no matching canonical-event state store`);
  }
  const canonicalSchemas = new Set();
  for (const event of snapshot.canonicalEvents ?? []) {
    if (canonicalSchemas.has(event.schema))
      findings.push(`${event.schema}: canonical event schema is registered more than once`);
    canonicalSchemas.add(event.schema);
  }
  const hostStores = stores.filter(({ owner }) => owner === "host");
  const expectedHostStores = Object.keys(HOST_OPERATIONAL)
    .map((purpose) => `host.${purpose}`)
    .sort();
  const actualHostStores = hostStores.map(({ id }) => id).sort();
  if (!kinds.has("host")) findings.push("entityKindContracts must register the host aggregate");
  if (JSON.stringify(actualHostStores) !== JSON.stringify(expectedHostStores))
    findings.push(`host aggregate must declare exactly ${expectedHostStores.join(" and ")}`);
  return { findings, stores, canonicalEvents: snapshot.canonicalEvents ?? [] };
}

function validateOperationalStore(store, kinds, findings) {
  if (store.owner !== "host" || !kinds.has("host")) {
    findings.push(`${store.id}: operational stores are reserved for the host kind`);
    return;
  }
  const expected = HOST_OPERATIONAL[store.purpose];
  const allowed = new Set(["id", "owner", "role", "purpose", "residency", "medium", "vocabulary", "writerApi"]);
  if (!expected || store.id !== `host.${store.purpose}` || store.residency !== "host-local") {
    findings.push(`${store.id}: unknown host operational purpose`);
    return;
  }
  if ([...Object.keys(store)].some((key) => !allowed.has(key)))
    findings.push(`${store.id}: host operational store has unsupported fields`);
  if (
    store.medium?.kind !== "host-operational" ||
    store.medium.recordSchema !== expected.recordSchema ||
    store.medium.purpose !== store.purpose ||
    store.writerApi !== expected.writerApi
  )
    findings.push(`${store.id}: host operational schema/helper does not match its fixed purpose`);
}

/**
 * Two independent anchors meet at the ActionDeclaration: every durable effect the registry can
 * execute and every non-read protocol ingress must name a declared action, and every declared
 * executable action must keep a protocol ingress. The only non-literal mappings are typed by the
 * kernel itself: a compiled event belongs to its policy action, and the artifact CRUD ingresses
 * resolve to a compiled Artifact kind's own scope at runtime.
 */
export function actionCoverage(snapshot) {
  const declared = new Map(snapshot.declarations.map((entry) => [entry.kind, entry])),
    generated = new Set(snapshot.artifactIngress),
    ingress = new Set(snapshot.ingress.map((entry) => entry.kind)),
    findings = [],
    exceptions = [];
  for (const effect of snapshot.effects) {
    const label = `${effect.kind}/${effect.action}`;
    if (declared.has(effect.ingress) || generated.has(effect.ingress)) {
      if (!ingress.has(effect.ingress))
        findings.push(`${label}: durable effect ${effect.ingress} has no protocol ingress`);
    } else if (effect.implementation === "compiled-event" && declared.has(effect.policyAction))
      // An event the runtime emits while executing a declared action is that action's effect.
      exceptions.push(`${label}: compiled event emitted under declared action ${effect.policyAction}`);
    else findings.push(`${label}: durable effect ${effect.ingress} has no ActionDeclaration`);
  }
  for (const kind of [...ingress].sort()) {
    if (declared.has(kind)) continue;
    if (generated.has(kind))
      exceptions.push(`${kind}: generated Artifact ingress (${declarationPath} artifactActionIngressKinds)`);
    else findings.push(`${kind}: protocol ingress has no ActionDeclaration`);
  }
  for (const entry of snapshot.declarations)
    if (entry.executionClass !== "repo-read" && !ingress.has(entry.kind))
      findings.push(
        `${entry.kind}: declared ${entry.residency} ${entry.executionClass} action has no protocol ingress`,
      );
  return { findings, exceptions };
}

function findTypeAlias(sourceFile, name) {
  return sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
}

function stringLiterals(node) {
  if (ts.isUnionTypeNode(node)) return node.types.flatMap(stringLiterals);
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal) ? [node.literal.text] : [];
}

function formatTable(table) {
  return `${table.file}:${table.line} ${table.name} = [${table.kinds.join(", ")}]`;
}

export function main(argv = process.argv.slice(2)) {
  try {
    const { rootDir, mode } = parseCommonArgs(argv);
    const result = auditKindAuthority(rootDir);
    console.log(`G0-1 ontology-kind-authority: ${mode}`);
    console.log(`canonical registry kinds (${result.canonicalKinds.length}): ${result.canonicalKinds.join(", ")}`);
    console.log(`typed action coverage exceptions (${result.coverage.exceptions.length}):`);
    for (const exception of result.coverage.exceptions) console.log(`- ${exception}`);
    console.log(`action coverage findings (${result.coverage.findings.length}):`);
    for (const finding of result.coverage.findings) console.log(`- ${finding}`);
    console.log(`state-store authority findings (${result.authority.findings.length}):`);
    for (const finding of result.authority.findings) console.log(`- ${finding}`);
    console.log(`registry-external kind tables (${result.tables.length}):`);
    for (const finding of result.findings) console.log(`- ${finding}`);
    return exitCodeFor(mode, result.findings.length);
  } catch (error) {
    console.error(`G0-1 ontology-kind-authority: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
